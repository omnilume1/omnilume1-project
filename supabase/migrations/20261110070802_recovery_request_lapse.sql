-- Phase 01b (hostel roadmap): an unanswered recovery request lapses after
-- 7 days.
--
-- Before: any pending recovery request kept an expired recoverable room in
-- 'recovery-window' forever, so rooms whose requests nobody reviewed (and
-- their chats and files) were never destroyed.
--
-- After: a pending request holds the room only while it is less than 7 days
-- old. Once the room's own 7-day window has ended and no pending request is
-- younger than 7 days, the room is 'destroyed' and the daily cleanup deletes
-- it; its recovery requests go with it (ON DELETE CASCADE).
--
-- Requests can only be filed inside the room's own window
-- (can_request_room_recovery, unchanged), so the longest possible hold is
-- 14 days after expiry.
--
-- Replaced: room_lifecycle_state, list_recovery_review_queue (lapsed requests
-- are hidden) and review_recovery_request (a lapsed request is refused).
-- Signatures, return types and grants are unchanged. No row is modified.

CREATE OR REPLACE FUNCTION public.room_lifecycle_state(p_room_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  room_row public.rooms%ROWTYPE;
  room_locked boolean := false;
BEGIN
  SELECT r.*
  INTO room_row
  FROM public.rooms r
  WHERE r.id = p_room_id;

  IF NOT FOUND THEN
    RETURN 'destroyed';
  END IF;

  SELECT s.is_locked
  INTO room_locked
  FROM public.room_control_settings s
  WHERE s.room_id = p_room_id;
  room_locked := COALESCE(room_locked, false);

  IF room_row.scheduled_for IS NOT NULL AND room_row.scheduled_for > now() THEN
    RETURN 'scheduled';
  END IF;

  IF room_row.expiration_type = 'permanent' THEN
    IF room_row.deletion_scheduled_at IS NOT NULL AND room_row.deletion_scheduled_at <= now() THEN
      RETURN 'destroyed';
    END IF;
    RETURN CASE WHEN room_locked THEN 'locked' ELSE 'permanent' END;
  END IF;

  IF room_row.reopened_until IS NOT NULL AND room_row.reopened_until > now() THEN
    RETURN CASE WHEN room_locked THEN 'locked' ELSE 'reopened' END;
  END IF;

  IF room_row.expires_at IS NOT NULL AND room_row.expires_at > now() THEN
    RETURN CASE WHEN room_locked THEN 'locked' ELSE 'active' END;
  END IF;

  IF room_row.expiration_type = 'recoverable'
     AND room_row.expires_at IS NOT NULL
     AND (
       now() <= room_row.expires_at + interval '7 days'
       OR EXISTS (
         SELECT 1
         FROM public.recovery_requests rr
         WHERE rr.room_id = p_room_id
           AND rr.status = 'pending'
           AND rr.created_at > now() - interval '7 days'
       )
     ) THEN
    RETURN 'recovery-window';
  END IF;

  RETURN 'destroyed';
END;
$function$;

CREATE OR REPLACE FUNCTION public.list_recovery_review_queue()
 RETURNS TABLE(request_id uuid, room_id uuid, room_name text, room_expired_at timestamp with time zone, window_ends_at timestamp with time zone, requester_id uuid, requester_label text, requested_at timestamp with time zone, other_pending integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_site_owner(auth.uid()) THEN
    RAISE EXCEPTION 'Only a site owner can review recovery requests.' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    rr.id,
    r.id,
    r.name,
    r.expires_at,
    r.expires_at + interval '7 days',
    rr.requester_id,
    public.notification_user_label(rr.requester_id),
    rr.created_at,
    (SELECT count(*)::integer
     FROM public.recovery_requests other
     WHERE other.room_id = rr.room_id
       AND other.status = 'pending'
       AND other.created_at > now() - interval '7 days'
       AND other.id <> rr.id)
  FROM public.recovery_requests rr
  JOIN public.rooms r ON r.id = rr.room_id
  WHERE rr.status = 'pending'
    AND rr.created_at > now() - interval '7 days'
  ORDER BY rr.created_at ASC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.review_recovery_request(p_request_id uuid, p_decision text)
 RETURNS public.recovery_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  request_row public.recovery_requests;
  room_row public.rooms;
BEGIN
  IF auth.uid() IS NULL OR p_decision IS NULL OR p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Unauthorized recovery decision.' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_site_owner(auth.uid()) THEN
    RAISE EXCEPTION 'Only a site owner can review recovery requests.' USING ERRCODE = '42501';
  END IF;

  SELECT rr.* INTO request_row
  FROM public.recovery_requests rr
  WHERE rr.id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Recovery request not found.';
  END IF;

  IF request_row.status <> 'pending' THEN
    RAISE EXCEPTION 'This recovery request has already been reviewed.';
  END IF;

  IF request_row.created_at <= now() - interval '7 days' THEN
    RAISE EXCEPTION 'This recovery request lapsed after 7 days without a review.';
  END IF;

  SELECT r.* INTO room_row
  FROM public.rooms r
  WHERE r.id = request_row.room_id
  FOR UPDATE;

  IF NOT FOUND OR room_row.expiration_type <> 'recoverable' THEN
    RAISE EXCEPTION 'This room cannot be recovered.';
  END IF;

  IF NOT public.room_in_recovery_window(request_row.room_id) THEN
    RAISE EXCEPTION 'This room is no longer in its recovery window.';
  END IF;

  UPDATE public.recovery_requests
  SET status = p_decision,
      reviewed_at = now(),
      reviewed_by = auth.uid()
  WHERE id = p_request_id
  RETURNING * INTO request_row;

  IF p_decision = 'approved' THEN
    PERFORM set_config('app.omnilume_lifecycle_authorized', 'recovery_approval', true);
    UPDATE public.rooms
    SET reopened_until = now() + interval '7 days'
    WHERE id = request_row.room_id
      AND expiration_type = 'recoverable';

    -- Everyone else who asked for this room gets the same answer.
    UPDATE public.recovery_requests
    SET status = 'approved',
        reviewed_at = now(),
        reviewed_by = auth.uid()
    WHERE room_id = request_row.room_id
      AND status = 'pending'
      AND id <> request_row.id;
  END IF;

  RETURN request_row;
END;
$function$;

-- Grants stay exactly as before (CREATE OR REPLACE keeps them); restated so a
-- rebuild from this file alone matches production.
REVOKE ALL ON FUNCTION public.room_lifecycle_state(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_recovery_review_queue() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.review_recovery_request(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.room_lifecycle_state(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_recovery_review_queue() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.review_recovery_request(uuid, text) TO authenticated, service_role;
