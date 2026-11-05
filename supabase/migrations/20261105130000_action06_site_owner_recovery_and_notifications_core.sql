-- Action 06 completion (owner decisions 2026-11-05, master plan §9):
--
-- 1. Site owners. Only the platform's site owners review recovery requests;
--    room owners and admins lose that power. Seeded with the two owner
--    accounts that exist (fails if neither exists). No client can write the
--    table; a signed-in user can see only their own row.
-- 2. Recovery requests. Any approved (non-guest) member of an expired
--    recoverable room may request recovery inside its 7-day window, one
--    pending request per user per room (existing unique index). Irreversible
--    rooms are unrecoverable for everyone, site owners included. Approval
--    reopens the room for 7 days and answers every pending request for that
--    room; rejection answers only that request. A pending request keeps the
--    room out of cleanup and reviewable (room_lifecycle_state, unchanged).
-- 3. Notifications core. room_notifications gains typed rows, an actor, an
--    entity and a per-recipient dedupe key; all notices go through one
--    internal function. The old (room, recipient, type) unique index, which
--    allowed one notice of each type per room, is replaced by the dedupe key.
--    Site owners are notified of new requests; requesters of decisions.
-- 4. §9 permanent rooms. The owner can schedule deletion with a 7–14 day
--    grace period and cancel it; members are notified; after the grace
--    period the room is destroyed by the existing cleanup path.
--
-- Additive: new table, columns, functions and policies. Replaced: the
-- recovery request policies, the rooms recovery-window SELECT policy, and the
-- notification unique index (after every writer moved to the dedupe key).
-- No existing row is modified.

