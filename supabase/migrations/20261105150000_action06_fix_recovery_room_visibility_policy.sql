-- Hotfix for 20261105130000. The rooms SELECT policy "Members can view their
-- room during its recovery window" called public.room_user_role directly.
-- Client roles have no EXECUTE on that helper, so every rooms query by a
-- signed-in user failed with "permission denied for function
-- room_user_role" (room lists, room creation's membership check). The policy
-- also applied to anon.
--
-- Fix: the same rule inside a SECURITY DEFINER function that authenticated
-- may execute, and the policy scoped to authenticated. Behaviour is otherwise
-- identical: approved non-guest members see their room during its recovery
-- window.

CREATE OR REPLACE FUNCTION public.can_view_room_in_recovery_window(p_room_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT auth.uid() IS NOT NULL
    AND public.room_in_recovery_window(p_room_id)
    AND public.room_user_role(p_room_id, auth.uid()) IN ('owner', 'admin', 'member');
$$;

REVOKE ALL ON FUNCTION public.can_view_room_in_recovery_window(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_view_room_in_recovery_window(uuid) TO authenticated;

DROP POLICY IF EXISTS "Members can view their room during its recovery window" ON public.rooms;
CREATE POLICY "Members can view their room during its recovery window"
ON public.rooms
FOR SELECT
TO authenticated
USING (public.can_view_room_in_recovery_window(id));
