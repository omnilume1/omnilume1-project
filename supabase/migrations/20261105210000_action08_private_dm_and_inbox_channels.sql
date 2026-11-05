-- Private-only Realtime: the inbox and private-chat channels.
--
-- This project now allows only private Realtime channels (see
-- 20261105170000). Two app channels were still public and are therefore
-- refused ("PrivateOnly"): the message inbox refresh channel and the
-- per-conversation channel that delivers end-to-end encrypted private
-- messages live. Both become private:
--   messages_inbox_<uid>  - only that user may join;
--   chat_<private chat id> - only the two participants may join.
-- Nobody may publish (no INSERT policy). Rows delivered through Postgres
-- Changes stay filtered by the message_requests, private_chats and
-- messages RLS policies; encrypted message content is not read here.

-- Topic check for a private conversation. Validates the topic shape before
-- casting, so a malformed or unrelated topic returns false instead of
-- raising inside policy evaluation. Executable by authenticated users
-- because RLS policies run with the caller's privileges.
CREATE OR REPLACE FUNCTION public.can_receive_private_chat_topic(p_topic text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_chat uuid;
BEGIN
  IF auth.uid() IS NULL OR p_topic IS NULL
     OR p_topic !~ '^chat_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  v_chat := substring(p_topic FROM 6)::uuid;
  RETURN EXISTS (
    SELECT 1 FROM public.private_chats pc
    WHERE pc.id = v_chat AND auth.uid() IN (pc.user_one, pc.user_two)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.can_receive_private_chat_topic(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_receive_private_chat_topic(text) TO authenticated;

DROP POLICY IF EXISTS "Users receive their own inbox and private chats" ON realtime.messages;
CREATE POLICY "Users receive their own inbox and private chats"
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  realtime.messages.extension IN ('broadcast', 'presence')
  AND (SELECT auth.uid()) IS NOT NULL
  AND (
    (SELECT realtime.topic()) = 'messages_inbox_' || (SELECT auth.uid())::text
    OR public.can_receive_private_chat_topic((SELECT realtime.topic()))
  )
);
