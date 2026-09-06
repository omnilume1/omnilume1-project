-- Action 05 read contracts. These functions expose only the room-scoped data
-- needed by the Control Center while keeping reusable invite tokens private.

CREATE OR REPLACE FUNCTION public.list_room_invite_history(p_room_id uuid)
RETURNS TABLE (
  id uuid,
  expires_at timestamptz,
  max_uses integer,
  uses_count integer,
  guest_lifetime_minutes integer,
  revoked_at timestamptz,
  created_at timestamptz,
  status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.room_has_capability(p_room_id, auth.uid(), 'manage_invites') THEN
    RAISE EXCEPTION 'Not authorized to view room invite history.';
  END IF;

  RETURN QUERY
  SELECT i.id,
         i.expires_at,
         i.max_uses,
         i.uses_count,
         i.guest_lifetime_minutes,
         i.revoked_at,
         i.created_at,
         CASE
           WHEN i.revoked_at IS NOT NULL THEN 'revoked'
           WHEN i.expires_at IS NOT NULL AND i.expires_at <= now() THEN 'expired'
           WHEN i.max_uses IS NOT NULL AND i.uses_count >= i.max_uses THEN 'exhausted'
           ELSE 'active'
         END
  FROM public.room_invites i
  WHERE i.room_id = p_room_id
  ORDER BY i.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_my_room_join_eligibility(p_room_id uuid)
RETURNS TABLE (
  state text,
  can_join boolean,
  join_status text,
  role text,
  guest_expires_at timestamptz,
  restriction_types text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  room_row public.rooms;
  member_exists boolean := false;
  member_join_status text;
  member_role text;
  member_guest_expires_at timestamptz;
  active_restrictions text[];
  next_join_status text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT r.* INTO room_row FROM public.rooms r WHERE r.id = p_room_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unavailable'::text, false, NULL::text, NULL::text, NULL::timestamptz, ARRAY[]::text[];
    RETURN;
  END IF;

  SELECT COALESCE(array_agg(r.restriction_type ORDER BY r.restriction_type), ARRAY[]::text[])
  INTO active_restrictions
  FROM public.room_member_restrictions r
  WHERE r.room_id = p_room_id
    AND r.user_id = auth.uid()
    AND (r.expires_at IS NULL OR r.expires_at > now());

  SELECT rm.join_status, rm.role, rm.guest_expires_at
  INTO member_join_status, member_role, member_guest_expires_at
  FROM public.room_members rm
  WHERE rm.room_id = p_room_id AND rm.user_id = auth.uid();
  member_exists := FOUND;

  IF 'ban' = ANY(active_restrictions) THEN
    RETURN QUERY SELECT 'banned'::text, false, member_join_status, member_role, member_guest_expires_at, active_restrictions;
    RETURN;
  END IF;
  IF 'block' = ANY(active_restrictions) THEN
    RETURN QUERY SELECT 'blocked'::text, false, member_join_status, member_role, member_guest_expires_at, active_restrictions;
    RETURN;
  END IF;

  IF member_exists THEN
    IF member_role = 'guest' AND member_guest_expires_at <= now() THEN
      RETURN QUERY SELECT 'guest_expired'::text, false, member_join_status, member_role, member_guest_expires_at, active_restrictions;
      RETURN;
    ELSIF member_join_status = 'approved' THEN
      RETURN QUERY SELECT 'already_joined'::text, false, member_join_status, member_role, member_guest_expires_at, active_restrictions;
      RETURN;
    ELSE
      RETURN QUERY SELECT member_join_status, false, member_join_status, member_role, member_guest_expires_at, active_restrictions;
      RETURN;
    END IF;
  END IF;

  IF NOT public.room_has_active_access(p_room_id) THEN
    RETURN QUERY SELECT 'unavailable'::text, false, NULL::text, NULL::text, NULL::timestamptz, active_restrictions;
    RETURN;
  END IF;
  IF NOT public.room_can_join(p_room_id, auth.uid()) THEN
    RETURN QUERY SELECT 'restricted'::text, false, NULL::text, NULL::text, NULL::timestamptz, active_restrictions;
    RETURN;
  END IF;

  next_join_status := CASE WHEN room_row.is_private THEN 'pending' ELSE 'approved' END;
  RETURN QUERY SELECT 'eligible'::text, true, next_join_status, NULL::text, NULL::timestamptz, active_restrictions;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_room_member_control_states(p_room_id uuid)
RETURNS TABLE (
  user_id uuid,
  role text,
  join_status text,
  guest_expires_at timestamptz,
  restriction_types text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  can_manage boolean;
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.room_has_active_access(p_room_id)
     OR NOT public.is_approved_room_member(p_room_id, auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized to view room member state.';
  END IF;

  can_manage := public.room_has_capability(p_room_id, auth.uid(), 'manage_members');

  RETURN QUERY
  WITH scoped_users AS (
    SELECT rm.user_id
    FROM public.room_members rm
    WHERE rm.room_id = p_room_id
      AND (can_manage OR rm.user_id = auth.uid())
    UNION
    SELECT r.user_id
    FROM public.room_member_restrictions r
    WHERE r.room_id = p_room_id AND can_manage
  )
  SELECT su.user_id,
         rm.role,
         rm.join_status,
         rm.guest_expires_at,
         COALESCE(array_agg(r.restriction_type ORDER BY r.restriction_type) FILTER (WHERE r.restriction_type IS NOT NULL), ARRAY[]::text[])
  FROM scoped_users su
  LEFT JOIN public.room_members rm
    ON rm.room_id = p_room_id AND rm.user_id = su.user_id
  LEFT JOIN public.room_member_restrictions r
    ON r.room_id = p_room_id AND r.user_id = su.user_id
   AND (r.expires_at IS NULL OR r.expires_at > now())
  GROUP BY su.user_id, rm.role, rm.join_status, rm.guest_expires_at
  ORDER BY su.user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_room_member_profile(
  p_room_id uuid,
  p_user_id uuid DEFAULT NULL
)
RETURNS TABLE (
  user_id uuid,
  display_name text,
  avatar_url text,
  bio text,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  target_user_id uuid := COALESCE(p_user_id, auth.uid());
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.room_has_active_access(p_room_id)
     OR NOT public.is_approved_room_member(p_room_id, auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized to view room profiles.';
  END IF;

  IF target_user_id IS NULL
     OR NOT public.is_approved_room_member(p_room_id, target_user_id) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT p.user_id, p.display_name, p.avatar_url, p.bio, p.updated_at
  FROM public.room_member_profiles p
  WHERE p.room_id = p_room_id AND p.user_id = target_user_id;
END;
$$;

-- Invite tokens are issued only at creation. Historic listing is available via
-- the safe RPC above, never through a broad table SELECT.
DROP POLICY IF EXISTS "Managers read invites" ON public.room_invites;

-- Control data is room-scoped and should follow the same lifecycle boundary as
-- the rest of the room surface; expired rooms do not keep exposing it by RLS.
DROP POLICY IF EXISTS "Room members read controls" ON public.room_control_settings;
CREATE POLICY "Room members read controls" ON public.room_control_settings FOR SELECT TO authenticated
USING (public.room_has_active_access(room_id) AND public.is_approved_room_member(room_id, auth.uid()));
DROP POLICY IF EXISTS "Room members read permissions" ON public.room_role_permissions;
CREATE POLICY "Room members read permissions" ON public.room_role_permissions FOR SELECT TO authenticated
USING (public.room_has_active_access(room_id) AND public.is_approved_room_member(room_id, auth.uid()));
DROP POLICY IF EXISTS "Members read room profiles" ON public.room_member_profiles;
CREATE POLICY "Members read room profiles" ON public.room_member_profiles FOR SELECT TO authenticated
USING (public.room_has_active_access(room_id) AND public.is_approved_room_member(room_id, auth.uid()));
DROP POLICY IF EXISTS "Members read announcements" ON public.room_announcements;
CREATE POLICY "Members read announcements" ON public.room_announcements FOR SELECT TO authenticated
USING (public.room_has_active_access(room_id) AND public.room_feature_enabled(room_id, 'announcements') AND public.is_approved_room_member(room_id, auth.uid()));
DROP POLICY IF EXISTS "Members read room control events" ON public.room_control_events;
CREATE POLICY "Members read room control events" ON public.room_control_events FOR SELECT TO authenticated
USING (public.room_has_active_access(room_id) AND public.is_approved_room_member(room_id, auth.uid()));

REVOKE ALL ON FUNCTION public.list_room_invite_history(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_my_room_join_eligibility(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_room_member_control_states(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_room_member_profile(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.list_room_invite_history(uuid),
  public.get_my_room_join_eligibility(uuid),
  public.get_room_member_control_states(uuid),
  public.get_room_member_profile(uuid, uuid)
TO authenticated;
