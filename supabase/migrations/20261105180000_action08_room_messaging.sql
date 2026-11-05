-- Action 08: room messaging.
--
-- Edits (server-set edited marker), replies, reactions, pins and
-- per-member read state for room messages, plus server-side notifications
-- for replies, mentions, announcements, shared PDFs and study timers.
--
-- Room messages are plaintext rows in public.messages (room_id set). Private
-- messages (chat_id set) are end-to-end encrypted; nothing here reads,
-- rewrites or copies their ciphertext, and the new columns must stay empty
-- for them. Notification text never copies chat message content.
--
-- Live updates reuse the existing RLS-checked Postgres Changes feed on
-- messages: edits, pins and reaction summaries are UPDATEs of the message
-- row, so no new channel or publication entry is needed.

-- ---------------------------------------------------------------------------
-- 1. Message columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS edited_at timestamptz,
  ADD COLUMN IF NOT EXISTS reply_to_id uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pinned_at timestamptz,
  ADD COLUMN IF NOT EXISTS pinned_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reaction_summary jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_room_only_features_check;
ALTER TABLE public.messages ADD CONSTRAINT messages_room_only_features_check CHECK (
  room_id IS NOT NULL
  OR (edited_at IS NULL AND reply_to_id IS NULL AND pinned_at IS NULL AND pinned_by IS NULL AND reaction_summary = '{}'::jsonb)
);
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_pinned_by_requires_pin_check;
ALTER TABLE public.messages ADD CONSTRAINT messages_pinned_by_requires_pin_check CHECK (pinned_by IS NULL OR pinned_at IS NOT NULL);
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_reaction_summary_shape_check;
ALTER TABLE public.messages ADD CONSTRAINT messages_reaction_summary_shape_check CHECK (
  jsonb_typeof(reaction_summary) = 'object' AND octet_length(reaction_summary::text) <= 32768
);
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_not_reply_to_self_check;
ALTER TABLE public.messages ADD CONSTRAINT messages_not_reply_to_self_check CHECK (reply_to_id IS NULL OR reply_to_id <> id);

CREATE INDEX IF NOT EXISTS messages_room_pinned_idx ON public.messages (room_id, pinned_at DESC) WHERE pinned_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_reply_to_idx ON public.messages (reply_to_id) WHERE reply_to_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_pinned_by_idx ON public.messages (pinned_by) WHERE pinned_by IS NOT NULL;

-- The reaction set is fixed (written as code points so the file encoding
-- cannot change it): thumbs up, red heart, tears of joy, party popper,
-- open mouth, crying face, fire, eyes.
CREATE OR REPLACE FUNCTION public.room_reaction_emojis()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT ARRAY[U&'\+01F44D', U&'\2764\FE0F', U&'\+01F602', U&'\+01F389', U&'\+01F62E', U&'\+01F622', U&'\+01F525', U&'\+01F440']::text[];
$$;
REVOKE ALL ON FUNCTION public.room_reaction_emojis() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.room_reaction_emojis() TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Server-owned message columns
-- ---------------------------------------------------------------------------
-- On insert: clients cannot pre-set edits, pins or reactions, and a reply
-- must point at a live message in the same room.
CREATE OR REPLACE FUNCTION public.prepare_room_message_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  NEW.edited_at := NULL;
  NEW.pinned_at := NULL;
  NEW.pinned_by := NULL;
  NEW.reaction_summary := '{}'::jsonb;

  IF NEW.reply_to_id IS NOT NULL AND (
    NEW.room_id IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM public.messages target
      WHERE target.id = NEW.reply_to_id
        AND target.room_id = NEW.room_id
        AND NOT COALESCE(target.is_deleted, false)
    )
  ) THEN
    RAISE EXCEPTION 'You can only reply to a message in this room.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prepare_room_message_insert ON public.messages;
CREATE TRIGGER prepare_room_message_insert
BEFORE INSERT ON public.messages
FOR EACH ROW EXECUTE FUNCTION public.prepare_room_message_insert();

