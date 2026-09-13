-- Action 3: bound chat history queries and message payloads.
-- NOT VALID keeps this additive migration safe for existing legacy rows while
-- enforcing the limits on every new insert. Existing rows can be validated or
-- repaired separately after an application-specific data review.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.messages'::regclass
      AND conname = 'messages_room_content_length_check'
  ) THEN
    ALTER TABLE public.messages
      ADD CONSTRAINT messages_room_content_length_check
      CHECK (
        room_id IS NULL
        OR content IS NULL
        OR char_length(btrim(content)) BETWEEN 1 AND 2000
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.messages'::regclass
      AND conname = 'messages_private_encrypted_payload_check'
  ) THEN
    ALTER TABLE public.messages
      ADD CONSTRAINT messages_private_encrypted_payload_check
      CHECK (
        chat_id IS NULL
        OR (
          ciphertext IS NOT NULL
          AND iv IS NOT NULL
          AND char_length(ciphertext) BETWEEN 24 AND 32768
          AND char_length(ciphertext) % 4 = 0
          AND ciphertext ~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
          AND char_length(iv) = 16
          AND iv ~ '^[A-Za-z0-9+/]{16}$'
        )
      ) NOT VALID;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS messages_room_created_id_idx
  ON public.messages (room_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS messages_chat_created_id_idx
  ON public.messages (chat_id, created_at DESC, id DESC);
