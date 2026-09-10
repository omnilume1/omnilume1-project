-- ============================================================
-- OmniLume Messages — message requests & personal-chat guard (019)
--
-- PERSONAL: accepted friends / existing E2EE private chats only.
-- GENERAL : people connected through accepted follows, plus
--           message requests between follow-connected users.
--
-- Server-side authorization is the source of truth:
--   * message_requests can only be created by send_message_request()
--     (follow-connected, non-friend pairs only).
--   * accept_message_request() converts a pending request into a
--     private_chats row (the E2EE chat container). reject/cancel
--     never create conversations.
--   * A database trigger prevents ANY private_chats insert unless the
--     pair is currently friends (or the pair owns an accepted request
--     created through accept_message_request). Client manipulation
--     cannot bypass the request state.
--
-- Additive only: no existing tables, policies, or data are touched
-- beyond a new read index for the messages feed.
-- ============================================================

-- ---------------------------------------------------------------------------
-- 1. Message requests
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.message_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  message text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  responded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT message_requests_not_self CHECK (requester_id <> recipient_id),
  CONSTRAINT message_requests_message_length_check
    CHECK (char_length(btrim(message)) BETWEEN 1 AND 200),
  CONSTRAINT message_requests_status_check
    CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS message_requests_pending_pair_unique_idx
  ON public.message_requests (
    LEAST(requester_id, recipient_id),
    GREATEST(requester_id, recipient_id)
  )
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS message_requests_recipient_status_idx
  ON public.message_requests (recipient_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS message_requests_requester_status_idx
  ON public.message_requests (requester_id, status, created_at DESC);

CREATE OR REPLACE FUNCTION public.prevent_message_request_tampering()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.requester_id IS DISTINCT FROM OLD.requester_id
     OR NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Message request identity cannot change.';
  END IF;
  IF OLD.status <> 'pending' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'Completed message requests cannot change.';
  END IF;
  IF NEW.status NOT IN ('pending', 'accepted', 'rejected', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid message request status.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_message_request_tampering ON public.message_requests;
CREATE TRIGGER prevent_message_request_tampering
BEFORE UPDATE ON public.message_requests
FOR EACH ROW
EXECUTE FUNCTION public.prevent_message_request_tampering();

-- ---------------------------------------------------------------------------
-- 2. Private-chat creation guard
-- ---------------------------------------------------------------------------

-- New private chats require a current friendship or an accepted message
-- request. The accept RPC sets a local GUC so its authorized chat insert
-- keeps working; every other path goes through this guard.
CREATE OR REPLACE FUNCTION public.validate_private_chat_creation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.user_one = NEW.user_two THEN
    RAISE EXCEPTION 'Private chats require two different users.';
  END IF;
  IF COALESCE(current_setting('app.omnilume_message_accept', true), '') <> 'true' THEN
    IF NOT public.is_current_friend(NEW.user_one, NEW.user_two)
       AND NOT EXISTS (
         SELECT 1
         FROM public.message_requests mr
         WHERE mr.status = 'accepted'
           AND (
             (mr.requester_id = NEW.user_one AND mr.recipient_id = NEW.user_two)
             OR (mr.requester_id = NEW.user_two AND mr.recipient_id = NEW.user_one)
           )
       ) THEN
      RAISE EXCEPTION 'Private chats require an accepted friendship or an accepted message request.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_private_chat_creation ON public.private_chats;
CREATE TRIGGER validate_private_chat_creation
BEFORE INSERT ON public.private_chats
FOR EACH ROW
EXECUTE FUNCTION public.validate_private_chat_creation();

-- ---------------------------------------------------------------------------
-- 3. Server-authorized request transitions
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.send_message_request(p_recipient_id uuid, p_message text)
RETURNS public.message_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  current_user_id uuid := auth.uid();
  clean_message text := btrim(p_message);
  request_row public.message_requests;
  is_connected boolean;
BEGIN
  IF current_user_id IS NULL OR current_user_id = p_recipient_id THEN
    RAISE EXCEPTION 'Invalid message request recipient.';
  END IF;
  IF char_length(clean_message) < 1 OR char_length(clean_message) > 200 THEN
    RAISE EXCEPTION 'Message requests must be 1-200 characters.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_recipient_id) THEN
    RAISE EXCEPTION 'Recipient profile not found.';
  END IF;
  IF public.is_current_friend(current_user_id, p_recipient_id) THEN
    RAISE EXCEPTION 'You are already friends with this member.';
  END IF;

  SELECT public.is_accepted_follower(current_user_id, p_recipient_id)
      OR public.is_accepted_follower(p_recipient_id, current_user_id)
    INTO is_connected;
  IF NOT is_connected THEN
    RAISE EXCEPTION 'You are not connected through a follow relationship.';
  END IF;

  -- If both sides start a request at the same time, keep the first pending
  -- request and let the recipient handle it instead of hitting the pair index.
  SELECT * INTO request_row
  FROM public.message_requests
  WHERE status = 'pending'
    AND (
      (requester_id = current_user_id AND recipient_id = p_recipient_id)
      OR (requester_id = p_recipient_id AND recipient_id = current_user_id)
    )
  LIMIT 1
  FOR UPDATE;
  IF FOUND THEN RETURN request_row; END IF;

  SELECT * INTO request_row
  FROM public.message_requests
  WHERE requester_id = current_user_id AND recipient_id = p_recipient_id
  FOR UPDATE;

  IF FOUND THEN
    IF request_row.status IN ('pending', 'accepted') THEN
      RETURN request_row;
    END IF;
  END IF;

  -- A rejected/cancelled request is history. A new attempt gets a new row so
  -- the tamper-prevention trigger can keep completed rows immutable.
  INSERT INTO public.message_requests (requester_id, recipient_id, message)
  VALUES (current_user_id, p_recipient_id, clean_message)
  RETURNING * INTO request_row;
  RETURN request_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_message_request(p_request_id uuid)
RETURNS public.message_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  request_row public.message_requests;
  low_user uuid;
  high_user uuid;
  existing_chat_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  SELECT * INTO request_row FROM public.message_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR request_row.recipient_id <> auth.uid() OR request_row.status <> 'pending' THEN
    RAISE EXCEPTION 'Message request is not available.';
  END IF;

  UPDATE public.message_requests
  SET status = 'accepted', responded_at = now(), responded_by = auth.uid()
  WHERE id = request_row.id
  RETURNING * INTO request_row;

  low_user := LEAST(request_row.requester_id, request_row.recipient_id);
  high_user := GREATEST(request_row.requester_id, request_row.recipient_id);

  SELECT id INTO existing_chat_id
  FROM public.private_chats
  WHERE (user_one = low_user AND user_two = high_user)
     OR (user_one = high_user AND user_two = low_user)
  LIMIT 1;

  IF existing_chat_id IS NULL THEN
    PERFORM set_config('app.omnilume_message_accept', 'true', true);
    INSERT INTO public.private_chats (user_one, user_two)
    VALUES (low_user, high_user);
  END IF;

  RETURN request_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_message_request(p_request_id uuid)
RETURNS public.message_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  request_row public.message_requests;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  SELECT * INTO request_row FROM public.message_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR request_row.recipient_id <> auth.uid() OR request_row.status <> 'pending' THEN
    RAISE EXCEPTION 'Message request is not available.';
  END IF;
  UPDATE public.message_requests
  SET status = 'rejected', responded_at = now(), responded_by = auth.uid()
  WHERE id = request_row.id
  RETURNING * INTO request_row;
  RETURN request_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_message_request(p_request_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE public.message_requests
  SET status = 'cancelled', responded_at = now(), responded_by = auth.uid()
  WHERE id = p_request_id AND requester_id = auth.uid() AND status = 'pending';
  RETURN FOUND;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. RLS and grants
-- ---------------------------------------------------------------------------

ALTER TABLE public.message_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "message_requests_select_involved" ON public.message_requests;
CREATE POLICY "message_requests_select_involved"
ON public.message_requests FOR SELECT TO authenticated
USING (auth.uid() = requester_id OR auth.uid() = recipient_id);

-- Mutations happen exclusively through the authorization functions above.
-- No direct client INSERT/UPDATE/DELETE is granted for message requests.
REVOKE ALL ON TABLE public.message_requests FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.message_requests FROM authenticated;
GRANT SELECT ON TABLE public.message_requests TO authenticated;

-- Private-chat participation alone is not enough to send a new message. This
-- preserves old readable chat history while preventing an old chat container
-- from bypassing a rejected/pending request.
DROP POLICY IF EXISTS "Users can insert messages" ON public.messages;
CREATE POLICY "Users can insert messages"
ON public.messages FOR INSERT TO authenticated
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
    AND public.room_has_active_access(room_id)
    AND public.is_approved_room_member(room_id, auth.uid())
  )
);

REVOKE ALL ON FUNCTION public.send_message_request(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.accept_message_request(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reject_message_request(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_message_request(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.prevent_message_request_tampering() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_private_chat_creation() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.send_message_request(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_message_request(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_message_request(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_message_request(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Read performance for the private-chat message feed
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS messages_chat_id_idx ON public.messages USING btree (chat_id);
