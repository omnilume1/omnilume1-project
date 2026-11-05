-- Action 15: Personal, General and Group messaging. Additive only.
--
-- Model
--   * A conversation has exactly ONE type, derived from current relationship
--     state (never stored, so it cannot go stale):
--       personal - a private_chats row whose pair are accepted friends;
--       general  - a private_chats row whose pair has an accepted message
--                  request and are not friends;
--       group    - an Action 14 `groups` row (members in `group_members`).
--     Reclassification General -> Personal is therefore a metadata relabel:
--     no message row, ciphertext or IV is touched.
--   * Personal and General stay end-to-end encrypted (messages.ciphertext).
--     DECISION: group messages are plaintext protected by RLS, like rooms;
--     there is no group key distribution.
--   * Blocking, unfriending, leaving and removal revoke reads, writes and
--     realtime: the type helper returns NULL, restrictive policies on
--     `messages` then refuse the rows and the private topics refuse joins.
--   * One private chat per pair (order-independent unique index).

-- ---------------------------------------------------------------------------
-- 1. Blocks
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_blocks (
  blocker_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT user_blocks_not_self CHECK (blocker_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS user_blocks_blocked_idx ON public.user_blocks (blocked_id);
ALTER TABLE public.user_blocks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.user_blocks FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.user_blocks TO authenticated;
DROP POLICY IF EXISTS "Blockers read their own blocks" ON public.user_blocks;
CREATE POLICY "Blockers read their own blocks" ON public.user_blocks FOR SELECT TO authenticated
USING (blocker_id = auth.uid());

-- Any new relationship row between a blocked pair is refused. TG_ARGV names
-- the two user columns of the table the trigger is attached to.
CREATE OR REPLACE FUNCTION public.reject_blocked_pair()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_a uuid := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
  v_b uuid := (to_jsonb(NEW) ->> TG_ARGV[1])::uuid;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.user_blocks ub
    WHERE (ub.blocker_id = v_a AND ub.blocked_id = v_b) OR (ub.blocker_id = v_b AND ub.blocked_id = v_a)
  ) THEN
    RAISE EXCEPTION 'This member is not available.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.reject_blocked_pair() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS reject_blocked_pair ON public.message_requests;
CREATE TRIGGER reject_blocked_pair BEFORE INSERT ON public.message_requests
FOR EACH ROW EXECUTE FUNCTION public.reject_blocked_pair('requester_id', 'recipient_id');
DROP TRIGGER IF EXISTS reject_blocked_pair ON public.friend_requests;
CREATE TRIGGER reject_blocked_pair BEFORE INSERT ON public.friend_requests
FOR EACH ROW EXECUTE FUNCTION public.reject_blocked_pair('requester_id', 'recipient_id');
DROP TRIGGER IF EXISTS reject_blocked_pair ON public.follows;
CREATE TRIGGER reject_blocked_pair BEFORE INSERT ON public.follows
FOR EACH ROW EXECUTE FUNCTION public.reject_blocked_pair('follower_id', 'following_id');
DROP TRIGGER IF EXISTS reject_blocked_pair ON public.friendships;
CREATE TRIGGER reject_blocked_pair BEFORE INSERT ON public.friendships
FOR EACH ROW EXECUTE FUNCTION public.reject_blocked_pair('user_one', 'user_two');
DROP TRIGGER IF EXISTS reject_blocked_pair ON public.private_chats;
CREATE TRIGGER reject_blocked_pair BEFORE INSERT ON public.private_chats
FOR EACH ROW EXECUTE FUNCTION public.reject_blocked_pair('user_one', 'user_two');

CREATE OR REPLACE FUNCTION public.block_user(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_me uuid := auth.uid();
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501'; END IF;
  IF p_user_id IS NULL OR p_user_id = v_me OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'Invalid member.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.user_blocks (blocker_id, blocked_id) VALUES (v_me, p_user_id) ON CONFLICT DO NOTHING;
  DELETE FROM public.friendships WHERE user_one = LEAST(v_me, p_user_id) AND user_two = GREATEST(v_me, p_user_id);
  DELETE FROM public.follows
  WHERE (follower_id = v_me AND following_id = p_user_id) OR (follower_id = p_user_id AND following_id = v_me);
  UPDATE public.message_requests SET status = 'rejected', responded_at = now(), responded_by = v_me
  WHERE status = 'pending'
    AND ((requester_id = v_me AND recipient_id = p_user_id) OR (requester_id = p_user_id AND recipient_id = v_me));
  UPDATE public.friend_requests SET status = 'rejected', responded_at = now(), responded_by = v_me
  WHERE status = 'pending'
    AND ((requester_id = v_me AND recipient_id = p_user_id) OR (requester_id = p_user_id AND recipient_id = v_me));
  RETURN true;
END;
$$;

-- Unblocking restores nothing: friendship, follows and requests start over.
CREATE OR REPLACE FUNCTION public.unblock_user(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501'; END IF;
  DELETE FROM public.user_blocks WHERE blocker_id = auth.uid() AND blocked_id = p_user_id;
  RETURN FOUND;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Conversation type and access
-- ---------------------------------------------------------------------------
-- No duplicate conversations: one private chat per unordered pair.
CREATE UNIQUE INDEX IF NOT EXISTS private_chats_pair_unique_idx
  ON public.private_chats (LEAST(user_one, user_two), GREATEST(user_one, user_two));

-- Type of a private chat for the caller: 'personal', 'general', or NULL when
-- the caller is not a participant or access is revoked. Policy helper, so it
-- runs as the caller and only answers about the caller's own chats.
CREATE OR REPLACE FUNCTION public.private_chat_type(p_chat_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM public.user_blocks ub
      WHERE (ub.blocker_id = pc.user_one AND ub.blocked_id = pc.user_two)
         OR (ub.blocker_id = pc.user_two AND ub.blocked_id = pc.user_one)
    ) THEN NULL
    WHEN EXISTS (
      SELECT 1 FROM public.friendships f
      WHERE f.user_one = LEAST(pc.user_one, pc.user_two) AND f.user_two = GREATEST(pc.user_one, pc.user_two)
    ) THEN 'personal'
    WHEN EXISTS (
      SELECT 1 FROM public.message_requests mr
      WHERE mr.status = 'accepted'
        AND ((mr.requester_id = pc.user_one AND mr.recipient_id = pc.user_two)
          OR (mr.requester_id = pc.user_two AND mr.recipient_id = pc.user_one))
    ) THEN 'general'
  END
  FROM public.private_chats pc
  WHERE pc.id = p_chat_id AND auth.uid() IS NOT NULL AND auth.uid() IN (pc.user_one, pc.user_two);
$$;

-- Restrictive policies are ANDed with the existing permissive ones, so room
-- messages (chat_id IS NULL) keep their current rules unchanged.
DROP POLICY IF EXISTS "Private messages require active conversation access" ON public.messages;
CREATE POLICY "Private messages require active conversation access" ON public.messages
AS RESTRICTIVE FOR SELECT TO authenticated
USING (chat_id IS NULL OR public.private_chat_type(chat_id) IS NOT NULL);

DROP POLICY IF EXISTS "Private messages go only to the other participant" ON public.messages;
CREATE POLICY "Private messages go only to the other participant" ON public.messages
AS RESTRICTIVE FOR INSERT TO authenticated
WITH CHECK (
  chat_id IS NULL
  OR (
    public.private_chat_type(chat_id) IS NOT NULL
    AND room_id IS NULL
    AND content IS NULL
    AND receiver_id = (
      SELECT CASE WHEN pc.user_one = auth.uid() THEN pc.user_two ELSE pc.user_one END
      FROM public.private_chats pc WHERE pc.id = chat_id
    )
  )
);

-- Realtime topic for a private chat also requires active access now.
CREATE OR REPLACE FUNCTION public.can_receive_private_chat_topic(p_topic text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL OR p_topic IS NULL
     OR p_topic !~ '^chat_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  RETURN public.private_chat_type(substring(p_topic FROM 6)::uuid) IS NOT NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Group messages (plaintext + RLS, see DECISION above)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.group_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content text NOT NULL CONSTRAINT group_messages_content_length CHECK (char_length(btrim(content)) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS group_messages_group_created_idx ON public.group_messages (group_id, created_at DESC, id DESC);
ALTER TABLE public.group_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.group_messages FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON TABLE public.group_messages TO authenticated;
-- id and created_at always come from the server defaults.
GRANT INSERT (group_id, sender_id, content) ON TABLE public.group_messages TO authenticated;

DROP POLICY IF EXISTS "Group members read group messages" ON public.group_messages;
CREATE POLICY "Group members read group messages" ON public.group_messages FOR SELECT TO authenticated
USING (public.is_group_member(group_id, auth.uid()));
DROP POLICY IF EXISTS "Group members send as themselves" ON public.group_messages;
CREATE POLICY "Group members send as themselves" ON public.group_messages FOR INSERT TO authenticated
WITH CHECK (sender_id = auth.uid() AND public.is_group_member(group_id, auth.uid()));
DROP POLICY IF EXISTS "Senders and group managers delete group messages" ON public.group_messages;
CREATE POLICY "Senders and group managers delete group messages" ON public.group_messages FOR DELETE TO authenticated
USING (public.is_group_member(group_id, auth.uid())
  AND (sender_id = auth.uid() OR public.is_group_manager(group_id, auth.uid())));

CREATE OR REPLACE FUNCTION public.can_receive_group_topic(p_topic text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL OR p_topic IS NULL
     OR p_topic !~ '^group_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  RETURN public.is_group_member(substring(p_topic FROM 7)::uuid, auth.uid());
END;
$$;

DROP POLICY IF EXISTS "Group members receive their group channel" ON realtime.messages;
CREATE POLICY "Group members receive their group channel" ON realtime.messages
FOR SELECT TO authenticated
USING (
  realtime.messages.extension IN ('broadcast', 'presence')
  AND public.can_receive_group_topic((SELECT realtime.topic()))
);

CREATE OR REPLACE FUNCTION public.leave_group(p_group_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501'; END IF;
  SELECT role INTO v_role FROM public.group_members WHERE group_id = p_group_id AND user_id = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_role = 'owner' THEN
    RAISE EXCEPTION 'The group owner cannot leave the group.' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.group_members WHERE group_id = p_group_id AND user_id = auth.uid();
  RETURN true;
END;
$$;

-- Owner removes admins and members; admins remove members only.
CREATE OR REPLACE FUNCTION public.remove_group_member(p_group_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor text;
  v_target text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501'; END IF;
  SELECT role INTO v_actor FROM public.group_members WHERE group_id = p_group_id AND user_id = auth.uid();
  SELECT role INTO v_target FROM public.group_members WHERE group_id = p_group_id AND user_id = p_user_id FOR UPDATE;
  IF v_actor IS NULL OR v_target IS NULL OR p_user_id = auth.uid() OR v_target = 'owner'
     OR v_actor = 'member' OR (v_actor = 'admin' AND v_target <> 'member') THEN
    RAISE EXCEPTION 'You cannot remove this member.' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.group_members WHERE group_id = p_group_id AND user_id = p_user_id;
  RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Read state
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.conversation_reads (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  chat_id uuid REFERENCES public.private_chats(id) ON DELETE CASCADE,
  group_id uuid REFERENCES public.groups(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_reads_one_target CHECK (num_nonnulls(chat_id, group_id) = 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS conversation_reads_chat_idx ON public.conversation_reads (user_id, chat_id) WHERE chat_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS conversation_reads_group_idx ON public.conversation_reads (user_id, group_id) WHERE group_id IS NOT NULL;
ALTER TABLE public.conversation_reads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.conversation_reads FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.conversation_reads TO authenticated;
DROP POLICY IF EXISTS "Readers see their own read state" ON public.conversation_reads;
CREATE POLICY "Readers see their own read state" ON public.conversation_reads FOR SELECT TO authenticated
USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.mark_conversation_read(p_conversation_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501'; END IF;
  IF public.private_chat_type(p_conversation_id) IS NOT NULL THEN
    INSERT INTO public.conversation_reads (user_id, chat_id) VALUES (auth.uid(), p_conversation_id)
    ON CONFLICT (user_id, chat_id) WHERE chat_id IS NOT NULL DO UPDATE SET last_read_at = now();
  ELSIF public.is_group_member(p_conversation_id, auth.uid()) THEN
    INSERT INTO public.conversation_reads (user_id, group_id) VALUES (auth.uid(), p_conversation_id)
    ON CONFLICT (user_id, group_id) WHERE group_id IS NOT NULL DO UPDATE SET last_read_at = now();
  ELSE
    RAISE EXCEPTION 'Conversation is not available.' USING ERRCODE = '42501';
  END IF;
  RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. The caller's conversations: one row per conversation, one type each.
--    SECURITY INVOKER: every row and count goes through the caller's RLS.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_conversations()
RETURNS TABLE (
  conversation_id uuid,
  conversation_type text,
  peer_id uuid,
  title text,
  role text,
  last_message_at timestamptz,
  unread_count integer
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT pc.id, t.kind,
    CASE WHEN pc.user_one = auth.uid() THEN pc.user_two ELSE pc.user_one END,
    NULL::text, NULL::text,
    (SELECT max(m.created_at) FROM public.messages m WHERE m.chat_id = pc.id),
    (SELECT count(*)::integer FROM (
      SELECT 1 FROM public.messages m
      WHERE m.chat_id = pc.id AND m.sender_id <> auth.uid() AND m.created_at > COALESCE(r.last_read_at, '-infinity')
      LIMIT 100) u)
  FROM public.private_chats pc
  CROSS JOIN LATERAL (SELECT public.private_chat_type(pc.id) AS kind) t
  LEFT JOIN public.conversation_reads r ON r.user_id = auth.uid() AND r.chat_id = pc.id
  WHERE auth.uid() IN (pc.user_one, pc.user_two) AND t.kind IS NOT NULL
  UNION ALL
  SELECT g.id, 'group', NULL::uuid, g.name, gm.role,
    (SELECT max(m.created_at) FROM public.group_messages m WHERE m.group_id = g.id),
    (SELECT count(*)::integer FROM (
      SELECT 1 FROM public.group_messages m
      WHERE m.group_id = g.id AND m.sender_id <> auth.uid() AND m.created_at > COALESCE(r.last_read_at, '-infinity')
      LIMIT 100) u)
  FROM public.group_members gm
  JOIN public.groups g ON g.id = gm.group_id
  LEFT JOIN public.conversation_reads r ON r.user_id = auth.uid() AND r.group_id = g.id
  WHERE gm.user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- 6. Grants and realtime publication
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.block_user(uuid), public.unblock_user(uuid), public.private_chat_type(uuid),
  public.can_receive_group_topic(text), public.leave_group(uuid), public.remove_group_member(uuid, uuid),
  public.mark_conversation_read(uuid), public.get_my_conversations() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.block_user(uuid), public.unblock_user(uuid), public.private_chat_type(uuid),
  public.can_receive_group_topic(text), public.leave_group(uuid), public.remove_group_member(uuid, uuid),
  public.mark_conversation_read(uuid), public.get_my_conversations() TO authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'group_messages') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.group_messages;
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
