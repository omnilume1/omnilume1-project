-- Master plan §9: "The room information panel should clearly display the
-- selected deletion policy before users join." Invite holders could join
-- without seeing it. This preview returns the room's name and lifecycle
-- policy only for a valid, unrevoked, unexhausted invite that the caller may
-- use (same conditions as get_room_invite). Additive: a new function only.

CREATE OR REPLACE FUNCTION public.get_room_invite_preview(p_token text)
RETURNS TABLE (
  room_id uuid,
  room_name text,
  is_private boolean,
  expiration_type text,
  room_expires_at timestamptz,
  reopened_until timestamptz,
  deletion_scheduled_at timestamptz,
  guest_lifetime_minutes integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT r.id, r.name, r.is_private, r.expiration_type, r.expires_at, r.reopened_until, r.deletion_scheduled_at, i.guest_lifetime_minutes
  FROM public.room_invites i
  JOIN public.rooms r ON r.id = i.room_id
  WHERE auth.uid() IS NOT NULL
    AND i.token = p_token
    AND i.revoked_at IS NULL
    AND (i.expires_at IS NULL OR i.expires_at > now())
    AND (i.max_uses IS NULL OR i.uses_count < i.max_uses)
    AND public.room_can_join(i.room_id, auth.uid());
$$;

REVOKE ALL ON FUNCTION public.get_room_invite_preview(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_room_invite_preview(text) TO authenticated;
