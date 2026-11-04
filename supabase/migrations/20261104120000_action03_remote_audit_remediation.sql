-- Action 03 remote-audit remediation (2026-11-04).
-- Additive and narrowly scoped. It changes no data, table shape, function body,
-- storage object, or E2EE payload handling. Each item below is a catalog
-- finding from supabase/audits/action01-10 query exports; see
-- docs/action-01-10-evidence-ledger.md for the evidence.

-- 1. Room-chat capability regression on public.messages.
--    011 required room_has_capability(..., 'chat') for room-scoped inserts.
--    019 rewrote the policy for the private-chat branch and replaced the room
--    branch with room_has_active_access + is_approved_room_member, which drops
--    the chat feature flag and the per-role chat permission. Reads and updates
--    still require the capability, so the room-chat UI's insert...select fails,
--    but a direct insert that does not return the row succeeds. This restores
--    the 011 room branch and keeps the 019 private branch unchanged.
--    room_has_capability itself enforces active access, approved and
--    unrestricted membership, guest expiry, the feature flag, and role permission.
ALTER POLICY "Users can insert messages" ON public.messages
WITH CHECK (
  (
    chat_id IS NOT NULL
    AND auth.uid() = sender_id
    AND EXISTS (
      SELECT 1
      FROM public.private_chats pc
      WHERE pc.id = messages.chat_id
        AND (pc.user_one = auth.uid() OR pc.user_two = auth.uid())
        AND (
          public.is_current_friend(pc.user_one, pc.user_two)
          OR EXISTS (
            SELECT 1
            FROM public.message_requests mr
            WHERE mr.status = 'accepted'
              AND messages.receiver_id = CASE
                WHEN pc.user_one = auth.uid() THEN pc.user_two
                ELSE pc.user_one
              END
              AND (
                (mr.requester_id = pc.user_one AND mr.recipient_id = pc.user_two)
                OR (mr.requester_id = pc.user_two AND mr.recipient_id = pc.user_one)
              )
          )
        )
    )
  )
  OR
  (
    room_id IS NOT NULL
    AND auth.uid() = sender_id
    AND public.room_has_capability(room_id, auth.uid(), 'chat')
  )
);

-- 2. Anonymous EXECUTE drift.
--    004 revoked these from PUBLIC and granted authenticated only, but Supabase
--    also grants EXECUTE directly to anon. Later migrations (008, 013, 019,
--    Action 06-10) revoke from anon explicitly; these five were missed. The
--    production export shows anon EXECUTE on all five. is_room_admin_or_owner
--    accepts a caller-supplied user id, so anon could probe room roles by UUID.
--    No anonymous application path calls any of them.
REVOKE EXECUTE ON FUNCTION public.is_room_admin_or_owner(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_room_for_join(text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.review_recovery_request(uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.review_permanent_room_request(uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.convert_active_room_to_permanent(uuid, text) FROM anon;

-- 3. Residual non-DML table privileges for client roles.
--    The export shows TRUNCATE, TRIGGER, REFERENCES and MAINTAIN held by anon
--    and/or authenticated on public tables (for example message_requests,
--    messages, rooms, room_members, room_notifications, temporary_media).
--    TRUNCATE is not subject to RLS. None of these privileges is reachable
--    through the Data API, and no application, Realtime, or Storage path needs
--    them. 008 already removed them from the Action 04 tables; this applies the
--    same rule to every public table. SELECT/INSERT/UPDATE/DELETE grants and
--    RLS policies are unchanged.
DO $$
DECLARE
  target record;
  privileges text := 'TRUNCATE, TRIGGER, REFERENCES';
BEGIN
  IF current_setting('server_version_num')::integer >= 170000 THEN
    privileges := privileges || ', MAINTAIN';
  END IF;

  FOR target IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format(
      'REVOKE %s ON TABLE public.%I FROM PUBLIC, anon, authenticated',
      privileges,
      target.relname
    );
  END LOOP;
END $$;
