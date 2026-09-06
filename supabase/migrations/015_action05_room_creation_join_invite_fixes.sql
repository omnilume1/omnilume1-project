-- Action 05 production fixes: preserve the existing room-creation boundary,
-- remove a PL/pgSQL output-column ambiguity, and use the installed pgcrypto
-- schema explicitly for invite entropy.

-- A newly inserted room is not visible to room_has_active_access() while the
-- INSERT ... RETURNING statement is still using its original snapshot. Keep
-- the same active-lifecycle requirement for creators, but evaluate that part
-- directly from the row so authenticated creators can receive their new room.
ALTER POLICY "Authorized users can view active rooms" ON public.rooms
USING (
  (
    created_by = auth.uid()
    AND (
      expiration_type = 'permanent'
      OR (expires_at IS NOT NULL AND expires_at > now())
      OR (reopened_until IS NOT NULL AND reopened_until > now())
    )
  )
  OR (
    public.room_has_active_access(id)
    AND (
      NOT is_private
      OR public.is_approved_room_member(id, auth.uid())
    )
  )
);

CREATE OR REPLACE FUNCTION public.request_room_join(p_identifier text)
RETURNS TABLE(room_id uuid, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  room_row public.rooms;
  existing_status text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT r.*
  INTO room_row
  FROM public.rooms AS r
  WHERE lower(r.username) = lower(trim(leading '@' FROM p_identifier))
     OR r.id::text = trim(leading '@' FROM p_identifier)
  LIMIT 1;

  IF NOT FOUND OR NOT public.room_can_join(room_row.id, auth.uid()) THEN
    RAISE EXCEPTION 'Room is unavailable.';
  END IF;

  SELECT rm.join_status
  INTO existing_status
  FROM public.room_members AS rm
  WHERE rm.room_id = room_row.id
    AND rm.user_id = auth.uid();

  IF FOUND THEN
    RETURN QUERY SELECT room_row.id, existing_status;
    RETURN;
  END IF;

  INSERT INTO public.room_members(room_id, user_id, role, join_status)
  VALUES (
    room_row.id,
    auth.uid(),
    'member',
    CASE WHEN room_row.is_private THEN 'pending' ELSE 'approved' END
  );

  PERFORM public.record_room_control_event(
    room_row.id,
    'membership_changed',
    auth.uid(),
    jsonb_build_object('status', CASE WHEN room_row.is_private THEN 'pending' ELSE 'approved' END)
  );

  RETURN QUERY
  SELECT room_row.id,
         CASE WHEN room_row.is_private THEN 'pending'::text ELSE 'approved'::text END;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_room_invite(
  p_room_id uuid,
  p_expires_at timestamptz DEFAULT NULL,
  p_max_uses integer DEFAULT NULL,
  p_guest_lifetime_minutes integer DEFAULT NULL
)
RETURNS public.room_invites
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  invite_row public.room_invites;
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.room_has_capability(p_room_id, auth.uid(), 'manage_invites') THEN
    RAISE EXCEPTION 'Not authorized to create room invites.';
  END IF;

  IF p_expires_at IS NOT NULL AND p_expires_at <= now() THEN
    RAISE EXCEPTION 'Invite expiry must be in the future.';
  END IF;
  IF p_max_uses IS NOT NULL AND p_max_uses < 1 THEN
    RAISE EXCEPTION 'Invite max uses must be positive.';
  END IF;
  IF p_guest_lifetime_minutes IS NOT NULL
     AND p_guest_lifetime_minutes NOT BETWEEN 5 AND 10080 THEN
    RAISE EXCEPTION 'Guest duration is invalid.';
  END IF;

  INSERT INTO public.room_invites(room_id, token, created_by, expires_at, max_uses, guest_lifetime_minutes)
  VALUES (
    p_room_id,
    encode(extensions.gen_random_bytes(24), 'hex'),
    auth.uid(),
    p_expires_at,
    p_max_uses,
    p_guest_lifetime_minutes
  )
  RETURNING * INTO invite_row;

  PERFORM public.record_room_control_event(
    p_room_id,
    'invite_changed',
    NULL,
    jsonb_build_object('invite_id', invite_row.id, 'state', 'created')
  );

  RETURN invite_row;
END;
$$;
