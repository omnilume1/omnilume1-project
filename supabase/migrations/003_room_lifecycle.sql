-- Room lifecycle hardening (Action 8)
--
-- This migration makes expiry an authorization boundary and stores recovery
-- requests. Irreversible storage cleanup is performed by the protected
-- application cleanup endpoint documented alongside this migration.

-- Keep the existing room model, but prevent new rows from having an expiry
-- type that disagrees with the presence of an expiry timestamp. NOT VALID keeps
-- legacy rows from blocking installation; new and changed rows are enforced.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'rooms_expiration_consistency_check'
      AND conrelid = 'public.rooms'::regclass
  ) THEN
    ALTER TABLE public.rooms
      ADD CONSTRAINT rooms_expiration_consistency_check
      CHECK (
        (expiration_type = 'permanent' AND expires_at IS NULL)
        OR
        (expiration_type IN ('recoverable', 'irreversible') AND expires_at IS NOT NULL)
      ) NOT VALID;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.validate_room_expiration()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.expiration_type = 'permanent' THEN
    IF NEW.expires_at IS NOT NULL THEN
      RAISE EXCEPTION 'Permanent rooms cannot have an expiration timestamp.';
    END IF;
  ELSIF NEW.expiration_type IN ('recoverable', 'irreversible') THEN
    IF NEW.expires_at IS NULL OR NEW.expires_at <= now() THEN
      RAISE EXCEPTION 'Temporary rooms require a future expiration timestamp.';
    END IF;
  ELSE
    RAISE EXCEPTION 'Invalid room expiration type.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_room_expiration ON public.rooms;
CREATE TRIGGER validate_room_expiration
BEFORE INSERT OR UPDATE OF expiration_type, expires_at ON public.rooms
FOR EACH ROW
EXECUTE FUNCTION public.validate_room_expiration();

CREATE TABLE IF NOT EXISTS public.recovery_requests (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  room_id uuid NOT NULL,
  requester_id uuid NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
  reviewed_at timestamp with time zone,
  reviewed_by uuid,
  CONSTRAINT recovery_requests_pkey PRIMARY KEY (id),
  CONSTRAINT recovery_requests_status_check CHECK (status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])),
  CONSTRAINT recovery_requests_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE,
  CONSTRAINT recovery_requests_requester_id_fkey FOREIGN KEY (requester_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT recovery_requests_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS recovery_requests_one_pending_per_user
  ON public.recovery_requests (room_id, requester_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS recovery_requests_room_status_idx
  ON public.recovery_requests (room_id, status, created_at DESC);

ALTER TABLE public.recovery_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can request recovery for recoverable rooms" ON public.recovery_requests;
CREATE POLICY "Users can request recovery for recoverable rooms"
ON public.recovery_requests
FOR INSERT TO authenticated
WITH CHECK (
  requester_id = auth.uid()
  AND status = 'pending'
  AND EXISTS (
    SELECT 1
    FROM public.rooms r
    JOIN public.room_members rm ON rm.room_id = r.id
    WHERE r.id = recovery_requests.room_id
      AND r.expiration_type = 'recoverable'
      AND r.expires_at IS NOT NULL
      AND r.expires_at <= now()
      AND rm.user_id = auth.uid()
      AND rm.join_status = 'approved'
  )
);

DROP POLICY IF EXISTS "Requesters and room admins can view recovery requests" ON public.recovery_requests;
CREATE POLICY "Requesters and room admins can view recovery requests"
ON public.recovery_requests
FOR SELECT TO authenticated
USING (
  requester_id = auth.uid()
  OR EXISTS (
    SELECT 1
    FROM public.room_members rm
    WHERE rm.room_id = recovery_requests.room_id
      AND rm.user_id = auth.uid()
      AND rm.role IN ('owner', 'admin')
      AND rm.join_status = 'approved'
  )
);

DROP POLICY IF EXISTS "Room admins can review recovery requests" ON public.recovery_requests;
CREATE POLICY "Room admins can review recovery requests"
ON public.recovery_requests
FOR UPDATE TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.room_members rm
    WHERE rm.room_id = recovery_requests.room_id
      AND rm.user_id = auth.uid()
      AND rm.role IN ('owner', 'admin')
      AND rm.join_status = 'approved'
  )
)
WITH CHECK (
  status IN ('approved', 'rejected')
  AND reviewed_by = auth.uid()
);

