-- Member-scoped display identity for the room roster. This exposes only the
-- global username/display name already appropriate for room members plus the
-- room-specific display name; no private profile fields are returned.
CREATE OR REPLACE FUNCTION public.get_room_member_identities(p_room_id uuid)
RETURNS TABLE (user_id uuid, username text, account_display_name text, room_display_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.room_has_active_access(p_room_id)
     OR NOT public.is_approved_room_member(p_room_id, auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized to view room member identities.';
  END IF;
  RETURN QUERY
  SELECT rm.user_id, p.username, p.display_name, rmp.display_name
  FROM public.room_members rm
  LEFT JOIN public.profiles p ON p.id = rm.user_id
  LEFT JOIN public.room_member_profiles rmp ON rmp.room_id = rm.room_id AND rmp.user_id = rm.user_id
  WHERE rm.room_id = p_room_id AND rm.join_status = 'approved';
END;
$$;
REVOKE ALL ON FUNCTION public.get_room_member_identities(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_room_member_identities(uuid) TO authenticated;