-- On update: the reply target never changes (clearing it is allowed so the
-- ON DELETE SET NULL actions keep working), deleted messages stay deleted,
-- pins and reaction summaries change only inside their RPCs, and the
-- database sets edited_at whenever a room message's content changes.
-- Delete for everyone also unpins and clears reactions.
CREATE OR REPLACE FUNCTION public.guard_room_message_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_authorized text := COALESCE(current_setting('app.omnilume_message_authorized', true), '');
BEGIN
  IF NEW.reply_to_id IS DISTINCT FROM OLD.reply_to_id AND NEW.reply_to_id IS NOT NULL THEN
    RAISE EXCEPTION 'A reply target cannot change.' USING ERRCODE = '42501';
  END IF;

  IF COALESCE(OLD.is_deleted, false)
     AND (NOT COALESCE(NEW.is_deleted, false) OR NEW.content IS DISTINCT FROM OLD.content) THEN
    RAISE EXCEPTION 'Deleted messages cannot be changed.' USING ERRCODE = '42501';
  END IF;

  IF NEW.pinned_at IS DISTINCT FROM OLD.pinned_at
     OR (NEW.pinned_by IS DISTINCT FROM OLD.pinned_by AND NEW.pinned_by IS NOT NULL) THEN
    IF v_authorized <> 'pin' THEN
      RAISE EXCEPTION 'Pins change only through set_room_message_pin.' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.reaction_summary IS DISTINCT FROM OLD.reaction_summary AND v_authorized <> 'reactions' THEN
    RAISE EXCEPTION 'Reactions change only through toggle_room_message_reaction.' USING ERRCODE = '42501';
  END IF;

  NEW.edited_at := OLD.edited_at;
  IF NEW.room_id IS NOT NULL THEN
    IF COALESCE(NEW.is_deleted, false) AND NOT COALESCE(OLD.is_deleted, false) THEN
      NEW.pinned_at := NULL;
      NEW.pinned_by := NULL;
      NEW.reaction_summary := '{}'::jsonb;
    ELSIF NEW.content IS DISTINCT FROM OLD.content THEN
      NEW.edited_at := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_room_message_update ON public.messages;
CREATE TRIGGER guard_room_message_update
BEFORE UPDATE ON public.messages
FOR EACH ROW EXECUTE FUNCTION public.guard_room_message_update();

-- ---------------------------------------------------------------------------
-- 3. Capability check for another member (internal)
-- ---------------------------------------------------------------------------
-- room_has_capability answers only for the caller. Notification triggers
-- must ask about the recipient: same rules, internal use only.
CREATE OR REPLACE FUNCTION public.room_member_can(p_room_id uuid, p_user_id uuid, p_capability text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
  v_feature text;
BEGIN
  IF p_room_id IS NULL OR p_user_id IS NULL OR NOT public.room_has_active_access(p_room_id) THEN
    RETURN false;
  END IF;
  v_feature := CASE p_capability
    WHEN 'chat' THEN 'chat' WHEN 'watch' THEN 'watch' WHEN 'watch_control' THEN 'watch'
    WHEN 'files' THEN 'files' WHEN 'study' THEN 'study'
    WHEN 'manage_announcements' THEN 'announcements' ELSE NULL END;
  IF v_feature IS NOT NULL AND NOT public.room_feature_enabled(p_room_id, v_feature) THEN
    RETURN false;
  END IF;
  v_role := public.room_user_role(p_room_id, p_user_id);
  IF v_role IS NULL THEN RETURN false; END IF;
  IF v_role = 'owner' THEN RETURN true; END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.room_role_permissions p
    WHERE p.room_id = p_room_id AND p.role = v_role AND p.capability = p_capability AND p.allowed
  );