-- Do not allow a client to bypass the expiry boundary through the room RPC.
CREATE OR REPLACE FUNCTION public.get_room_by_identifier(identifier text)
RETURNS SETOF public.rooms
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT r.*
  FROM public.rooms r
  WHERE (lower(r.username) = lower(identifier) OR r.id::text = identifier)
    AND (
      r.expires_at IS NULL
      OR r.expires_at > now()
      OR EXISTS (
        SELECT 1
        FROM public.room_members rm
        WHERE rm.room_id = r.id
          AND rm.user_id = auth.uid()
          AND rm.join_status = 'approved'
      )
    )
  LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION public.get_room_by_identifier(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_room_by_identifier(text) TO authenticated;

-- Public discovery and joins must exclude expired temporary rooms.
DROP POLICY IF EXISTS "Public rooms are viewable by everyone" ON public.rooms;
CREATE POLICY "Public active rooms are viewable by everyone"
ON public.rooms
FOR SELECT
USING (NOT is_private AND (expires_at IS NULL OR expires_at > now()));

DROP POLICY IF EXISTS "Authenticated users can create rooms" ON public.rooms;
CREATE POLICY "Authenticated users can create rooms"
ON public.rooms
FOR INSERT TO authenticated
WITH CHECK (
  auth.uid() = created_by
  AND (
    (expiration_type = 'permanent' AND expires_at IS NULL)
    OR
    (expiration_type IN ('recoverable', 'irreversible') AND expires_at IS NOT NULL AND expires_at > now())
  )
);

DROP POLICY IF EXISTS "Owners can update rooms" ON public.rooms;
CREATE POLICY "Owners can update active rooms"
ON public.rooms
FOR UPDATE TO authenticated
USING (auth.uid() = created_by AND (expires_at IS NULL OR expires_at > now()))
WITH CHECK (
  auth.uid() = created_by
  AND (
    (expiration_type = 'permanent' AND expires_at IS NULL)
    OR
    (expiration_type IN ('recoverable', 'irreversible') AND expires_at IS NOT NULL AND expires_at > now())
  )
);

-- Expired rooms cannot be read or written through any room-content table.
DROP POLICY IF EXISTS "Participants read messages" ON public.messages;
CREATE POLICY "Participants read messages"
ON public.messages
FOR SELECT TO authenticated
USING (
  chat_id IS NOT NULL
  AND (auth.uid() = sender_id OR auth.uid() = receiver_id)
);

DROP POLICY IF EXISTS "Room members read room messages" ON public.messages;
CREATE POLICY "Room members read active room messages"
ON public.messages
FOR SELECT TO authenticated
USING (
  room_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.rooms r
    JOIN public.room_members rm ON rm.room_id = r.id
    WHERE r.id = messages.room_id
      AND (r.expires_at IS NULL OR r.expires_at > now())
      AND rm.user_id = auth.uid()
      AND rm.join_status = 'approved'
  )
);

DROP POLICY IF EXISTS "Users can insert messages" ON public.messages;
CREATE POLICY "Users can insert messages"
ON public.messages
FOR INSERT TO authenticated
WITH CHECK (
  (
    chat_id IS NOT NULL
    AND auth.uid() = sender_id
    AND EXISTS (
      SELECT 1 FROM public.private_chats pc
      WHERE pc.id = messages.chat_id
        AND (pc.user_one = auth.uid() OR pc.user_two = auth.uid())
    )
  )
  OR
  (
    room_id IS NOT NULL
    AND auth.uid() = sender_id
    AND EXISTS (
      SELECT 1 FROM public.rooms r
      JOIN public.room_members rm ON rm.room_id = r.id
      WHERE r.id = messages.room_id
        AND (r.expires_at IS NULL OR r.expires_at > now())
        AND rm.user_id = auth.uid()
        AND rm.join_status = 'approved'
    )
  )
);

