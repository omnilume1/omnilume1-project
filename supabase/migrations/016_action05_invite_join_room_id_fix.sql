-- Keep the invite-join path consistent with request_room_join: the function's
-- TABLE return column is named room_id, so room_members references must be
-- explicitly qualified inside PL/pgSQL.

CREATE OR REPLACE FUNCTION public.join_room_with_invite(p_token text)
RETURNS TABLE(room_id uuid, status text, role text, guest_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  invite_row public.room_invites;
  room_row public.rooms;
  existing_membership public.room_members;
  expiry timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT i.*
  INTO invite_row
  FROM public.room_invites AS i
  WHERE i.token = p_token
  FOR UPDATE;

  IF NOT FOUND
     OR invite_row.revoked_at IS NOT NULL
     OR (invite_row.expires_at IS NOT NULL AND invite_row.expires_at <= now())
     OR (invite_row.max_uses IS NOT NULL AND invite_row.uses_count >= invite_row.max_uses) THEN
    RAISE EXCEPTION 'Invite is invalid or expired.';
  END IF;

  SELECT r.*
  INTO room_row
  FROM public.rooms AS r
  WHERE r.id = invite_row.room_id;

  IF NOT FOUND OR NOT public.room_can_join(room_row.id, auth.uid()) THEN
    RAISE EXCEPTION 'Room is unavailable.';
  END IF;

  SELECT rm.*
  INTO existing_membership
  FROM public.room_members AS rm
  WHERE rm.room_id = room_row.id
    AND rm.user_id = auth.uid();

  IF FOUND THEN
    RETURN QUERY
    SELECT room_row.id,
           existing_membership.join_status,
           existing_membership.role,
           existing_membership.guest_expires_at;
    RETURN;
  END IF;

  expiry := CASE
    WHEN invite_row.guest_lifetime_minutes IS NULL THEN NULL
    ELSE now() + make_interval(mins => invite_row.guest_lifetime_minutes)
  END;

  INSERT INTO public.room_members(room_id, user_id, role, join_status, guest_expires_at)
  VALUES (
    room_row.id,
    auth.uid(),
    CASE WHEN expiry IS NULL THEN 'member' ELSE 'guest' END,
    'approved',
    expiry
  );

  UPDATE public.room_invites
  SET uses_count = uses_count + 1
  WHERE id = invite_row.id;

  PERFORM public.record_room_control_event(
    room_row.id,
    CASE WHEN expiry IS NULL THEN 'membership_changed' ELSE 'guest_changed' END,
    auth.uid(),
    jsonb_build_object('via', 'invite')
  );

  RETURN QUERY
  SELECT room_row.id,
         'approved'::text,
         CASE WHEN expiry IS NULL THEN 'member'::text ELSE 'guest'::text END,
         expiry;
END;
$$;
