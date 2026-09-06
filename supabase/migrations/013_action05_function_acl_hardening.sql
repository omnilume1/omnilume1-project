-- Supabase grants EXECUTE to anon/authenticated/service_role by default for
-- newly created functions. Action 05 functions are authenticated-only and
-- SECURITY DEFINER helpers must never be callable through a public endpoint.

REVOKE ALL ON FUNCTION public.room_user_is_restricted(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.room_user_role(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_approved_room_member(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.room_feature_enabled(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.room_has_capability(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.room_can_join(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.seed_room_controls(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.seed_room_controls_after_insert() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_room_control_event(uuid, text, uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.request_room_join(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_room_invite(uuid, timestamptz, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.revoke_room_invite(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_room_invite(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.join_room_with_invite(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.leave_room(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.review_room_member(uuid, uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.transfer_room_ownership(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_room_member_role(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_room_controls(uuid, text, text, boolean, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_room_role_permission(uuid, text, text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.upsert_room_member_profile(uuid, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_room_announcement(uuid, text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_room_announcement(uuid, text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_room_invite_history(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_my_room_join_eligibility(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_room_member_control_states(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_room_member_profile(uuid, uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.is_approved_room_member(uuid, uuid),
  public.room_feature_enabled(uuid, text),
  public.room_has_capability(uuid, uuid, text),
  public.room_can_join(uuid, uuid)
TO authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.request_room_join(text),
  public.create_room_invite(uuid, timestamptz, integer, integer),
  public.revoke_room_invite(uuid),
  public.get_room_invite(text),
  public.join_room_with_invite(text),
  public.leave_room(uuid),
  public.review_room_member(uuid, uuid, text, text),
  public.transfer_room_ownership(uuid, uuid),
  public.set_room_member_role(uuid, uuid, text),
  public.update_room_controls(uuid, text, text, boolean, jsonb),
  public.set_room_role_permission(uuid, text, text, boolean),
  public.upsert_room_member_profile(uuid, text, text, text),
  public.create_room_announcement(uuid, text, boolean),
  public.update_room_announcement(uuid, text, boolean),
  public.list_room_invite_history(uuid),
  public.get_my_room_join_eligibility(uuid),
  public.get_room_member_control_states(uuid),
  public.get_room_member_profile(uuid, uuid)
TO authenticated, service_role;