DROP POLICY IF EXISTS "Room members can read room messages" ON public.room_messages;
CREATE POLICY "Room members can read active room messages"
ON public.room_messages
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.rooms r
    JOIN public.room_members rm ON rm.room_id = r.id
    WHERE r.id = room_messages.room_id
      AND (r.expires_at IS NULL OR r.expires_at > now())
      AND rm.user_id = auth.uid()
      AND rm.join_status = 'approved'
  )
);

DROP POLICY IF EXISTS "Room members can send room messages" ON public.room_messages;
CREATE POLICY "Room members can send active room messages"
ON public.room_messages
FOR INSERT TO authenticated
WITH CHECK (
  auth.uid() = user_id
  AND EXISTS (
    SELECT 1 FROM public.rooms r
    JOIN public.room_members rm ON rm.room_id = r.id
    WHERE r.id = room_messages.room_id
      AND (r.expires_at IS NULL OR r.expires_at > now())
      AND rm.user_id = auth.uid()
      AND rm.join_status = 'approved'
  )
);

DROP POLICY IF EXISTS "Anyone can view reactions" ON public.message_reactions;
CREATE POLICY "Approved members can view active room reactions"
ON public.message_reactions
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.room_messages msg
    JOIN public.rooms r ON r.id = msg.room_id
    JOIN public.room_members rm ON rm.room_id = r.id
    WHERE msg.id = message_reactions.message_id
      AND (r.expires_at IS NULL OR r.expires_at > now())
      AND rm.user_id = auth.uid()
      AND rm.join_status = 'approved'
  )
);

DROP POLICY IF EXISTS "Users can manage their own reactions" ON public.message_reactions;
CREATE POLICY "Users can manage reactions in active rooms"
ON public.message_reactions
FOR ALL TO authenticated
USING (
  auth.uid() = user_id
  AND EXISTS (
    SELECT 1
    FROM public.room_messages msg
    JOIN public.rooms r ON r.id = msg.room_id
    JOIN public.room_members rm ON rm.room_id = r.id
    WHERE msg.id = message_reactions.message_id
      AND (r.expires_at IS NULL OR r.expires_at > now())
      AND rm.user_id = auth.uid()
      AND rm.join_status = 'approved'
  )
)
WITH CHECK (
  auth.uid() = user_id
  AND EXISTS (
    SELECT 1
    FROM public.room_messages msg
    JOIN public.rooms r ON r.id = msg.room_id
    JOIN public.room_members rm ON rm.room_id = r.id
    WHERE msg.id = message_reactions.message_id
      AND (r.expires_at IS NULL OR r.expires_at > now())
      AND rm.user_id = auth.uid()
      AND rm.join_status = 'approved'
  )
);

DROP POLICY IF EXISTS "Approved room members can view temporary media" ON public.temporary_media;
CREATE POLICY "Approved members can view active temporary media"
ON public.temporary_media
FOR SELECT TO authenticated
USING (
  expires_at > now()
  AND EXISTS (
    SELECT 1 FROM public.rooms r
    JOIN public.room_members rm ON rm.room_id = r.id
    WHERE r.id = temporary_media.room_id
      AND (r.expires_at IS NULL OR r.expires_at > now())
      AND rm.user_id = auth.uid()
      AND rm.join_status = 'approved'
  )
);

DROP POLICY IF EXISTS "Approved room members can upload temporary media" ON public.temporary_media;
CREATE POLICY "Approved members can upload active temporary media"
ON public.temporary_media
FOR INSERT TO authenticated
WITH CHECK (
  auth.uid() = user_id
  AND expires_at > now()
  AND EXISTS (
    SELECT 1 FROM public.rooms r
    JOIN public.room_members rm ON rm.room_id = r.id
    WHERE r.id = temporary_media.room_id
      AND (r.expires_at IS NULL OR r.expires_at > now())
      AND rm.user_id = auth.uid()
      AND rm.join_status = 'approved'
  )
);

