-- Final security and room-lifecycle remediation.
--
-- This migration is intentionally data-preserving. It closes the legacy public
-- policies left by 002/003, adds the minimum lifecycle state needed to
-- distinguish the original expiry from a seven-day reopened period, and puts
-- recovery/permanent conversion behind server-authorized database functions.

ALTER TABLE public.rooms
  ADD COLUMN IF NOT EXISTS reopened_until timestamp with time zone;

CREATE TABLE IF NOT EXISTS public.room_permanent_requests (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  room_id uuid NOT NULL,
  requester_id uuid NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
  reviewed_at timestamp with time zone,
  reviewed_by uuid,
  CONSTRAINT room_permanent_requests_pkey PRIMARY KEY (id),
  CONSTRAINT room_permanent_requests_status_check CHECK (status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])),
  CONSTRAINT room_permanent_requests_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE,
  CONSTRAINT room_permanent_requests_requester_id_fkey FOREIGN KEY (requester_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT room_permanent_requests_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS room_permanent_requests_one_pending
  ON public.room_permanent_requests (room_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS room_permanent_requests_room_status_idx
  ON public.room_permanent_requests (room_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.room_notifications (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  room_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  notification_type text NOT NULL,
  message text NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
  read_at timestamp with time zone,
  CONSTRAINT room_notifications_pkey PRIMARY KEY (id),
  CONSTRAINT room_notifications_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE,
  CONSTRAINT room_notifications_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT room_notifications_type_check CHECK (notification_type <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS room_notifications_unique_conversion
  ON public.room_notifications (room_id, recipient_id, notification_type);

CREATE INDEX IF NOT EXISTS room_notifications_recipient_created_idx
  ON public.room_notifications (recipient_id, created_at DESC);

ALTER TABLE public.room_permanent_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_notifications ENABLE ROW LEVEL SECURITY;

-- SECURITY DEFINER helpers are kept small, stable, and explicitly scoped to
-- public so policy evaluation cannot recurse through the caller's RLS view.
CREATE OR REPLACE FUNCTION public.is_approved_room_member(p_room_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.room_members rm
    WHERE rm.room_id = p_room_id
      AND rm.user_id = p_user_id
      AND rm.join_status = 'approved'
  );
$$;

CREATE OR REPLACE FUNCTION public.is_room_admin_or_owner(p_room_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.room_members rm
    WHERE rm.room_id = p_room_id
      AND rm.user_id = p_user_id
      AND rm.join_status = 'approved'
      AND rm.role IN ('owner', 'admin')
  );
$$;

CREATE OR REPLACE FUNCTION public.room_in_recovery_window(p_room_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.rooms r
    WHERE r.id = p_room_id
      AND r.expiration_type = 'recoverable'
      AND r.expires_at IS NOT NULL
      AND r.expires_at <= now()
      AND (r.reopened_until IS NULL OR r.reopened_until <= now())
      AND now() <= r.expires_at + interval '24 hours'
  );
$$;

CREATE OR REPLACE FUNCTION public.room_has_active_access(p_room_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.rooms r
    WHERE r.id = p_room_id
      AND (
        r.expiration_type = 'permanent'
        OR (r.expires_at IS NOT NULL AND r.expires_at > now())
        OR (r.reopened_until IS NOT NULL AND r.reopened_until > now())
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.prevent_room_membership_escalation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.room_id IS DISTINCT FROM OLD.room_id OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'Room membership identity cannot change.';
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'Room membership roles cannot be changed through this operation.';
  END IF;

  IF NEW.join_status NOT IN ('pending', 'approved', 'rejected') THEN
    RAISE EXCEPTION 'Invalid room membership status.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_room_membership_escalation ON public.room_members;
CREATE TRIGGER prevent_room_membership_escalation
BEFORE UPDATE ON public.room_members
FOR EACH ROW
EXECUTE FUNCTION public.prevent_room_membership_escalation();

CREATE OR REPLACE FUNCTION public.prevent_message_scope_changes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.sender_id IS DISTINCT FROM OLD.sender_id
     OR NEW.room_id IS DISTINCT FROM OLD.room_id
     OR NEW.chat_id IS DISTINCT FROM OLD.chat_id THEN
    RAISE EXCEPTION 'Message ownership and scope cannot change.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_message_scope_changes ON public.messages;
CREATE TRIGGER prevent_message_scope_changes
BEFORE UPDATE ON public.messages
FOR EACH ROW
EXECUTE FUNCTION public.prevent_message_scope_changes();

CREATE OR REPLACE FUNCTION public.prevent_unauthorized_expired_conversion()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF OLD.expiration_type <> 'permanent'
     AND NEW.expiration_type = 'permanent'
     AND OLD.expires_at IS NOT NULL
     AND OLD.expires_at <= now()
     AND current_setting('app.omnilume_lifecycle_authorized', true) <> 'permanent_conversion' THEN
    RAISE EXCEPTION 'Expired rooms can only become permanent through an approved conversion.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_unauthorized_reopen()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.reopened_until IS DISTINCT FROM OLD.reopened_until
     AND current_setting('app.omnilume_lifecycle_authorized', true) NOT IN ('recovery_approval', 'permanent_conversion') THEN
    RAISE EXCEPTION 'Room reopen dates can only be set by approved recovery.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_unauthorized_expired_conversion ON public.rooms;
CREATE TRIGGER prevent_unauthorized_expired_conversion
BEFORE UPDATE OF expiration_type, expires_at ON public.rooms
FOR EACH ROW
EXECUTE FUNCTION public.prevent_unauthorized_expired_conversion();

DROP TRIGGER IF EXISTS prevent_unauthorized_reopen ON public.rooms;
CREATE TRIGGER prevent_unauthorized_reopen
BEFORE UPDATE OF reopened_until ON public.rooms
FOR EACH ROW
EXECUTE FUNCTION public.prevent_unauthorized_reopen();

CREATE OR REPLACE FUNCTION public.prevent_recovery_request_tampering()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.room_id IS DISTINCT FROM OLD.room_id
     OR NEW.requester_id IS DISTINCT FROM OLD.requester_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Recovery request identity cannot change.';
  END IF;

  IF OLD.status <> 'pending' OR NEW.status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Recovery requests only allow pending to approved or rejected.';
  END IF;

  IF NEW.reviewed_at IS NULL OR NEW.reviewed_by IS NULL THEN
    RAISE EXCEPTION 'Reviewed recovery requests require reviewer audit fields.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_recovery_request_tampering ON public.recovery_requests;
CREATE TRIGGER prevent_recovery_request_tampering
BEFORE UPDATE ON public.recovery_requests
FOR EACH ROW
EXECUTE FUNCTION public.prevent_recovery_request_tampering();

CREATE OR REPLACE FUNCTION public.prevent_permanent_request_tampering()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.room_id IS DISTINCT FROM OLD.room_id
     OR NEW.requester_id IS DISTINCT FROM OLD.requester_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Permanent-room request identity cannot change.';
  END IF;

  IF OLD.status <> 'pending' OR NEW.status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Permanent-room requests only allow pending to approved or rejected.';
  END IF;

  IF NEW.reviewed_at IS NULL OR NEW.reviewed_by IS NULL THEN
    RAISE EXCEPTION 'Reviewed permanent-room requests require reviewer audit fields.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_permanent_request_tampering ON public.room_permanent_requests;
CREATE TRIGGER prevent_permanent_request_tampering
BEFORE UPDATE ON public.room_permanent_requests
FOR EACH ROW
EXECUTE FUNCTION public.prevent_permanent_request_tampering();

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
      (
        public.room_has_active_access(r.id)
        AND (
          NOT r.is_private
          OR public.is_approved_room_member(r.id, auth.uid())
          OR (r.created_by = auth.uid())
        )
      )
      OR (
        public.room_in_recovery_window(r.id)
        AND public.is_room_admin_or_owner(r.id, auth.uid())
      )
    )
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.get_room_for_join(identifier text)
RETURNS TABLE (
  id uuid,
  is_private boolean,
  expiration_type text,
  expires_at timestamp with time zone,
  reopened_until timestamp with time zone
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT r.id, r.is_private, r.expiration_type, r.expires_at, r.reopened_until
  FROM public.rooms r
  WHERE (lower(r.username) = lower(identifier) OR r.id::text = identifier)
    AND public.room_has_active_access(r.id)
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.review_recovery_request(p_request_id uuid, p_decision text)
RETURNS public.recovery_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  request_row public.recovery_requests;
BEGIN
  IF auth.uid() IS NULL OR p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Unauthorized recovery decision.';
  END IF;

  SELECT rr.*
  INTO request_row
  FROM public.recovery_requests rr
  WHERE rr.id = p_request_id
  FOR UPDATE;

  IF NOT FOUND
     OR request_row.status <> 'pending'
     OR NOT public.room_in_recovery_window(request_row.room_id)
     OR NOT public.is_room_admin_or_owner(request_row.room_id, auth.uid()) THEN
    RAISE EXCEPTION 'Recovery request is not available for this reviewer.';
  END IF;

  UPDATE public.recovery_requests
  SET status = p_decision,
      reviewed_at = now(),
      reviewed_by = auth.uid()
  WHERE id = p_request_id
  RETURNING * INTO request_row;

  IF p_decision = 'approved' THEN
    PERFORM set_config('app.omnilume_lifecycle_authorized', 'recovery_approval', true);
    UPDATE public.rooms
    SET reopened_until = now() + interval '7 days'
    WHERE id = request_row.room_id
      AND expiration_type = 'recoverable';
  END IF;

  RETURN request_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.review_permanent_room_request(p_request_id uuid, p_decision text)
RETURNS public.room_permanent_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  request_row public.room_permanent_requests;
  requester_label text;
BEGIN
  IF auth.uid() IS NULL OR p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Unauthorized permanent-room decision.';
  END IF;

  SELECT rpr.*
  INTO request_row
  FROM public.room_permanent_requests rpr
  WHERE rpr.id = p_request_id
  FOR UPDATE;

  IF NOT FOUND
     OR request_row.status <> 'pending'
     OR NOT public.room_has_active_access(request_row.room_id)
     OR NOT EXISTS (
       SELECT 1
       FROM public.rooms r
       WHERE r.id = request_row.room_id
         AND r.expiration_type = 'recoverable'
         AND r.reopened_until IS NOT NULL
         AND r.reopened_until > now()
     )
     OR NOT public.is_room_admin_or_owner(request_row.room_id, auth.uid()) THEN
    RAISE EXCEPTION 'Permanent-room request is not available for this reviewer.';
  END IF;

  UPDATE public.room_permanent_requests
  SET status = p_decision,
      reviewed_at = now(),
      reviewed_by = auth.uid()
  WHERE id = p_request_id
  RETURNING * INTO request_row;

  IF p_decision = 'approved' THEN
    requester_label := 'User ' || request_row.requester_id::text;

    PERFORM set_config('app.omnilume_lifecycle_authorized', 'permanent_conversion', true);
    UPDATE public.rooms
    SET expiration_type = 'permanent',
        expires_at = NULL,
        reopened_until = NULL
    WHERE id = request_row.room_id;

    INSERT INTO public.room_notifications (
      room_id,
      recipient_id,
      notification_type,
      message,
      metadata
    )
    SELECT DISTINCT request_row.room_id,
      recipients.user_id,
      'permanent_conversion',
      requester_label || ' requested this room to become permanent. The request was approved, and the room is now permanent and available indefinitely.',
      jsonb_build_object(
        'requester_id', request_row.requester_id,
        'request_id', request_row.id,
        'status', 'permanent'
      )
    FROM (
      SELECT rm.user_id
      FROM public.room_members rm
      WHERE rm.room_id = request_row.room_id
        AND rm.join_status = 'approved'
      UNION
      SELECT m.sender_id
      FROM public.messages m
      WHERE m.room_id = request_row.room_id
      UNION
      SELECT m.receiver_id
      FROM public.messages m
      WHERE m.room_id = request_row.room_id
        AND m.receiver_id IS NOT NULL
      UNION
      SELECT rm2.user_id
      FROM public.room_messages rm2
      WHERE rm2.room_id = request_row.room_id
      UNION
      SELECT ss.user_id
      FROM public.study_sessions ss
      WHERE ss.room_id = request_row.room_id
        AND ss.user_id IS NOT NULL
      UNION
      SELECT tm.user_id
      FROM public.temporary_media tm
      WHERE tm.room_id = request_row.room_id
        AND tm.user_id IS NOT NULL
    ) recipients
    WHERE recipients.user_id IS NOT NULL
    ON CONFLICT (room_id, recipient_id, notification_type) DO NOTHING;
  END IF;

  RETURN request_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.convert_active_room_to_permanent(p_room_id uuid, p_username text DEFAULT NULL)
RETURNS public.rooms
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  room_row public.rooms;
  clean_username text;
  room_expiration_type text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_room_admin_or_owner(p_room_id, auth.uid()) THEN
    RAISE EXCEPTION 'Only an approved room owner or admin can convert this room.';
  END IF;

  IF NOT public.room_has_active_access(p_room_id) THEN
    RAISE EXCEPTION 'The room is not currently active.';
  END IF;

  SELECT expiration_type INTO room_expiration_type
  FROM public.rooms
  WHERE id = p_room_id;
  IF room_expiration_type IS DISTINCT FROM 'recoverable' THEN
    RAISE EXCEPTION 'Only recoverable rooms can be converted through this workflow.';
  END IF;

  clean_username := NULLIF(lower(regexp_replace(COALESCE(p_username, ''), '[^a-z0-9_.]', '', 'g')), '');
  PERFORM set_config('app.omnilume_lifecycle_authorized', 'permanent_conversion', true);

  UPDATE public.rooms
  SET is_group = true,
      expiration_type = 'permanent',
      expires_at = NULL,
      reopened_until = NULL,
      username = COALESCE(clean_username, username)
  WHERE id = p_room_id
  RETURNING * INTO room_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Room not found.';
  END IF;

  INSERT INTO public.room_notifications (room_id, recipient_id, notification_type, message, metadata)
  SELECT DISTINCT p_room_id,
    recipients.user_id,
    'permanent_conversion',
    'User ' || auth.uid()::text || ' converted this room to permanent. The room is now available indefinitely.',
    jsonb_build_object('requester_id', auth.uid(), 'status', 'permanent')
  FROM (
    SELECT rm.user_id FROM public.room_members rm WHERE rm.room_id = p_room_id AND rm.join_status = 'approved'
    UNION SELECT m.sender_id FROM public.messages m WHERE m.room_id = p_room_id
    UNION SELECT m.receiver_id FROM public.messages m WHERE m.room_id = p_room_id AND m.receiver_id IS NOT NULL
    UNION SELECT rm2.user_id FROM public.room_messages rm2 WHERE rm2.room_id = p_room_id
    UNION SELECT ss.user_id FROM public.study_sessions ss WHERE ss.room_id = p_room_id AND ss.user_id IS NOT NULL
    UNION SELECT tm.user_id FROM public.temporary_media tm WHERE tm.room_id = p_room_id AND tm.user_id IS NOT NULL
  ) recipients
  WHERE recipients.user_id IS NOT NULL
  ON CONFLICT (room_id, recipient_id, notification_type) DO NOTHING;

  RETURN room_row;
END;
$$;

REVOKE ALL ON FUNCTION public.is_approved_room_member(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_room_admin_or_owner(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.room_in_recovery_window(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.room_has_active_access(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_room_by_identifier(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_room_for_join(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.review_recovery_request(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.review_permanent_room_request(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.convert_active_room_to_permanent(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_unauthorized_reopen() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_room_expiration() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_approved_room_member(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_room_admin_or_owner(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.room_in_recovery_window(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.room_has_active_access(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_room_by_identifier(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_room_for_join(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.review_recovery_request(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.review_permanent_room_request(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.convert_active_room_to_permanent(uuid, text) TO authenticated;

-- Remove legacy broad access and recreate policies around current membership
-- and the server-time lifecycle helper.
DROP POLICY IF EXISTS "Members viewable by everyone" ON public.room_members;
DROP POLICY IF EXISTS "members read room membership" ON public.room_members;
DROP POLICY IF EXISTS "Owners can update members" ON public.room_members;
DROP POLICY IF EXISTS "Owners can delete members" ON public.room_members;
DROP POLICY IF EXISTS "Users can update own membership status" ON public.room_members;
DROP POLICY IF EXISTS "users leave rooms" ON public.room_members;
DROP POLICY IF EXISTS "Users can request to join active rooms" ON public.room_members;
DROP POLICY IF EXISTS "Users can request to join rooms" ON public.room_members;
DROP POLICY IF EXISTS "Approved members can view active room membership" ON public.room_members;
DROP POLICY IF EXISTS "Recovery managers can view room membership" ON public.room_members;
DROP POLICY IF EXISTS "Owners and admins manage active membership" ON public.room_members;
DROP POLICY IF EXISTS "Owners and admins can remove active members" ON public.room_members;
DROP POLICY IF EXISTS "Users can leave active rooms" ON public.room_members;

CREATE POLICY "Approved members can view active room membership"
ON public.room_members FOR SELECT TO authenticated
USING (
  public.room_has_active_access(room_id)
  AND public.is_approved_room_member(room_id, auth.uid())
);

CREATE POLICY "Recovery managers can view room membership"
ON public.room_members FOR SELECT TO authenticated
USING (
  public.room_in_recovery_window(room_id)
  AND public.is_room_admin_or_owner(room_id, auth.uid())
);

CREATE POLICY "Users can request to join active rooms"
ON public.room_members FOR INSERT TO authenticated
WITH CHECK (
  auth.uid() = user_id
  AND public.room_has_active_access(room_id)
  AND (
    (
      role = 'owner'
      AND join_status = 'approved'
      AND EXISTS (SELECT 1 FROM public.rooms r WHERE r.id = room_members.room_id AND r.created_by = auth.uid())
    )
    OR
    (
      role = 'member'
      AND join_status IN ('pending', 'approved')
      AND (join_status = 'pending' OR EXISTS (
        SELECT 1 FROM public.rooms r WHERE r.id = room_members.room_id AND r.is_private = false
      ))
    )
  )
);

CREATE POLICY "Owners and admins manage active membership"
ON public.room_members FOR UPDATE TO authenticated
USING (
  public.room_has_active_access(room_id)
  AND public.is_room_admin_or_owner(room_id, auth.uid())
  AND user_id <> auth.uid()
)
WITH CHECK (
  public.room_has_active_access(room_id)
  AND public.is_room_admin_or_owner(room_id, auth.uid())
  AND role IN ('member', 'admin', 'owner')
  AND join_status IN ('pending', 'approved', 'rejected')
);

CREATE POLICY "Users can update own membership status"
ON public.room_members FOR UPDATE TO authenticated
USING (auth.uid() = user_id AND public.room_has_active_access(room_id))
WITH CHECK (
  auth.uid() = user_id
  AND public.room_has_active_access(room_id)
  AND join_status IN ('pending', 'rejected')
);

CREATE POLICY "Owners and admins can remove active members"
ON public.room_members FOR DELETE TO authenticated
USING (
  public.room_has_active_access(room_id)
  AND public.is_room_admin_or_owner(room_id, auth.uid())
  AND user_id <> auth.uid()
  AND role <> 'owner'
);

CREATE POLICY "Users can leave active rooms"
ON public.room_members FOR DELETE TO authenticated
USING (auth.uid() = user_id AND public.room_has_active_access(room_id));

DROP POLICY IF EXISTS "Creators can view their own rooms" ON public.rooms;
DROP POLICY IF EXISTS "Members can view rooms they joined" ON public.rooms;
DROP POLICY IF EXISTS "Public active rooms are viewable by everyone" ON public.rooms;
DROP POLICY IF EXISTS "Public rooms are viewable by everyone" ON public.rooms;
DROP POLICY IF EXISTS "Owners can update active rooms" ON public.rooms;
DROP POLICY IF EXISTS "Owners can update rooms" ON public.rooms;
DROP POLICY IF EXISTS "Authorized users can view active rooms" ON public.rooms;
DROP POLICY IF EXISTS "Recovery managers can view expired rooms" ON public.rooms;
DROP POLICY IF EXISTS "Public active rooms are viewable by everyone" ON public.rooms;

CREATE POLICY "Authorized users can view active rooms"
ON public.rooms FOR SELECT TO authenticated
USING (
  public.room_has_active_access(id)
  AND (
    NOT is_private
    OR created_by = auth.uid()
    OR public.is_approved_room_member(id, auth.uid())
  )
);

CREATE POLICY "Recovery managers can view expired rooms"
ON public.rooms FOR SELECT TO authenticated
USING (public.room_in_recovery_window(id) AND public.is_room_admin_or_owner(id, auth.uid()));

CREATE POLICY "Public active rooms are viewable by everyone"
ON public.rooms FOR SELECT TO anon, authenticated
USING (NOT is_private AND public.room_has_active_access(id));

CREATE POLICY "Owners can update active rooms"
ON public.rooms FOR UPDATE TO authenticated
USING (auth.uid() = created_by AND public.room_has_active_access(id))
WITH CHECK (auth.uid() = created_by);

DROP POLICY IF EXISTS "Users can update own messages" ON public.messages;
DROP POLICY IF EXISTS "Approved senders can update active room messages" ON public.messages;
DROP POLICY IF EXISTS "Participants read private messages" ON public.messages;
CREATE POLICY "Approved senders can update active room messages"
ON public.messages FOR UPDATE TO authenticated
USING (
  room_id IS NOT NULL
  AND sender_id = auth.uid()
  AND public.room_has_active_access(room_id)
  AND public.is_approved_room_member(room_id, auth.uid())
)
WITH CHECK (
  room_id IS NOT NULL
  AND sender_id = auth.uid()
  AND public.room_has_active_access(room_id)
  AND public.is_approved_room_member(room_id, auth.uid())
);

DROP POLICY IF EXISTS "Participants read messages" ON public.messages;
CREATE POLICY "Participants read private messages"
ON public.messages FOR SELECT TO authenticated
USING (
  chat_id IS NOT NULL
  AND (auth.uid() = sender_id OR auth.uid() = receiver_id)
);

DROP POLICY IF EXISTS "Room members read active room messages" ON public.messages;
DROP POLICY IF EXISTS "Room members read room messages" ON public.messages;
DROP POLICY IF EXISTS "Approved members read active room messages" ON public.messages;
CREATE POLICY "Approved members read active room messages"
ON public.messages FOR SELECT TO authenticated
USING (room_id IS NOT NULL AND public.room_has_active_access(room_id) AND public.is_approved_room_member(room_id, auth.uid()));

DROP POLICY IF EXISTS "Users can insert messages" ON public.messages;
CREATE POLICY "Users can insert messages"
ON public.messages FOR INSERT TO authenticated
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
    AND public.room_has_active_access(room_id)
    AND public.is_approved_room_member(room_id, auth.uid())
  )
);

DROP POLICY IF EXISTS "Room members read active room messages" ON public.room_messages;
DROP POLICY IF EXISTS "Room members can read active room messages" ON public.room_messages;
DROP POLICY IF EXISTS "Room members can read room messages" ON public.room_messages;
DROP POLICY IF EXISTS "Approved members read active room messages" ON public.room_messages;
CREATE POLICY "Approved members read active room messages"
ON public.room_messages FOR SELECT TO authenticated
USING (public.room_has_active_access(room_id) AND public.is_approved_room_member(room_id, auth.uid()));

DROP POLICY IF EXISTS "Room members send active room messages" ON public.room_messages;
DROP POLICY IF EXISTS "Room members can send active room messages" ON public.room_messages;
DROP POLICY IF EXISTS "Room members can send room messages" ON public.room_messages;
DROP POLICY IF EXISTS "Approved members send active room messages" ON public.room_messages;
CREATE POLICY "Approved members send active room messages"
ON public.room_messages FOR INSERT TO authenticated
WITH CHECK (auth.uid() = user_id AND public.room_has_active_access(room_id) AND public.is_approved_room_member(room_id, auth.uid()));

DROP POLICY IF EXISTS "Approved members can view active temporary media" ON public.temporary_media;
DROP POLICY IF EXISTS "Approved room members can view temporary media" ON public.temporary_media;
DROP POLICY IF EXISTS "Approved members can view active temporary media" ON public.temporary_media;
CREATE POLICY "Approved members can view active temporary media"
ON public.temporary_media FOR SELECT TO authenticated
USING (expires_at > now() AND public.room_has_active_access(room_id) AND public.is_approved_room_member(room_id, auth.uid()));

DROP POLICY IF EXISTS "Approved members can upload active temporary media" ON public.temporary_media;
DROP POLICY IF EXISTS "Approved room members can upload temporary media" ON public.temporary_media;
DROP POLICY IF EXISTS "Approved members can upload active temporary media" ON public.temporary_media;
CREATE POLICY "Approved members can upload active temporary media"
ON public.temporary_media FOR INSERT TO authenticated
WITH CHECK (auth.uid() = user_id AND expires_at > now() AND public.room_has_active_access(room_id) AND public.is_approved_room_member(room_id, auth.uid()));

DROP POLICY IF EXISTS "Approved members can view active room reactions" ON public.message_reactions;
DROP POLICY IF EXISTS "Anyone can view reactions" ON public.message_reactions;
DROP POLICY IF EXISTS "Approved members can view active room reactions" ON public.message_reactions;
CREATE POLICY "Approved members can view active room reactions"
ON public.message_reactions FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.room_messages msg
  WHERE msg.id = message_reactions.message_id
    AND public.room_has_active_access(msg.room_id)
    AND public.is_approved_room_member(msg.room_id, auth.uid())
));

DROP POLICY IF EXISTS "Users can manage reactions in active rooms" ON public.message_reactions;
DROP POLICY IF EXISTS "Users can manage their own reactions" ON public.message_reactions;
DROP POLICY IF EXISTS "Users can manage reactions in active rooms" ON public.message_reactions;
CREATE POLICY "Users can manage reactions in active rooms"
ON public.message_reactions FOR ALL TO authenticated
USING (auth.uid() = user_id AND EXISTS (
  SELECT 1 FROM public.room_messages msg
  WHERE msg.id = message_reactions.message_id
    AND public.room_has_active_access(msg.room_id)
    AND public.is_approved_room_member(msg.room_id, auth.uid())
))
WITH CHECK (auth.uid() = user_id AND EXISTS (
  SELECT 1 FROM public.room_messages msg
  WHERE msg.id = message_reactions.message_id
    AND public.room_has_active_access(msg.room_id)
    AND public.is_approved_room_member(msg.room_id, auth.uid())
));

DROP POLICY IF EXISTS "Users manage study sessions in active rooms" ON public.study_sessions;
DROP POLICY IF EXISTS "users manage own study sessions" ON public.study_sessions;
DROP POLICY IF EXISTS "Users manage study sessions in active rooms" ON public.study_sessions;
CREATE POLICY "Users manage study sessions in active rooms"
ON public.study_sessions FOR ALL TO authenticated
USING (auth.uid() = user_id AND (room_id IS NULL OR (public.room_has_active_access(room_id) AND public.is_approved_room_member(room_id, auth.uid()))))
WITH CHECK (auth.uid() = user_id AND (room_id IS NULL OR (public.room_has_active_access(room_id) AND public.is_approved_room_member(room_id, auth.uid()))));

DROP POLICY IF EXISTS "Members can read active room attachments" ON storage.objects;
DROP POLICY IF EXISTS "Room members can read attachments" ON storage.objects;
CREATE POLICY "Members can read active room attachments"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'room_attachments'
  AND public.is_approved_room_member((storage.foldername(storage.objects.name))[1]::uuid, auth.uid())
  AND public.room_has_active_access((storage.foldername(storage.objects.name))[1]::uuid)
);

DROP POLICY IF EXISTS "Members can upload active room attachments" ON storage.objects;
DROP POLICY IF EXISTS "Room members can upload attachments" ON storage.objects;
CREATE POLICY "Members can upload active room attachments"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'room_attachments'
  AND public.is_approved_room_member((storage.foldername(storage.objects.name))[1]::uuid, auth.uid())
  AND public.room_has_active_access((storage.foldername(storage.objects.name))[1]::uuid)
);

DROP POLICY IF EXISTS "Members can delete active room attachments" ON storage.objects;
DROP POLICY IF EXISTS "Room members can delete attachments" ON storage.objects;
CREATE POLICY "Members can delete active room attachments"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'room_attachments'
  AND public.is_approved_room_member((storage.foldername(storage.objects.name))[1]::uuid, auth.uid())
  AND public.room_has_active_access((storage.foldername(storage.objects.name))[1]::uuid)
);

DROP POLICY IF EXISTS "Users can request recovery for recoverable rooms" ON public.recovery_requests;
DROP POLICY IF EXISTS "Requesters and room admins can view recovery requests" ON public.recovery_requests;
DROP POLICY IF EXISTS "Room admins can review recovery requests" ON public.recovery_requests;
DROP POLICY IF EXISTS "Owners and admins can request recovery" ON public.recovery_requests;
DROP POLICY IF EXISTS "Recovery request participants can view requests" ON public.recovery_requests;
DROP POLICY IF EXISTS "Owners and admins can view permanent requests" ON public.room_permanent_requests;
DROP POLICY IF EXISTS "Approved members can request permanence" ON public.room_permanent_requests;
DROP POLICY IF EXISTS "Recipients can read room notifications" ON public.room_notifications;
DROP POLICY IF EXISTS "Recipients can mark notifications read" ON public.room_notifications;

CREATE POLICY "Owners and admins can request recovery"
ON public.recovery_requests FOR INSERT TO authenticated
WITH CHECK (
  requester_id = auth.uid()
  AND status = 'pending'
  AND public.room_in_recovery_window(room_id)
  AND public.is_room_admin_or_owner(room_id, auth.uid())
);

CREATE POLICY "Recovery request participants can view requests"
ON public.recovery_requests FOR SELECT TO authenticated
USING (
  requester_id = auth.uid()
  OR (public.room_in_recovery_window(room_id) AND public.is_room_admin_or_owner(room_id, auth.uid()))
);

CREATE POLICY "Owners and admins can view permanent requests"
ON public.room_permanent_requests FOR SELECT TO authenticated
USING (requester_id = auth.uid() OR (public.room_has_active_access(room_id) AND public.is_room_admin_or_owner(room_id, auth.uid())));

CREATE POLICY "Approved members can request permanence"
ON public.room_permanent_requests FOR INSERT TO authenticated
WITH CHECK (
  requester_id = auth.uid()
  AND status = 'pending'
  AND public.room_has_active_access(room_id)
  AND public.is_approved_room_member(room_id, auth.uid())
  AND EXISTS (
    SELECT 1 FROM public.rooms r
    WHERE r.id = room_id
      AND r.expiration_type = 'recoverable'
      AND r.reopened_until IS NOT NULL
      AND r.reopened_until > now()
  )
);

CREATE POLICY "Recipients can read room notifications"
ON public.room_notifications FOR SELECT TO authenticated
USING (recipient_id = auth.uid());

CREATE POLICY "Recipients can mark notifications read"
ON public.room_notifications FOR UPDATE TO authenticated
USING (recipient_id = auth.uid())
WITH CHECK (recipient_id = auth.uid());

COMMENT ON COLUMN public.rooms.reopened_until IS 'Server-set end of the seven-day access period after approved recovery; NULL for normal temporary/permanent rooms.';
COMMENT ON TABLE public.room_permanent_requests IS 'Controlled permanence requests available during an approved recovery reopen period.';
COMMENT ON TABLE public.room_notifications IS 'Private in-app notifications addressed to users who used a room.';