-- ---------------------------------------------------------------------------
-- 1. Site owners
-- ---------------------------------------------------------------------------
CREATE TABLE public.site_owners (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.site_owners ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.site_owners FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.site_owners TO authenticated;

CREATE POLICY "Site owners can see their own row"
ON public.site_owners
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

DO $seed$
DECLARE
  seeded integer;
BEGIN
  INSERT INTO public.site_owners (user_id)
  SELECT u.id
  FROM auth.users u
  WHERE u.id IN (
    '09e1232f-e1c5-4e4d-bb12-e9a9f95a3c1f'::uuid,
    'ca4a2221-e712-4962-9d11-5776c4f3e021'::uuid
  )
  ON CONFLICT (user_id) DO NOTHING;

  SELECT count(*) INTO seeded FROM public.site_owners;
  IF seeded = 0 THEN
    RAISE EXCEPTION 'Neither site owner account exists in auth.users; refusing to create an empty site_owners table.';
  END IF;
END
$seed$;

-- True only for the caller's own id: nobody can probe who the site owners are.
CREATE OR REPLACE FUNCTION public.is_site_owner(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_user_id IS NOT NULL
    AND p_user_id = auth.uid()
    AND EXISTS (SELECT 1 FROM public.site_owners so WHERE so.user_id = p_user_id);
$$;

REVOKE ALL ON FUNCTION public.is_site_owner(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_site_owner(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Notifications core (needed by the recovery notices below)
-- ---------------------------------------------------------------------------
ALTER TABLE public.room_notifications
  ADD COLUMN IF NOT EXISTS actor_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS entity_id uuid,
  ADD COLUMN IF NOT EXISTS dedupe_key text;

ALTER TABLE public.room_notifications
  ADD CONSTRAINT room_notifications_dedupe_key_length CHECK (dedupe_key IS NULL OR char_length(dedupe_key) BETWEEN 1 AND 200),
  ADD CONSTRAINT room_notifications_message_length CHECK (char_length(message) BETWEEN 1 AND 500),
  ADD CONSTRAINT room_notifications_type_allowed CHECK (notification_type IN (
    'mention', 'reply', 'announcement', 'pdf_shared', 'timer',
    'recovery_request', 'recovery_decision', 'access', 'security',
    'permanent_conversion', 'room_deletion'
  ));

CREATE UNIQUE INDEX room_notifications_recipient_dedupe
ON public.room_notifications (recipient_id, dedupe_key)
WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS room_notifications_recipient_unread_idx
ON public.room_notifications (recipient_id, created_at DESC)
WHERE read_at IS NULL;

-- Display label for notices: public profile fields only.
CREATE OR REPLACE FUNCTION public.notification_user_label(p_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    (SELECT COALESCE(NULLIF(btrim(p.display_name), ''), CASE WHEN p.username IS NOT NULL THEN '@' || p.username END)
     FROM public.profiles p WHERE p.id = p_user_id),
    'A member'
  );
$$;

-- The single writer of notifications. Internal: only other SECURITY DEFINER
-- functions and triggers call it (no client EXECUTE). People are never
-- notified about their own actions, except decisions and access/security
-- notices that concern them.
CREATE OR REPLACE FUNCTION public.enqueue_room_notification(
  p_recipient_id uuid,
  p_room_id uuid,
  p_type text,
  p_message text,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_actor_id uuid DEFAULT NULL,
  p_entity_id uuid DEFAULT NULL,
  p_dedupe_key text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_recipient_id IS NULL OR p_room_id IS NULL OR p_type IS NULL OR btrim(COALESCE(p_message, '')) = '' THEN
    RETURN false;
  END IF;

  IF p_actor_id IS NOT NULL
     AND p_actor_id = p_recipient_id
     AND p_type NOT IN ('recovery_decision', 'access', 'security', 'room_deletion') THEN
    RETURN false;
  END IF;

  INSERT INTO public.room_notifications (
    room_id, recipient_id, notification_type, message, metadata, actor_id, entity_id, dedupe_key
  )
  VALUES (
    p_room_id, p_recipient_id, p_type, left(btrim(p_message), 500),
    COALESCE(p_metadata, '{}'::jsonb), p_actor_id, p_entity_id, p_dedupe_key
  )
  ON CONFLICT (recipient_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.notification_user_label(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_room_notification(uuid, uuid, text, text, jsonb, uuid, uuid, text) FROM PUBLIC, anon, authenticated;

-- Permanent-conversion notices move to the dedupe key (same text and
-- recipients as before, with readable names instead of raw user ids).
CREATE OR REPLACE FUNCTION public.convert_active_room_to_permanent(p_room_id uuid, p_username text DEFAULT NULL::text)
RETURNS public.rooms
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  room_row public.rooms;
  clean_username text;
  room_expiration_type text;
  recipient record;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_room_admin_or_owner(p_room_id, auth.uid()) THEN
    RAISE EXCEPTION 'Only an approved room owner or admin can convert this room.';
  END IF;

  IF NOT public.room_has_active_access(p_room_id) THEN
    RAISE EXCEPTION 'The room is not currently active.';
  END IF;

  SELECT expiration_type INTO room_expiration_type
  FROM public.rooms
  WHERE id = p_room_id;
  IF room_expiration_type IS DISTINCT FROM 'recoverable' THEN
    RAISE EXCEPTION 'Only recoverable rooms can be converted through this workflow.';
  END IF;

  clean_username := NULLIF(lower(regexp_replace(COALESCE(p_username, ''), '[^a-z0-9_.]', '', 'g')), '');
  PERFORM set_config('app.omnilume_lifecycle_authorized', 'permanent_conversion', true);

  UPDATE public.rooms
  SET is_group = true,
      expiration_type = 'permanent',
      expires_at = NULL,
      reopened_until = NULL,
      username = COALESCE(clean_username, username)
  WHERE id = p_room_id
  RETURNING * INTO room_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Room not found.';
  END IF;

  FOR recipient IN
    SELECT DISTINCT recipients.user_id
    FROM (
      SELECT rm.user_id FROM public.room_members rm WHERE rm.room_id = p_room_id AND rm.join_status = 'approved'
      UNION SELECT m.sender_id FROM public.messages m WHERE m.room_id = p_room_id
      UNION SELECT m.receiver_id FROM public.messages m WHERE m.room_id = p_room_id AND m.receiver_id IS NOT NULL
      UNION SELECT rm2.user_id FROM public.room_messages rm2 WHERE rm2.room_id = p_room_id
      UNION SELECT ss.user_id FROM public.study_sessions ss WHERE ss.room_id = p_room_id AND ss.user_id IS NOT NULL
      UNION SELECT tm.user_id FROM public.temporary_media tm WHERE tm.room_id = p_room_id AND tm.user_id IS NOT NULL
    ) recipients
    WHERE recipients.user_id IS NOT NULL
  LOOP
    PERFORM public.enqueue_room_notification(
      recipient.user_id, p_room_id, 'permanent_conversion',
      public.notification_user_label(auth.uid()) || ' converted this room to permanent. The room is now available indefinitely.',
      jsonb_build_object('requester_id', auth.uid(), 'status', 'permanent'),
      auth.uid(), p_room_id, 'permanent_conversion:' || p_room_id::text
    );
  END LOOP;

  RETURN room_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.review_permanent_room_request(p_request_id uuid, p_decision text)
RETURNS public.room_permanent_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  request_row public.room_permanent_requests;
  recipient record;
BEGIN
  IF auth.uid() IS NULL OR p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Unauthorized permanent-room decision.';
  END IF;

  SELECT rpr.*
  INTO request_row
  FROM public.room_permanent_requests rpr
  WHERE rpr.id = p_request_id
  FOR UPDATE;

  IF NOT FOUND
     OR request_row.status <> 'pending'
     OR NOT public.room_has_active_access(request_row.room_id)
     OR NOT EXISTS (
       SELECT 1
       FROM public.rooms r
       WHERE r.id = request_row.room_id
         AND r.expiration_type = 'recoverable'
         AND r.reopened_until IS NOT NULL
         AND r.reopened_until > now()
     )
     OR NOT public.is_room_admin_or_owner(request_row.room_id, auth.uid()) THEN
    RAISE EXCEPTION 'Permanent-room request is not available for this reviewer.';
  END IF;

  UPDATE public.room_permanent_requests
  SET status = p_decision,
      reviewed_at = now(),
      reviewed_by = auth.uid()
  WHERE id = p_request_id
  RETURNING * INTO request_row;

  IF p_decision = 'approved' THEN
    PERFORM set_config('app.omnilume_lifecycle_authorized', 'permanent_conversion', true);
    UPDATE public.rooms
    SET expiration_type = 'permanent',
        expires_at = NULL,
        reopened_until = NULL
    WHERE id = request_row.room_id;

    FOR recipient IN
      SELECT DISTINCT recipients.user_id
      FROM (
        SELECT rm.user_id FROM public.room_members rm WHERE rm.room_id = request_row.room_id AND rm.join_status = 'approved'
        UNION SELECT m.sender_id FROM public.messages m WHERE m.room_id = request_row.room_id
        UNION SELECT m.receiver_id FROM public.messages m WHERE m.room_id = request_row.room_id AND m.receiver_id IS NOT NULL
        UNION SELECT rm2.user_id FROM public.room_messages rm2 WHERE rm2.room_id = request_row.room_id
        UNION SELECT ss.user_id FROM public.study_sessions ss WHERE ss.room_id = request_row.room_id AND ss.user_id IS NOT NULL
        UNION SELECT tm.user_id FROM public.temporary_media tm WHERE tm.room_id = request_row.room_id AND tm.user_id IS NOT NULL
      ) recipients
      WHERE recipients.user_id IS NOT NULL
    LOOP
      PERFORM public.enqueue_room_notification(
        recipient.user_id, request_row.room_id, 'permanent_conversion',
        public.notification_user_label(request_row.requester_id) || ' requested this room to become permanent. The request was approved, and the room is now permanent and available indefinitely.',
        jsonb_build_object('requester_id', request_row.requester_id, 'request_id', request_row.id, 'status', 'permanent'),
        auth.uid(), request_row.id, 'permanent_conversion:' || request_row.room_id::text
      );
    END LOOP;
  END IF;

  RETURN request_row;
END;
$$;

-- Every writer now uses the dedupe key; the one-per-type index goes.
DROP INDEX IF EXISTS public.room_notifications_unique_conversion;

-- ---------------------------------------------------------------------------
-- 2. Recovery requests and site-owner review
-- ---------------------------------------------------------------------------

-- Any approved non-guest member, strictly inside the 7-day window of an
-- expired recoverable room that has not been reopened.
CREATE OR REPLACE FUNCTION public.can_request_room_recovery(p_room_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.rooms r
      WHERE r.id = p_room_id
        AND r.expiration_type = 'recoverable'
        AND r.expires_at IS NOT NULL
        AND r.expires_at <= now()
        AND now() <= r.expires_at + interval '7 days'
        AND (r.reopened_until IS NULL OR r.reopened_until <= now())
        AND public.room_lifecycle_state(r.id) = 'recovery-window'
    )
    AND public.room_user_role(p_room_id, auth.uid()) IN ('owner', 'admin', 'member');
$$;

REVOKE ALL ON FUNCTION public.can_request_room_recovery(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_request_room_recovery(uuid) TO authenticated;

DROP POLICY IF EXISTS "Owners and admins can request recovery" ON public.recovery_requests;
CREATE POLICY "Approved members can request recovery"
ON public.recovery_requests
FOR INSERT
TO authenticated
WITH CHECK (
  requester_id = auth.uid()
  AND status = 'pending'
  AND reviewed_at IS NULL
  AND reviewed_by IS NULL
  AND public.can_request_room_recovery(room_id)
);

-- Requesters see their own requests; site owners see all of them. Room
-- owners and admins no longer see other members' requests.
DROP POLICY IF EXISTS "Recovery request participants can view requests" ON public.recovery_requests;
CREATE POLICY "Requesters and site owners can view recovery requests"
ON public.recovery_requests
FOR SELECT
TO authenticated
USING (requester_id = auth.uid() OR public.is_site_owner(auth.uid()));

-- Members (not only owners/admins) can open the quarantine screen of their
-- room during the recovery window.
DROP POLICY IF EXISTS "Recovery managers can view expired rooms" ON public.rooms;
CREATE POLICY "Members can view their room during its recovery window"
ON public.rooms
FOR SELECT
TO authenticated
USING (
  public.room_in_recovery_window(id)
  AND public.room_user_role(id, auth.uid()) IN ('owner', 'admin', 'member')
);

CREATE OR REPLACE FUNCTION public.get_room_by_identifier(identifier text)
RETURNS SETOF public.rooms
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT r.*
  FROM public.rooms r
  WHERE (lower(r.username) = lower(identifier) OR r.id::text = identifier)
    AND (
      (
        public.room_has_active_access(r.id)
        AND (
          NOT r.is_private
          OR public.is_approved_room_member(r.id, auth.uid())
          OR r.created_by = auth.uid()
        )
      )
      OR (
        public.room_lifecycle_state(r.id) = 'scheduled'
        AND (r.created_by = auth.uid() OR public.is_approved_room_member(r.id, auth.uid()))
      )
      OR (
        public.room_in_recovery_window(r.id)
        AND public.room_user_role(r.id, auth.uid()) IN ('owner', 'admin', 'member')
      )
    )
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.review_recovery_request(p_request_id uuid, p_decision text)
RETURNS public.recovery_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
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
$$;

REVOKE ALL ON FUNCTION public.review_recovery_request(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_recovery_request(uuid, text) TO authenticated;

-- Review queue for /admin/recovery (site owners only).
CREATE OR REPLACE FUNCTION public.list_recovery_review_queue()
RETURNS TABLE (
  request_id uuid,
  room_id uuid,
  room_name text,
  room_expired_at timestamptz,
  window_ends_at timestamptz,
  requester_id uuid,
  requester_label text,
  requested_at timestamptz,
  other_pending integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
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
     WHERE other.room_id = rr.room_id AND other.status = 'pending' AND other.id <> rr.id)
  FROM public.recovery_requests rr
  JOIN public.rooms r ON r.id = rr.room_id
  WHERE rr.status = 'pending'
  ORDER BY r.expires_at ASC NULLS LAST, rr.created_at ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.list_recovery_review_queue() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_recovery_review_queue() TO authenticated;

-- Site owners hear about every new request.
CREATE OR REPLACE FUNCTION public.notify_site_owners_of_recovery_request()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_room_name text;
  owner_row record;
BEGIN
  SELECT r.name INTO v_room_name FROM public.rooms r WHERE r.id = NEW.room_id;
  FOR owner_row IN SELECT so.user_id FROM public.site_owners so LOOP
    PERFORM public.enqueue_room_notification(
      owner_row.user_id, NEW.room_id, 'recovery_request',
      public.notification_user_label(NEW.requester_id) || ' asked to recover "' || COALESCE(v_room_name, 'a room') || '".',
      jsonb_build_object('request_id', NEW.id, 'room_name', v_room_name),
      NEW.requester_id, NEW.id, 'recovery_request:' || NEW.id::text
    );
  END LOOP;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_site_owners_of_recovery_request() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS notify_site_owners_of_recovery_request ON public.recovery_requests;
CREATE TRIGGER notify_site_owners_of_recovery_request
AFTER INSERT ON public.recovery_requests
FOR EACH ROW
EXECUTE FUNCTION public.notify_site_owners_of_recovery_request();

-- Decision notices: the requester always; on approval, the room's members.
CREATE OR REPLACE FUNCTION public.notify_room_recovery_decision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_room_name text;
  member_row record;
BEGIN
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('approved', 'rejected') THEN
    RETURN NEW;
  END IF;

  SELECT r.name INTO v_room_name FROM public.rooms r WHERE r.id = NEW.room_id;

  PERFORM public.enqueue_room_notification(
    NEW.requester_id, NEW.room_id, 'recovery_decision',
    CASE NEW.status
      WHEN 'approved' THEN 'Your recovery request for "' || COALESCE(v_room_name, 'the room') || '" was approved. The room is open again for 7 days.'
      ELSE 'Your recovery request for "' || COALESCE(v_room_name, 'the room') || '" was rejected. The room stays unavailable and is deleted when its recovery window ends.'
    END,
    jsonb_build_object('request_id', NEW.id, 'decision', NEW.status, 'room_name', v_room_name),
    NEW.reviewed_by, NEW.id, 'recovery_decision:' || NEW.id::text
  );

  IF NEW.status = 'approved' THEN
    FOR member_row IN
      SELECT rm.user_id
      FROM public.room_members rm
      WHERE rm.room_id = NEW.room_id
        AND rm.join_status = 'approved'
        AND rm.user_id <> NEW.requester_id
    LOOP
      PERFORM public.enqueue_room_notification(
        member_row.user_id, NEW.room_id, 'recovery_decision',
        '"' || COALESCE(v_room_name, 'A room') || '" was recovered and is open again for 7 days.',
        jsonb_build_object('request_id', NEW.id, 'decision', 'approved', 'room_name', v_room_name),
        NEW.reviewed_by, NEW.room_id,
        'room_recovered:' || NEW.room_id::text || ':' || extract(epoch FROM NEW.reviewed_at)::bigint::text
      );
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_room_recovery_decision() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. §9 permanent rooms: scheduled deletion with a grace period
-- ---------------------------------------------------------------------------
ALTER TABLE public.rooms
  ADD COLUMN IF NOT EXISTS deletion_scheduled_at timestamptz,
  ADD COLUMN IF NOT EXISTS deletion_scheduled_by uuid REFERENCES auth.users (id) ON DELETE SET NULL;

ALTER TABLE public.rooms
  ADD CONSTRAINT rooms_deletion_schedule_permanent_only
  CHECK (deletion_scheduled_at IS NULL OR expiration_type = 'permanent');

CREATE OR REPLACE FUNCTION public.prevent_unauthorized_deletion_schedule()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.deletion_scheduled_at IS NOT NULL OR NEW.deletion_scheduled_by IS NOT NULL THEN
      RAISE EXCEPTION 'Room deletion can only be scheduled through the deletion workflow.';
    END IF;
  ELSIF (NEW.deletion_scheduled_at IS DISTINCT FROM OLD.deletion_scheduled_at
         OR NEW.deletion_scheduled_by IS DISTINCT FROM OLD.deletion_scheduled_by)
        AND COALESCE(current_setting('app.omnilume_lifecycle_authorized', true), '') <> 'deletion_schedule' THEN
    RAISE EXCEPTION 'Room deletion can only be scheduled through the deletion workflow.';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.prevent_unauthorized_deletion_schedule() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS prevent_unauthorized_deletion_schedule ON public.rooms;
CREATE TRIGGER prevent_unauthorized_deletion_schedule
BEFORE INSERT OR UPDATE OF deletion_scheduled_at, deletion_scheduled_by ON public.rooms
FOR EACH ROW
EXECUTE FUNCTION public.prevent_unauthorized_deletion_schedule();

CREATE OR REPLACE FUNCTION public.schedule_room_deletion(p_room_id uuid, p_grace_days integer DEFAULT 7)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  room_row public.rooms;
  v_deletion_at timestamptz;
  member_row record;
BEGIN
  IF auth.uid() IS NULL OR public.room_user_role(p_room_id, auth.uid()) IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Only the room owner can schedule deletion.' USING ERRCODE = '42501';
  END IF;

  IF p_grace_days IS NULL OR p_grace_days < 7 OR p_grace_days > 14 THEN
    RAISE EXCEPTION 'The deletion grace period must be between 7 and 14 days.';
  END IF;

  SELECT r.* INTO room_row FROM public.rooms r WHERE r.id = p_room_id FOR UPDATE;
  IF NOT FOUND OR room_row.expiration_type <> 'permanent' THEN
    RAISE EXCEPTION 'Only permanent rooms can be scheduled for deletion.';
  END IF;
  IF NOT public.room_has_active_access(p_room_id) THEN
    RAISE EXCEPTION 'The room is not currently active.';
  END IF;
  IF room_row.deletion_scheduled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Deletion is already scheduled for this room.';
  END IF;

  v_deletion_at := now() + make_interval(days => p_grace_days);
  PERFORM set_config('app.omnilume_lifecycle_authorized', 'deletion_schedule', true);
  UPDATE public.rooms
  SET deletion_scheduled_at = v_deletion_at,
      deletion_scheduled_by = auth.uid()
  WHERE id = p_room_id;

  FOR member_row IN
    SELECT rm.user_id FROM public.room_members rm
    WHERE rm.room_id = p_room_id AND rm.join_status = 'approved'
  LOOP
    PERFORM public.enqueue_room_notification(
      member_row.user_id, p_room_id, 'room_deletion',
      '"' || room_row.name || '" will be permanently deleted on '
        || to_char(v_deletion_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC unless the owner cancels.',
      jsonb_build_object('action', 'scheduled', 'deletion_scheduled_at', v_deletion_at),
      auth.uid(), p_room_id,
      'room_deletion:scheduled:' || p_room_id::text || ':' || extract(epoch FROM v_deletion_at)::bigint::text
    );
  END LOOP;

  RETURN v_deletion_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_room_deletion(p_room_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  room_row public.rooms;
  member_row record;
BEGIN
  IF auth.uid() IS NULL OR public.room_user_role(p_room_id, auth.uid()) IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Only the room owner can cancel deletion.' USING ERRCODE = '42501';
  END IF;

  SELECT r.* INTO room_row FROM public.rooms r WHERE r.id = p_room_id FOR UPDATE;
  IF NOT FOUND OR room_row.deletion_scheduled_at IS NULL THEN
    RAISE EXCEPTION 'No deletion is scheduled for this room.';
  END IF;
  IF room_row.deletion_scheduled_at <= now() THEN
    RAISE EXCEPTION 'The grace period has ended; the room is being deleted.';
  END IF;

  PERFORM set_config('app.omnilume_lifecycle_authorized', 'deletion_schedule', true);
  UPDATE public.rooms
  SET deletion_scheduled_at = NULL,
      deletion_scheduled_by = NULL
  WHERE id = p_room_id;

  FOR member_row IN
    SELECT rm.user_id FROM public.room_members rm
    WHERE rm.room_id = p_room_id AND rm.join_status = 'approved'
  LOOP
    PERFORM public.enqueue_room_notification(
      member_row.user_id, p_room_id, 'room_deletion',
      'The scheduled deletion of "' || room_row.name || '" was cancelled. The room stays available.',
      jsonb_build_object('action', 'cancelled'),
      auth.uid(), p_room_id,
      'room_deletion:cancelled:' || p_room_id::text || ':' || extract(epoch FROM now())::bigint::text
    );
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.schedule_room_deletion(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_room_deletion(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.schedule_room_deletion(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_room_deletion(uuid) TO authenticated;

-- Lifecycle: a permanent room whose grace period has ended is destroyed.
CREATE OR REPLACE FUNCTION public.room_lifecycle_state(p_room_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
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
       )
     ) THEN
    RETURN 'recovery-window';
  END IF;

  RETURN 'destroyed';
END;
$$;

CREATE OR REPLACE FUNCTION public.list_rooms_due_for_destruction(p_limit integer DEFAULT 100)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT r.id
  FROM public.rooms r
  WHERE (
      (r.expiration_type IN ('recoverable', 'irreversible') AND r.expires_at IS NOT NULL AND r.expires_at <= now())
      OR (r.expiration_type = 'permanent' AND r.deletion_scheduled_at IS NOT NULL AND r.deletion_scheduled_at <= now())
    )
    AND public.room_lifecycle_state(r.id) = 'destroyed'
  ORDER BY COALESCE(r.expires_at, r.deletion_scheduled_at)
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
$$;

CREATE OR REPLACE FUNCTION public.destroy_expired_room(p_room_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM 1 FROM public.rooms r WHERE r.id = p_room_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF public.room_lifecycle_state(p_room_id) <> 'destroyed' THEN
    RETURN false;
  END IF;

  DELETE FROM public.rooms r
  WHERE r.id = p_room_id
    AND (
      r.expiration_type IN ('recoverable', 'irreversible')
      OR (r.expiration_type = 'permanent' AND r.deletion_scheduled_at IS NOT NULL AND r.deletion_scheduled_at <= now())
    );
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.list_rooms_due_for_destruction(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.destroy_expired_room(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_rooms_due_for_destruction(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.destroy_expired_room(uuid) TO service_role;