END;
$$;
REVOKE ALL ON FUNCTION public.room_member_can(uuid, uuid, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Reactions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.room_message_reactions (
  message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  emoji text NOT NULL CHECK (emoji = ANY (public.room_reaction_emojis())),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS room_message_reactions_room_idx ON public.room_message_reactions (room_id);
CREATE INDEX IF NOT EXISTS room_message_reactions_user_idx ON public.room_message_reactions (user_id);

ALTER TABLE public.room_message_reactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.room_message_reactions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.room_message_reactions TO authenticated;

DROP POLICY IF EXISTS "Chat members read room message reactions" ON public.room_message_reactions;
CREATE POLICY "Chat members read room message reactions"
ON public.room_message_reactions
FOR SELECT
TO authenticated
USING (public.room_has_capability(room_id, auth.uid(), 'chat'));

-- Summary stored on the message: {"<emoji>": {"count": n, "users": [first 50]}}
CREATE OR REPLACE FUNCTION public.room_message_reaction_summary(p_message_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(jsonb_object_agg(grouped.emoji, jsonb_build_object('count', grouped.total, 'users', grouped.users)), '{}'::jsonb)
  FROM (
    SELECT r.emoji,
           count(*) AS total,
           (SELECT jsonb_agg(first.user_id ORDER BY first.created_at, first.user_id)
              FROM (SELECT r2.user_id, r2.created_at FROM public.room_message_reactions r2
                    WHERE r2.message_id = p_message_id AND r2.emoji = r.emoji
                    ORDER BY r2.created_at, r2.user_id LIMIT 50) first) AS users
    FROM public.room_message_reactions r
    WHERE r.message_id = p_message_id
    GROUP BY r.emoji
  ) grouped;
$$;
REVOKE ALL ON FUNCTION public.room_message_reaction_summary(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.toggle_room_message_reaction(p_message_id uuid, p_emoji text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_room uuid;
  v_deleted boolean;
  v_summary jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to react.' USING ERRCODE = '42501';
  END IF;
  IF p_emoji IS NULL OR NOT (p_emoji = ANY (public.room_reaction_emojis())) THEN
    RAISE EXCEPTION 'That reaction is not available.' USING ERRCODE = '22023';
  END IF;

  -- Locking the message serializes toggles, so the summary never loses one.
  SELECT m.room_id, COALESCE(m.is_deleted, false) INTO v_room, v_deleted
  FROM public.messages m WHERE m.id = p_message_id
  FOR UPDATE;
  IF NOT FOUND OR v_room IS NULL OR v_deleted THEN
    RAISE EXCEPTION 'Message not found.' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.room_has_capability(v_room, v_uid, 'chat') THEN
    RAISE EXCEPTION 'You cannot react in this room.' USING ERRCODE = '42501';
  END IF;

  -- Set before the DELETE so the statement trigger leaves the summary to us.
  PERFORM set_config('app.omnilume_message_authorized', 'reactions', true);
  DELETE FROM public.room_message_reactions
  WHERE message_id = p_message_id AND user_id = v_uid AND emoji = p_emoji;
  IF NOT FOUND THEN
    INSERT INTO public.room_message_reactions (message_id, room_id, user_id, emoji)
    VALUES (p_message_id, v_room, v_uid, p_emoji);
  END IF;

  v_summary := public.room_message_reaction_summary(p_message_id);
  UPDATE public.messages SET reaction_summary = v_summary WHERE id = p_message_id;
  PERFORM set_config('app.omnilume_message_authorized', '', true);
  RETURN v_summary;
END;
$$;
REVOKE ALL ON FUNCTION public.toggle_room_message_reaction(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.toggle_room_message_reaction(uuid, text) TO authenticated;

-- Removing reactions because an account was deleted refreshes the summary.
CREATE OR REPLACE FUNCTION public.refresh_room_message_reaction_summary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF COALESCE(current_setting('app.omnilume_message_authorized', true), '') = 'reactions' THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('app.omnilume_message_authorized', 'reactions', true);
  UPDATE public.messages m
  SET reaction_summary = public.room_message_reaction_summary(m.id)
  WHERE m.id IN (SELECT DISTINCT removed.message_id FROM removed_rows removed)
    AND NOT COALESCE(m.is_deleted, false);
  PERFORM set_config('app.omnilume_message_authorized', '', true);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS refresh_room_message_reaction_summary ON public.room_message_reactions;
CREATE TRIGGER refresh_room_message_reaction_summary
AFTER DELETE ON public.room_message_reactions
REFERENCING OLD TABLE AS removed_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.refresh_room_message_reaction_summary();

-- Delete for everyone removes the message's reactions.
CREATE OR REPLACE FUNCTION public.clear_deleted_room_message_reactions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.room_id IS NOT NULL AND COALESCE(NEW.is_deleted, false) AND NOT COALESCE(OLD.is_deleted, false) THEN
    PERFORM set_config('app.omnilume_message_authorized', 'reactions', true);
    DELETE FROM public.room_message_reactions WHERE message_id = NEW.id;
    PERFORM set_config('app.omnilume_message_authorized', '', true);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS clear_deleted_room_message_reactions ON public.messages;
CREATE TRIGGER clear_deleted_room_message_reactions
AFTER UPDATE OF is_deleted ON public.messages
FOR EACH ROW EXECUTE FUNCTION public.clear_deleted_room_message_reactions();

-- ---------------------------------------------------------------------------
-- 5. Pins (members who manage announcements; at most 5 per room)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_room_message_pin(p_message_id uuid, p_pinned boolean)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_room uuid;
  v_deleted boolean;
  v_pinned_at timestamptz;
  v_result timestamptz;
BEGIN
  IF v_uid IS NULL OR p_pinned IS NULL THEN
    RAISE EXCEPTION 'Sign in to pin messages.' USING ERRCODE = '42501';
  END IF;

  SELECT m.room_id, COALESCE(m.is_deleted, false), m.pinned_at INTO v_room, v_deleted, v_pinned_at
  FROM public.messages m WHERE m.id = p_message_id
  FOR UPDATE;
  IF NOT FOUND OR v_room IS NULL OR v_deleted THEN
    RAISE EXCEPTION 'Message not found.' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.room_has_capability(v_room, v_uid, 'manage_announcements')
     OR NOT public.room_has_capability(v_room, v_uid, 'chat') THEN
    RAISE EXCEPTION 'Only members who manage announcements can pin messages.' USING ERRCODE = '42501';
  END IF;

  IF p_pinned THEN
    IF v_pinned_at IS NOT NULL THEN RETURN v_pinned_at; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('room-message-pins:' || v_room::text, 0));
    IF (SELECT count(*) FROM public.messages m WHERE m.room_id = v_room AND m.pinned_at IS NOT NULL) >= 5 THEN
      RAISE EXCEPTION 'A room can pin up to 5 messages. Unpin one first.' USING ERRCODE = '23514';
    END IF;
    v_result := now();
  ELSE
    IF v_pinned_at IS NULL THEN RETURN NULL; END IF;
    v_result := NULL;
  END IF;

  PERFORM set_config('app.omnilume_message_authorized', 'pin', true);
  UPDATE public.messages
  SET pinned_at = v_result, pinned_by = CASE WHEN p_pinned THEN v_uid ELSE NULL END
  WHERE id = p_message_id;
  PERFORM set_config('app.omnilume_message_authorized', '', true);
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.set_room_message_pin(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_room_message_pin(uuid, boolean) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. Reply and mention notifications
-- ---------------------------------------------------------------------------
-- Mentions are scoped and private: only an @username of an approved member
-- who can read this room's chat is notified, and only that member sees the
-- notice. A failure here never blocks sending the message.
CREATE OR REPLACE FUNCTION public.notify_room_message_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_label text;
  v_target_sender uuid;
  v_mentioned uuid;
BEGIN
  IF NEW.room_id IS NULL OR COALESCE(NEW.is_deleted, false) OR NEW.content IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.content IS NOT DISTINCT FROM OLD.content THEN
    RETURN NULL;
  END IF;

  BEGIN
    v_label := public.notification_user_label(NEW.sender_id);

    IF TG_OP = 'INSERT' AND NEW.reply_to_id IS NOT NULL THEN
      SELECT m.sender_id INTO v_target_sender FROM public.messages m WHERE m.id = NEW.reply_to_id;
      IF v_target_sender IS NOT NULL AND v_target_sender <> NEW.sender_id
         AND public.room_member_can(NEW.room_id, v_target_sender, 'chat') THEN
        PERFORM public.enqueue_room_notification(
          v_target_sender, NEW.room_id, 'reply', left(v_label, 80) || ' replied to your message.',
          jsonb_build_object('message_id', NEW.id), NEW.sender_id, NEW.id, 'reply:' || NEW.id::text);
      END IF;
    END IF;

    IF NEW.content !~ '^\[gif:' THEN
      FOR v_mentioned IN
        SELECT DISTINCT p.id
        FROM (
          SELECT lower(matched.parts[1]) AS token
          FROM regexp_matches(NEW.content, '(?:^|[^A-Za-z0-9_.@])@([A-Za-z0-9][A-Za-z0-9_.]{2,29})', 'g') AS matched(parts)
          LIMIT 20
        ) tokens
        JOIN public.profiles p ON lower(p.username) IN (tokens.token, rtrim(tokens.token, '.'))
        WHERE p.id <> NEW.sender_id
        LIMIT 10
      LOOP
        IF public.room_member_can(NEW.room_id, v_mentioned, 'chat') THEN
          PERFORM public.enqueue_room_notification(
            v_mentioned, NEW.room_id, 'mention', left(v_label, 80) || ' mentioned you.',
            jsonb_build_object('message_id', NEW.id), NEW.sender_id, NEW.id,
            'mention:' || NEW.id::text || ':' || v_mentioned::text);
        END IF;
      END LOOP;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'room message notification skipped (%)', SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS notify_room_message_activity ON public.messages;
CREATE TRIGGER notify_room_message_activity
AFTER INSERT OR UPDATE OF content ON public.messages
FOR EACH ROW EXECUTE FUNCTION public.notify_room_message_activity();

-- ---------------------------------------------------------------------------
-- 7. Announcement notifications (creation is already limited to members
--    with manage_announcements by create_room_announcement)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_room_announcement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_member uuid;
  v_text text;
BEGIN
  BEGIN
    v_text := left(public.notification_user_label(NEW.author_id), 80) || ' posted an announcement: '
      || left(regexp_replace(btrim(NEW.body), '\s+', ' ', 'g'), 160);
    FOR v_member IN
      SELECT rm.user_id FROM public.room_members rm
      WHERE rm.room_id = NEW.room_id AND rm.join_status = 'approved' AND rm.user_id <> NEW.author_id
    LOOP
      IF public.room_user_role(NEW.room_id, v_member) IS NOT NULL THEN
        PERFORM public.enqueue_room_notification(
          v_member, NEW.room_id, 'announcement', v_text,
          jsonb_build_object('announcement_id', NEW.id), NEW.author_id, NEW.id, 'announcement:' || NEW.id::text);
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'announcement notification skipped (%)', SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS notify_room_announcement ON public.room_announcements;
CREATE TRIGGER notify_room_announcement
AFTER INSERT ON public.room_announcements
FOR EACH ROW EXECUTE FUNCTION public.notify_room_announcement();

-- ---------------------------------------------------------------------------
-- 8. Shared-PDF notifications (members who can use room files)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_room_pdf_shared()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_member uuid;
  v_text text;
BEGIN
  IF NEW.mime_type <> 'application/pdf' OR NEW.retention_state <> 'active' THEN
    RETURN NULL;
  END IF;
  BEGIN
    v_text := left(public.notification_user_label(NEW.owner_id), 80) || ' shared a PDF: ' || left(NEW.original_name, 160);
    FOR v_member IN
      SELECT rm.user_id FROM public.room_members rm
      WHERE rm.room_id = NEW.room_id AND rm.join_status = 'approved' AND rm.user_id <> NEW.owner_id
    LOOP
      IF public.room_member_can(NEW.room_id, v_member, 'files') THEN
        PERFORM public.enqueue_room_notification(
          v_member, NEW.room_id, 'pdf_shared', v_text,
          jsonb_build_object('file_id', NEW.id), NEW.owner_id, NEW.id, 'pdf_shared:' || NEW.id::text);
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'shared PDF notification skipped (%)', SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS notify_room_pdf_shared ON public.room_files;
CREATE TRIGGER notify_room_pdf_shared
AFTER INSERT ON public.room_files
FOR EACH ROW EXECUTE FUNCTION public.notify_room_pdf_shared();

-- ---------------------------------------------------------------------------
-- 9. Study timer notifications
-- ---------------------------------------------------------------------------
-- The shared timer is persisted through upsert_room_realtime_snapshot
-- (study capability). The database records who really started each session
-- (the authenticated writer, not a client-supplied owner id) and when, then
-- notifies the room owner on start and the starter on a completion that is
-- not earlier than the session's duration allows.
CREATE TABLE IF NOT EXISTS public.room_timer_sessions (
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  session_id text NOT NULL CHECK (session_id ~ '^[A-Za-z0-9-]{8,80}$'),
  started_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  duration_seconds integer NOT NULL CHECK (duration_seconds BETWEEN 1 AND 359999),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (room_id, session_id),
  CHECK (completed_at IS NULL OR completed_at >= started_at)
);
CREATE INDEX IF NOT EXISTS room_timer_sessions_started_by_idx ON public.room_timer_sessions (started_by);
ALTER TABLE public.room_timer_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.room_timer_sessions FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.notify_room_timer_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_event text := NEW.payload ->> 'eventType';
  v_wire jsonb := NEW.payload -> 'payload';
  v_session text;
  v_duration_text text;
  v_duration integer;
  v_owner uuid;
  v_starter uuid;
BEGIN
  IF NEW.snapshot_type <> 'timer' OR jsonb_typeof(v_wire) IS DISTINCT FROM 'object' THEN
    RETURN NULL;
  END IF;
  v_session := v_wire ->> 'sessionId';
  IF v_session IS NULL OR v_session !~ '^[A-Za-z0-9-]{8,80}$' THEN
    RETURN NULL;
  END IF;

  BEGIN
    IF v_event = 'timer_start' THEN
      v_duration_text := v_wire ->> 'duration';
      IF v_duration_text IS NULL OR v_duration_text !~ '^[0-9]{1,6}(\.[0-9]+)?$' THEN
        RETURN NULL;
      END IF;
      v_duration := round(v_duration_text::numeric)::integer;
      IF v_duration < 1 OR v_duration > 359999 THEN
        RETURN NULL;
      END IF;

      INSERT INTO public.room_timer_sessions (room_id, session_id, started_by, duration_seconds)
      VALUES (NEW.room_id, v_session, NEW.updated_by, v_duration)
      ON CONFLICT (room_id, session_id) DO NOTHING;
      IF NOT FOUND THEN
        RETURN NULL; -- resuming a known session
      END IF;

      SELECT rm.user_id INTO v_owner FROM public.room_members rm
      WHERE rm.room_id = NEW.room_id AND rm.role = 'owner' AND rm.join_status = 'approved'
      LIMIT 1;
      IF v_owner IS NOT NULL THEN
        PERFORM public.enqueue_room_notification(
          v_owner, NEW.room_id, 'timer',
          left(public.notification_user_label(NEW.updated_by), 80) || ' started a '
            || GREATEST(1, round(v_duration / 60.0))::integer || '-minute study timer.',
          jsonb_build_object('session_id', v_session, 'duration_seconds', v_duration),
          NEW.updated_by, NULL, 'timer-start:' || NEW.room_id::text || ':' || v_session);
      END IF;
    ELSIF v_event = 'timer_pause' AND (v_wire ->> 'completed') = 'true' THEN
      UPDATE public.room_timer_sessions s
      SET completed_at = now()
      WHERE s.room_id = NEW.room_id AND s.session_id = v_session AND s.completed_at IS NULL
        AND now() >= s.started_at + make_interval(secs => s.duration_seconds) - interval '15 seconds'
      RETURNING s.started_by, s.duration_seconds INTO v_starter, v_duration;
      IF FOUND THEN
        PERFORM public.enqueue_room_notification(
          v_starter, NEW.room_id, 'timer',
          'Your ' || GREATEST(1, round(v_duration / 60.0))::integer || '-minute study timer finished.',
          jsonb_build_object('session_id', v_session, 'duration_seconds', v_duration),
          NULL, NULL, 'timer-done:' || NEW.room_id::text || ':' || v_session);
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'timer notification skipped (%)', SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS notify_room_timer_activity ON public.room_realtime_snapshots;
CREATE TRIGGER notify_room_timer_activity
AFTER INSERT OR UPDATE ON public.room_realtime_snapshots
FOR EACH ROW WHEN (NEW.snapshot_type = 'timer')
EXECUTE FUNCTION public.notify_room_timer_activity();

-- ---------------------------------------------------------------------------
-- 10. Per-member read state
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.room_read_states (
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS room_read_states_user_idx ON public.room_read_states (user_id);
ALTER TABLE public.room_read_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.room_read_states FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.room_read_states TO authenticated;

DROP POLICY IF EXISTS "Members read their own room read state" ON public.room_read_states;
CREATE POLICY "Members read their own room read state"
ON public.room_read_states
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

-- The server clock decides what has been read; the marker never moves back.
CREATE OR REPLACE FUNCTION public.mark_room_read(p_room_id uuid)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_read_at timestamptz;
BEGIN
  IF v_uid IS NULL OR NOT public.room_has_capability(p_room_id, v_uid, 'chat') THEN
    RAISE EXCEPTION 'You cannot read this room''s chat.' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.room_read_states AS state (room_id, user_id, last_read_at)
  VALUES (p_room_id, v_uid, now())
  ON CONFLICT (room_id, user_id) DO UPDATE
  SET last_read_at = GREATEST(state.last_read_at, EXCLUDED.last_read_at)
  RETURNING state.last_read_at INTO v_read_at;
  RETURN v_read_at;
END;
$$;
REVOKE ALL ON FUNCTION public.mark_room_read(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_room_read(uuid) TO authenticated;

-- Unread counts (capped at 100) for the caller's rooms where they can read
-- chat. Counts only: no message content leaves this function.
CREATE OR REPLACE FUNCTION public.get_room_unread_counts(p_room_ids uuid[] DEFAULT NULL)
RETURNS TABLE (room_id uuid, unread_count integer, last_read_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to see unread messages.' USING ERRCODE = '42501';
  END IF;
  IF p_room_ids IS NOT NULL AND cardinality(p_room_ids) > 200 THEN
    RAISE EXCEPTION 'Too many rooms requested.' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT rm.room_id,
         (SELECT count(*)::integer FROM (
            SELECT 1 FROM public.messages m
            WHERE m.room_id = rm.room_id
              AND m.created_at > COALESCE(rs.last_read_at, rm.joined_at)
              AND m.sender_id <> v_uid
              AND NOT COALESCE(m.is_deleted, false)
            LIMIT 100) capped),
         rs.last_read_at
  FROM public.room_members rm
  LEFT JOIN public.room_read_states rs ON rs.room_id = rm.room_id AND rs.user_id = v_uid
  WHERE rm.user_id = v_uid
    AND rm.join_status = 'approved'
    AND (p_room_ids IS NULL OR rm.room_id = ANY (p_room_ids))
    AND public.room_has_capability(rm.room_id, v_uid, 'chat');
END;
$$;
REVOKE ALL ON FUNCTION public.get_room_unread_counts(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_room_unread_counts(uuid[]) TO authenticated;

-- Trigger functions are never called directly.
REVOKE ALL ON FUNCTION public.prepare_room_message_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_room_message_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_room_message_reaction_summary() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.clear_deleted_room_message_reactions() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_room_message_activity() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_room_announcement() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_room_pdf_shared() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_room_timer_activity() FROM PUBLIC, anon, authenticated;
