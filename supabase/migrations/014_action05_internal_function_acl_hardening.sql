-- Internal Action 05 helpers are called only from SECURITY DEFINER functions
-- or triggers. They must not be direct authenticated-client RPC endpoints.

REVOKE ALL ON FUNCTION public.room_user_is_restricted(uuid, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.room_user_role(uuid, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.seed_room_controls(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.seed_room_controls_after_insert() FROM authenticated;
REVOKE ALL ON FUNCTION public.record_room_control_event(uuid, text, uuid, jsonb) FROM authenticated;