DROP POLICY IF EXISTS "users manage own study sessions" ON public.study_sessions;
CREATE POLICY "Users manage study sessions in active rooms"
ON public.study_sessions
FOR ALL TO authenticated
USING (
  auth.uid() = user_id
  AND (
    room_id IS NULL
    OR EXISTS (
      SELECT 1 FROM public.rooms r
      JOIN public.room_members rm ON rm.room_id = r.id
      WHERE r.id = study_sessions.room_id
        AND (r.expires_at IS NULL OR r.expires_at > now())
        AND rm.user_id = auth.uid()
        AND rm.join_status = 'approved'
    )
  )
)
WITH CHECK (
  auth.uid() = user_id
  AND (
    room_id IS NULL
    OR EXISTS (
      SELECT 1 FROM public.rooms r
      JOIN public.room_members rm ON rm.room_id = r.id
      WHERE r.id = study_sessions.room_id
        AND (r.expires_at IS NULL OR r.expires_at > now())
        AND rm.user_id = auth.uid()
        AND rm.join_status = 'approved'
    )
  )
);

-- Joining and approving users after expiry must be rejected.
DROP POLICY IF EXISTS "Users can request to join rooms" ON public.room_members;
CREATE POLICY "Users can request to join active rooms"
ON public.room_members
FOR INSERT TO authenticated
WITH CHECK (
  auth.uid() = user_id
  AND (
    (
      role = 'member' AND join_status = 'pending'
      AND EXISTS (
        SELECT 1 FROM public.rooms r
        WHERE r.id = room_members.room_id
          AND (r.expires_at IS NULL OR r.expires_at > now())
      )
    )
    OR (
      role = 'owner' AND join_status = 'approved'
      AND EXISTS (
        SELECT 1 FROM public.rooms r
        WHERE r.id = room_members.room_id
          AND r.created_by = auth.uid()
          AND (r.expires_at IS NULL OR r.expires_at > now())
      )
    )
    OR (
      role = 'member' AND join_status = 'approved'
      AND EXISTS (
        SELECT 1 FROM public.rooms r
        WHERE r.id = room_members.room_id
          AND NOT r.is_private
          AND (r.expires_at IS NULL OR r.expires_at > now())
      )
    )
  )
);

-- Storage access must stop at room expiry as well as requiring membership.
DROP POLICY IF EXISTS "Room members can read attachments" ON storage.objects;
CREATE POLICY "Members can read active room attachments"
ON storage.objects
FOR SELECT TO authenticated
USING (
  bucket_id = 'room_attachments'
  AND EXISTS (
    SELECT 1 FROM public.rooms r
    JOIN public.room_members rm ON rm.room_id = r.id
    WHERE r.id = (storage.foldername(name))[1]::uuid
      AND (r.expires_at IS NULL OR r.expires_at > now())
      AND rm.user_id = auth.uid()
      AND rm.join_status = 'approved'
  )
);

DROP POLICY IF EXISTS "Room members can upload attachments" ON storage.objects;
CREATE POLICY "Members can upload active room attachments"
ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'room_attachments'
  AND EXISTS (
    SELECT 1 FROM public.rooms r
    JOIN public.room_members rm ON rm.room_id = r.id
    WHERE r.id = (storage.foldername(name))[1]::uuid
      AND (r.expires_at IS NULL OR r.expires_at > now())
      AND rm.user_id = auth.uid()
      AND rm.join_status = 'approved'
  )
);

DROP POLICY IF EXISTS "Room members can delete attachments" ON storage.objects;
CREATE POLICY "Members can delete active room attachments"
ON storage.objects
FOR DELETE TO authenticated
USING (
  bucket_id = 'room_attachments'
  AND EXISTS (
    SELECT 1 FROM public.rooms r
    JOIN public.room_members rm ON rm.room_id = r.id
    WHERE r.id = (storage.foldername(name))[1]::uuid
      AND (r.expires_at IS NULL OR r.expires_at > now())
      AND rm.user_id = auth.uid()
      AND rm.join_status = 'approved'
  )
);

COMMENT ON TABLE public.recovery_requests IS 'Persistent recovery requests for expired recoverable rooms; processed by authorized room owners/admins.';
