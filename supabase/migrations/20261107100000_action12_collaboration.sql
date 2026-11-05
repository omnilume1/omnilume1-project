-- Action 12: Study and non-AI collaboration. Additive only.
--
-- Capability model (existing room_has_capability / room_member_can):
--   study               notes, note history/lock, tasks, study resources
--   chat                raise hand, polls, countdowns, voice/screen state,
--                       recordings (participants), room events (read)
--   manage_announcements create/cancel room events (they notify everyone)
--   manage_members      moderation: lower others' hands, close/delete others'
--                       polls, cancel others' countdowns, mute/stop share,
--                       request a consented recording
--   watch               clips in search (Action 11 table)
-- Every table has RLS enabled. Direct writes are never granted; changes go
-- through SECURITY DEFINER RPCs with search_path = '' that re-check the
-- caller's capability. Helpers used inside RLS policies are executable by
-- authenticated (policies run as the caller).

-- ---------------------------------------------------------------------------
-- 0. Notification types: task assignments and room events join the existing
--    list (widened, nothing removed).
-- ---------------------------------------------------------------------------
ALTER TABLE public.room_notifications DROP CONSTRAINT IF EXISTS room_notifications_type_allowed;
ALTER TABLE public.room_notifications
  ADD CONSTRAINT room_notifications_type_allowed CHECK (notification_type IN (
    'mention', 'reply', 'announcement', 'pdf_shared', 'timer',
    'recovery_request', 'recovery_decision', 'access', 'security',
    'permanent_conversion', 'room_deletion',
    'task', 'room_event'
  ));

-- ---------------------------------------------------------------------------
-- 1. Notes: editor attribution, read-only lock, version history
-- ---------------------------------------------------------------------------
ALTER TABLE public.study_notes
  ADD COLUMN IF NOT EXISTS last_edited_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS locked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS locked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.study_note_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id uuid NOT NULL REFERENCES public.study_notes(id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  version bigint NOT NULL CHECK (version > 0),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  content text NOT NULL CHECK (char_length(content) <= 100000),
  edited_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  saved_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (note_id, version)
);
CREATE INDEX IF NOT EXISTS study_note_versions_note_idx ON public.study_note_versions (note_id, version DESC);
ALTER TABLE public.study_note_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.study_note_versions FROM PUBLIC, anon, authenticated;

-- Each content change keeps the previous version (last 50 per note).
CREATE OR REPLACE FUNCTION public.capture_study_note_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.title IS DISTINCT FROM OLD.title OR NEW.content IS DISTINCT FROM OLD.content THEN
    INSERT INTO public.study_note_versions (note_id, room_id, version, title, content, edited_by, saved_at)
    VALUES (OLD.id, OLD.room_id, OLD.version, OLD.title, OLD.content, OLD.last_edited_by, OLD.updated_at)
    ON CONFLICT (note_id, version) DO NOTHING;
    DELETE FROM public.study_note_versions v WHERE v.note_id = OLD.id AND v.version <= OLD.version - 50;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.capture_study_note_version() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS capture_study_note_version ON public.study_notes;
CREATE TRIGGER capture_study_note_version
AFTER UPDATE ON public.study_notes
FOR EACH ROW EXECUTE FUNCTION public.capture_study_note_version();

-- Same contract as Action 10, plus: a locked note is read-only for everyone
-- except its author and room managers, and the editor is recorded.
CREATE OR REPLACE FUNCTION public.update_study_note(
  p_note_id uuid,
  p_expected_version bigint,
  p_title text,
  p_content text
)
RETURNS public.study_notes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE note_row public.study_notes%ROWTYPE;
BEGIN
  SELECT * INTO note_row FROM public.study_notes sn WHERE sn.id = p_note_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL
     OR NOT public.room_has_capability(note_row.room_id, auth.uid(), 'study')
     OR (note_row.scope = 'personal' AND note_row.owner_id <> auth.uid())
     OR p_expected_version IS NULL OR p_expected_version <> note_row.version
     OR char_length(COALESCE(btrim(p_title), '')) NOT BETWEEN 1 AND 160
     OR char_length(COALESCE(p_content, '')) > 100000 THEN
    RAISE EXCEPTION 'Study note update rejected: expected version does not match or access is denied.';
  END IF;
  IF note_row.locked AND note_row.owner_id <> auth.uid()
     AND NOT public.room_has_capability(note_row.room_id, auth.uid(), 'manage_members') THEN
    RAISE EXCEPTION 'This note is read-only.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.study_notes
  SET title = btrim(p_title), content = COALESCE(p_content, ''), version = version + 1,
      updated_at = now(), last_edited_by = auth.uid()
  WHERE id = p_note_id
  RETURNING * INTO note_row;
  RETURN note_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_study_note_versions(p_note_id uuid)
RETURNS TABLE (version bigint, title text, content text, edited_by uuid, saved_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE note_row public.study_notes%ROWTYPE;
BEGIN
  SELECT * INTO note_row FROM public.study_notes sn WHERE sn.id = p_note_id;
  IF NOT FOUND OR auth.uid() IS NULL
     OR NOT public.room_has_capability(note_row.room_id, auth.uid(), 'study')
     OR (note_row.scope = 'personal' AND note_row.owner_id <> auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized to view this note history.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT v.version, v.title, v.content, v.edited_by, v.saved_at
  FROM public.study_note_versions v WHERE v.note_id = p_note_id
  ORDER BY v.version DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.restore_study_note_version(p_note_id uuid, p_version bigint, p_expected_version bigint)
RETURNS public.study_notes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_row public.study_note_versions%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.study_note_versions v WHERE v.note_id = p_note_id AND v.version = p_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That version is no longer available.' USING ERRCODE = 'P0002';
  END IF;
  -- update_study_note re-checks access, the lock and the expected version.
  RETURN public.update_study_note(p_note_id, p_expected_version, v_row.title, v_row.content);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_study_note_locked(p_note_id uuid, p_locked boolean)
RETURNS public.study_notes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE note_row public.study_notes%ROWTYPE;
BEGIN
  SELECT * INTO note_row FROM public.study_notes sn WHERE sn.id = p_note_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR p_locked IS NULL
     OR NOT public.room_has_capability(note_row.room_id, auth.uid(), 'study')
     OR note_row.scope <> 'room'
     OR (note_row.owner_id <> auth.uid() AND NOT public.room_has_capability(note_row.room_id, auth.uid(), 'manage_members')) THEN
    RAISE EXCEPTION 'Only the author or a room manager can change read-only mode.' USING ERRCODE = '42501';
  END IF;
  UPDATE public.study_notes
  SET locked = p_locked, locked_by = CASE WHEN p_locked THEN auth.uid() ELSE NULL END
  WHERE id = p_note_id
  RETURNING * INTO note_row;
  RETURN note_row;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Raise hand
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.room_hand_raises (
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  raised_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);
ALTER TABLE public.room_hand_raises ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.room_hand_raises FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.room_hand_raises TO authenticated;
DROP POLICY IF EXISTS "Chat members read raised hands" ON public.room_hand_raises;
CREATE POLICY "Chat members read raised hands" ON public.room_hand_raises FOR SELECT TO authenticated
USING (public.room_has_capability(room_id, auth.uid(), 'chat'));

CREATE OR REPLACE FUNCTION public.raise_room_hand(p_room_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.room_has_capability(p_room_id, auth.uid(), 'chat') THEN
    RAISE EXCEPTION 'Not authorized to raise a hand in this room.' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.room_hand_raises (room_id, user_id) VALUES (p_room_id, auth.uid())
  ON CONFLICT (room_id, user_id) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.lower_room_hand(p_room_id uuid, p_user_id uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_target uuid := COALESCE(p_user_id, auth.uid());
BEGIN
  IF auth.uid() IS NULL OR NOT public.room_has_capability(p_room_id, auth.uid(), 'chat')
     OR (v_target <> auth.uid() AND NOT public.room_has_capability(p_room_id, auth.uid(), 'manage_members')) THEN
    RAISE EXCEPTION 'Not authorized to lower this hand.' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.room_hand_raises h WHERE h.room_id = p_room_id AND h.user_id = v_target;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Polls (one vote per member; only totals are visible to others)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.room_polls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  question text NOT NULL CHECK (char_length(btrim(question)) BETWEEN 1 AND 300),
  options text[] NOT NULL CHECK (cardinality(options) BETWEEN 2 AND 10),
  closed_at timestamptz,
  closed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS room_polls_room_idx ON public.room_polls (room_id, created_at DESC);
CREATE TABLE IF NOT EXISTS public.room_poll_votes (
  poll_id uuid NOT NULL REFERENCES public.room_polls(id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  option_index smallint NOT NULL CHECK (option_index BETWEEN 0 AND 9),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (poll_id, user_id)
);
ALTER TABLE public.room_polls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_poll_votes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.room_polls, public.room_poll_votes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.room_polls, public.room_poll_votes TO authenticated;
DROP POLICY IF EXISTS "Chat members read polls" ON public.room_polls;
CREATE POLICY "Chat members read polls" ON public.room_polls FOR SELECT TO authenticated
USING (public.room_has_capability(room_id, auth.uid(), 'chat'));
DROP POLICY IF EXISTS "Members read their own poll votes" ON public.room_poll_votes;
CREATE POLICY "Members read their own poll votes" ON public.room_poll_votes FOR SELECT TO authenticated
USING (user_id = auth.uid() AND public.room_has_capability(room_id, auth.uid(), 'chat'));

CREATE OR REPLACE FUNCTION public.create_room_poll(p_room_id uuid, p_question text, p_options text[])
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_options text[];
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.room_has_capability(p_room_id, auth.uid(), 'chat') THEN
    RAISE EXCEPTION 'Not authorized to create polls in this room.' USING ERRCODE = '42501';
  END IF;
  SELECT array_agg(btrim(o) ORDER BY ord) INTO v_options
  FROM unnest(COALESCE(p_options, ARRAY[]::text[])) WITH ORDINALITY AS t(o, ord)
  WHERE btrim(o) <> '';
  IF char_length(COALESCE(btrim(p_question), '')) NOT BETWEEN 1 AND 300
     OR COALESCE(cardinality(v_options), 0) NOT BETWEEN 2 AND 10
     OR EXISTS (SELECT 1 FROM unnest(v_options) o WHERE char_length(o) > 120)
     OR (SELECT count(DISTINCT lower(o)) FROM unnest(v_options) o) <> cardinality(v_options) THEN
    RAISE EXCEPTION 'A poll needs a question and 2 to 10 different options (120 characters each).' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM public.room_polls p WHERE p.room_id = p_room_id AND p.closed_at IS NULL) >= 20 THEN
    RAISE EXCEPTION 'This room already has 20 open polls.' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.room_polls (room_id, created_by, question, options)
  VALUES (p_room_id, auth.uid(), btrim(p_question), v_options)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.vote_room_poll(p_poll_id uuid, p_option_index integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_poll public.room_polls%ROWTYPE;
BEGIN
  SELECT * INTO v_poll FROM public.room_polls p WHERE p.id = p_poll_id;
  IF NOT FOUND OR auth.uid() IS NULL OR NOT public.room_has_capability(v_poll.room_id, auth.uid(), 'chat') THEN
    RAISE EXCEPTION 'Not authorized to vote in this poll.' USING ERRCODE = '42501';
  END IF;
  IF v_poll.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'This poll is closed.' USING ERRCODE = '23514';
  END IF;
  IF p_option_index IS NULL OR p_option_index < 0 OR p_option_index >= cardinality(v_poll.options) THEN
    RAISE EXCEPTION 'Choose one of the poll options.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.room_poll_votes (poll_id, room_id, user_id, option_index)
  VALUES (p_poll_id, v_poll.room_id, auth.uid(), p_option_index)
  ON CONFLICT (poll_id, user_id) DO NOTHING;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'You have already voted in this poll.' USING ERRCODE = '23505';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.close_room_poll(p_poll_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_poll public.room_polls%ROWTYPE;
BEGIN
  SELECT * INTO v_poll FROM public.room_polls p WHERE p.id = p_poll_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR NOT public.room_has_capability(v_poll.room_id, auth.uid(), 'chat')
     OR (v_poll.created_by <> auth.uid() AND NOT public.room_has_capability(v_poll.room_id, auth.uid(), 'manage_members')) THEN
    RAISE EXCEPTION 'Only the poll creator or a room manager can close it.' USING ERRCODE = '42501';
  END IF;
  UPDATE public.room_polls SET closed_at = COALESCE(closed_at, now()), closed_by = COALESCE(closed_by, auth.uid())
  WHERE id = p_poll_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_room_poll(p_poll_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_poll public.room_polls%ROWTYPE;
BEGIN
  SELECT * INTO v_poll FROM public.room_polls p WHERE p.id = p_poll_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF auth.uid() IS NULL OR NOT public.room_has_capability(v_poll.room_id, auth.uid(), 'chat')
     OR (v_poll.created_by <> auth.uid() AND NOT public.room_has_capability(v_poll.room_id, auth.uid(), 'manage_members')) THEN
    RAISE EXCEPTION 'Only the poll creator or a room manager can delete it.' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.room_polls WHERE id = p_poll_id;
END;
$$;

-- Totals per option plus the caller's own choice; individual votes stay private.
CREATE OR REPLACE FUNCTION public.get_room_poll_results(p_room_id uuid)
RETURNS TABLE (poll_id uuid, counts integer[], total integer, my_vote smallint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.room_has_capability(p_room_id, auth.uid(), 'chat') THEN
    RAISE EXCEPTION 'Not authorized to view polls in this room.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT p.id,
    ARRAY(
      SELECT count(v.user_id)::integer
      FROM generate_series(0, cardinality(p.options) - 1) AS g(i)
      LEFT JOIN public.room_poll_votes v ON v.poll_id = p.id AND v.option_index = g.i
      GROUP BY g.i ORDER BY g.i
    ),
    (SELECT count(*)::integer FROM public.room_poll_votes v WHERE v.poll_id = p.id),
    (SELECT v.option_index FROM public.room_poll_votes v WHERE v.poll_id = p.id AND v.user_id = auth.uid())
  FROM public.room_polls p
  WHERE p.room_id = p_room_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Shared countdowns
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.room_countdowns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 120),
  ends_at timestamptz NOT NULL,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > created_at)
);
CREATE INDEX IF NOT EXISTS room_countdowns_room_idx ON public.room_countdowns (room_id, ends_at);
ALTER TABLE public.room_countdowns ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.room_countdowns FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.room_countdowns TO authenticated;
DROP POLICY IF EXISTS "Chat members read countdowns" ON public.room_countdowns;
CREATE POLICY "Chat members read countdowns" ON public.room_countdowns FOR SELECT TO authenticated
USING (public.room_has_capability(room_id, auth.uid(), 'chat'));

CREATE OR REPLACE FUNCTION public.create_room_countdown(p_room_id uuid, p_label text, p_ends_at timestamptz)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.room_has_capability(p_room_id, auth.uid(), 'chat') THEN
    RAISE EXCEPTION 'Not authorized to start a countdown in this room.' USING ERRCODE = '42501';
  END IF;
  IF char_length(COALESCE(btrim(p_label), '')) NOT BETWEEN 1 AND 120
     OR p_ends_at IS NULL OR p_ends_at < now() + interval '5 seconds' OR p_ends_at > now() + interval '30 days' THEN
    RAISE EXCEPTION 'A countdown needs a label and an end between 5 seconds and 30 days from now.' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM public.room_countdowns c
      WHERE c.room_id = p_room_id AND c.cancelled_at IS NULL AND c.ends_at > now()) >= 10 THEN
    RAISE EXCEPTION 'This room already has 10 running countdowns.' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.room_countdowns (room_id, created_by, label, ends_at)
  VALUES (p_room_id, auth.uid(), btrim(p_label), p_ends_at)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_room_countdown(p_countdown_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_row public.room_countdowns%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.room_countdowns c WHERE c.id = p_countdown_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR NOT public.room_has_capability(v_row.room_id, auth.uid(), 'chat')
     OR (v_row.created_by <> auth.uid() AND NOT public.room_has_capability(v_row.room_id, auth.uid(), 'manage_members')) THEN
    RAISE EXCEPTION 'Only the creator or a room manager can cancel this countdown.' USING ERRCODE = '42501';
  END IF;
  UPDATE public.room_countdowns SET cancelled_at = COALESCE(cancelled_at, now()) WHERE id = p_countdown_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Tasks / action items (assignee is notified)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.room_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  details text NOT NULL DEFAULT '' CHECK (char_length(details) <= 2000),
  assignee_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  due_at timestamptz,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  completed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'done') = (completed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS room_tasks_room_idx ON public.room_tasks (room_id, status, due_at);
CREATE INDEX IF NOT EXISTS room_tasks_assignee_idx ON public.room_tasks (assignee_id);
ALTER TABLE public.room_tasks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.room_tasks FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.room_tasks TO authenticated;
DROP POLICY IF EXISTS "Study members read tasks" ON public.room_tasks;
CREATE POLICY "Study members read tasks" ON public.room_tasks FOR SELECT TO authenticated
USING (public.room_has_capability(room_id, auth.uid(), 'study'));

CREATE OR REPLACE FUNCTION public.create_room_task(
  p_room_id uuid, p_title text, p_details text DEFAULT '', p_assignee_id uuid DEFAULT NULL, p_due_at timestamptz DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.room_has_capability(p_room_id, auth.uid(), 'study') THEN
    RAISE EXCEPTION 'Not authorized to add tasks in this room.' USING ERRCODE = '42501';
  END IF;
  IF char_length(COALESCE(btrim(p_title), '')) NOT BETWEEN 1 AND 200 OR char_length(COALESCE(p_details, '')) > 2000 THEN
    RAISE EXCEPTION 'A task needs a title (200 characters) and details up to 2000 characters.' USING ERRCODE = '22023';
  END IF;
  IF p_assignee_id IS NOT NULL AND NOT public.room_member_can(p_room_id, p_assignee_id, 'study') THEN
    RAISE EXCEPTION 'The assignee must be a member who can use Study.' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM public.room_tasks t WHERE t.room_id = p_room_id) >= 500 THEN
    RAISE EXCEPTION 'This room already has 500 tasks.' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.room_tasks (room_id, created_by, title, details, assignee_id, due_at)
  VALUES (p_room_id, auth.uid(), btrim(p_title), COALESCE(p_details, ''), p_assignee_id, p_due_at)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_room_task(
  p_task_id uuid, p_title text, p_details text, p_assignee_id uuid, p_due_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_task public.room_tasks%ROWTYPE;
BEGIN
  SELECT * INTO v_task FROM public.room_tasks t WHERE t.id = p_task_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR NOT public.room_has_capability(v_task.room_id, auth.uid(), 'study')
     OR (auth.uid() NOT IN (v_task.created_by, COALESCE(v_task.assignee_id, v_task.created_by))
         AND NOT public.room_has_capability(v_task.room_id, auth.uid(), 'manage_members')) THEN
    RAISE EXCEPTION 'Only the creator, the assignee or a room manager can edit this task.' USING ERRCODE = '42501';
  END IF;
  IF char_length(COALESCE(btrim(p_title), '')) NOT BETWEEN 1 AND 200 OR char_length(COALESCE(p_details, '')) > 2000 THEN
    RAISE EXCEPTION 'A task needs a title (200 characters) and details up to 2000 characters.' USING ERRCODE = '22023';
  END IF;
  IF p_assignee_id IS NOT NULL AND NOT public.room_member_can(v_task.room_id, p_assignee_id, 'study') THEN
    RAISE EXCEPTION 'The assignee must be a member who can use Study.' USING ERRCODE = '22023';
  END IF;
  UPDATE public.room_tasks
  SET title = btrim(p_title), details = COALESCE(p_details, ''), assignee_id = p_assignee_id,
      due_at = p_due_at, updated_at = now()
  WHERE id = p_task_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_room_task_done(p_task_id uuid, p_done boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_task public.room_tasks%ROWTYPE;
BEGIN
  SELECT * INTO v_task FROM public.room_tasks t WHERE t.id = p_task_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR p_done IS NULL OR NOT public.room_has_capability(v_task.room_id, auth.uid(), 'study')
     OR (auth.uid() NOT IN (v_task.created_by, COALESCE(v_task.assignee_id, v_task.created_by))
         AND NOT public.room_has_capability(v_task.room_id, auth.uid(), 'manage_members')) THEN
    RAISE EXCEPTION 'Only the creator, the assignee or a room manager can complete this task.' USING ERRCODE = '42501';
  END IF;
  UPDATE public.room_tasks
  SET status = CASE WHEN p_done THEN 'done' ELSE 'open' END,
      completed_by = CASE WHEN p_done THEN auth.uid() ELSE NULL END,
      completed_at = CASE WHEN p_done THEN now() ELSE NULL END,
      updated_at = now()
  WHERE id = p_task_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_room_task(p_task_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_task public.room_tasks%ROWTYPE;
BEGIN
  SELECT * INTO v_task FROM public.room_tasks t WHERE t.id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF auth.uid() IS NULL OR NOT public.room_has_capability(v_task.room_id, auth.uid(), 'study')
     OR (v_task.created_by <> auth.uid() AND NOT public.room_has_capability(v_task.room_id, auth.uid(), 'manage_members')) THEN
    RAISE EXCEPTION 'Only the creator or a room manager can delete this task.' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.room_tasks WHERE id = p_task_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_room_task_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.assignee_id IS NULL OR (TG_OP = 'UPDATE' AND NEW.assignee_id IS NOT DISTINCT FROM OLD.assignee_id) THEN
    RETURN NULL;
  END IF;
  BEGIN
    PERFORM public.enqueue_room_notification(
      NEW.assignee_id, NEW.room_id, 'task',
      left(public.notification_user_label(COALESCE(auth.uid(), NEW.created_by)), 80) || ' assigned you a task: ' || left(NEW.title, 160),
      jsonb_build_object('task_id', NEW.id),
      COALESCE(auth.uid(), NEW.created_by), NEW.id,
      'task-assigned:' || NEW.id::text || ':' || NEW.assignee_id::text);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'task notification skipped (%)', SQLSTATE;
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.notify_room_task_assignment() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS notify_room_task_assignment ON public.room_tasks;
CREATE TRIGGER notify_room_task_assignment
AFTER INSERT OR UPDATE OF assignee_id ON public.room_tasks
FOR EACH ROW EXECUTE FUNCTION public.notify_room_task_assignment();

-- ---------------------------------------------------------------------------
-- 6. Room events (members are notified when scheduled or cancelled)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.room_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 160),
  details text NOT NULL DEFAULT '' CHECK (char_length(details) <= 2000),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at >= starts_at)
);
CREATE INDEX IF NOT EXISTS room_events_room_idx ON public.room_events (room_id, starts_at);
ALTER TABLE public.room_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.room_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.room_events TO authenticated;
DROP POLICY IF EXISTS "Chat members read room events" ON public.room_events;
CREATE POLICY "Chat members read room events" ON public.room_events FOR SELECT TO authenticated
USING (public.room_has_capability(room_id, auth.uid(), 'chat'));

CREATE OR REPLACE FUNCTION public.create_room_event(
  p_room_id uuid, p_title text, p_details text, p_starts_at timestamptz, p_ends_at timestamptz DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.room_has_capability(p_room_id, auth.uid(), 'manage_announcements') THEN
    RAISE EXCEPTION 'Only members who manage announcements can schedule room events.' USING ERRCODE = '42501';
  END IF;
  IF char_length(COALESCE(btrim(p_title), '')) NOT BETWEEN 1 AND 160 OR char_length(COALESCE(p_details, '')) > 2000
     OR p_starts_at IS NULL OR p_starts_at < now() - interval '1 hour' OR p_starts_at > now() + interval '366 days'
     OR (p_ends_at IS NOT NULL AND (p_ends_at < p_starts_at OR p_ends_at > p_starts_at + interval '7 days')) THEN
    RAISE EXCEPTION 'An event needs a title, a start within the next year and an end after the start.' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM public.room_events e
      WHERE e.room_id = p_room_id AND e.cancelled_at IS NULL AND e.starts_at > now()) >= 100 THEN
    RAISE EXCEPTION 'This room already has 100 upcoming events.' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.room_events (room_id, created_by, title, details, starts_at, ends_at)
  VALUES (p_room_id, auth.uid(), btrim(p_title), COALESCE(p_details, ''), p_starts_at, p_ends_at)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_room_event(p_event_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_row public.room_events%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.room_events e WHERE e.id = p_event_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL
     OR (v_row.created_by <> auth.uid() AND NOT public.room_has_capability(v_row.room_id, auth.uid(), 'manage_announcements'))
     OR NOT public.room_has_capability(v_row.room_id, auth.uid(), 'chat') THEN
    RAISE EXCEPTION 'Only the organiser or an announcement manager can cancel this event.' USING ERRCODE = '42501';
  END IF;
  UPDATE public.room_events SET cancelled_at = COALESCE(cancelled_at, now()) WHERE id = p_event_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_room_event_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_member uuid;
  v_text text;
  v_kind text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_kind := 'scheduled';
    v_text := left(public.notification_user_label(NEW.created_by), 80) || ' scheduled "' || left(NEW.title, 120)
      || '" for ' || to_char(NEW.starts_at AT TIME ZONE 'UTC', 'Mon DD, HH24:MI') || ' UTC';
  ELSIF NEW.cancelled_at IS NOT NULL AND OLD.cancelled_at IS NULL THEN
    v_kind := 'cancelled';
    v_text := 'Cancelled: "' || left(NEW.title, 120) || '"';
  ELSE
    RETURN NULL;
  END IF;
  BEGIN
    FOR v_member IN
      SELECT rm.user_id FROM public.room_members rm
      WHERE rm.room_id = NEW.room_id AND rm.join_status = 'approved'
    LOOP
      IF public.room_member_can(NEW.room_id, v_member, 'chat') THEN
        PERFORM public.enqueue_room_notification(
          v_member, NEW.room_id, 'room_event', v_text,
          jsonb_build_object('event_id', NEW.id, 'starts_at', NEW.starts_at),
          COALESCE(auth.uid(), NEW.created_by), NEW.id,
          'room-event-' || v_kind || ':' || NEW.id::text);
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'room event notification skipped (%)', SQLSTATE;
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.notify_room_event_change() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS notify_room_event_change ON public.room_events;
CREATE TRIGGER notify_room_event_change
AFTER INSERT OR UPDATE OF cancelled_at ON public.room_events
FOR EACH ROW EXECUTE FUNCTION public.notify_room_event_change();

-- ---------------------------------------------------------------------------
-- 7. Study resources (YouTube / lecture media / links), personal progress,
--    timestamped notes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.room_study_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  added_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('youtube', 'media', 'link')),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  url text CHECK (url IS NULL OR (char_length(url) <= 2000 AND url ~ '^https://[^[:space:]]+$')),
  media_id uuid REFERENCES public.temporary_media(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'media') = (media_id IS NOT NULL)),
  CHECK (kind = 'media' OR url IS NOT NULL),
  CHECK (kind <> 'youtube' OR url ~* '^https://(www\.|m\.)?(youtube\.com|youtu\.be)/')
);
CREATE INDEX IF NOT EXISTS room_study_resources_room_idx ON public.room_study_resources (room_id, created_at DESC);
CREATE TABLE IF NOT EXISTS public.room_resource_progress (
  resource_id uuid NOT NULL REFERENCES public.room_study_resources(id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  position_seconds numeric NOT NULL CHECK (position_seconds >= 0 AND position_seconds <= 86400),
  duration_seconds numeric CHECK (duration_seconds IS NULL OR (duration_seconds > 0 AND duration_seconds <= 86400)),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_id, user_id)
);
CREATE TABLE IF NOT EXISTS public.room_resource_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id uuid NOT NULL REFERENCES public.room_study_resources(id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  at_seconds numeric NOT NULL CHECK (at_seconds >= 0 AND at_seconds <= 86400),
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000),
  scope text NOT NULL DEFAULT 'room' CHECK (scope IN ('room', 'personal')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS room_resource_notes_resource_idx ON public.room_resource_notes (resource_id, at_seconds);
ALTER TABLE public.room_study_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_resource_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_resource_notes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.room_study_resources, public.room_resource_progress, public.room_resource_notes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.room_study_resources, public.room_resource_progress, public.room_resource_notes TO authenticated;
DROP POLICY IF EXISTS "Study members read resources" ON public.room_study_resources;
CREATE POLICY "Study members read resources" ON public.room_study_resources FOR SELECT TO authenticated
USING (public.room_has_capability(room_id, auth.uid(), 'study'));
DROP POLICY IF EXISTS "Members read their own resource progress" ON public.room_resource_progress;
CREATE POLICY "Members read their own resource progress" ON public.room_resource_progress FOR SELECT TO authenticated
USING (user_id = auth.uid() AND public.room_has_capability(room_id, auth.uid(), 'study'));
DROP POLICY IF EXISTS "Study members read resource notes" ON public.room_resource_notes;
CREATE POLICY "Study members read resource notes" ON public.room_resource_notes FOR SELECT TO authenticated
USING (public.room_has_capability(room_id, auth.uid(), 'study') AND (scope = 'room' OR user_id = auth.uid()));

CREATE OR REPLACE FUNCTION public.add_study_resource(
  p_room_id uuid, p_kind text, p_title text, p_url text DEFAULT NULL, p_media_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.room_has_capability(p_room_id, auth.uid(), 'study') THEN
    RAISE EXCEPTION 'Not authorized to add study resources in this room.' USING ERRCODE = '42501';
  END IF;
  IF p_kind NOT IN ('youtube', 'media', 'link') OR char_length(COALESCE(btrim(p_title), '')) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'A resource needs a type and a title (200 characters).' USING ERRCODE = '22023';
  END IF;
  IF p_kind = 'media' THEN
    IF p_media_id IS NULL OR NOT public.room_media_is_live(p_room_id, p_media_id) THEN
      RAISE EXCEPTION 'Choose lecture media that is still available in this room.' USING ERRCODE = 'P0002';
    END IF;
  ELSIF p_url IS NULL OR char_length(p_url) > 2000 OR p_url !~ '^https://[^[:space:]]+$'
        OR (p_kind = 'youtube' AND p_url !~* '^https://(www\.|m\.)?(youtube\.com|youtu\.be)/') THEN
    RAISE EXCEPTION 'Enter an https:// link (YouTube links for YouTube resources).' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM public.room_study_resources r WHERE r.room_id = p_room_id) >= 200 THEN
    RAISE EXCEPTION 'This room already has 200 study resources.' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.room_study_resources (room_id, added_by, kind, title, url, media_id)
  VALUES (p_room_id, auth.uid(), p_kind, btrim(p_title),
          CASE WHEN p_kind = 'media' THEN NULL ELSE p_url END,
          CASE WHEN p_kind = 'media' THEN p_media_id ELSE NULL END)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_study_resource(p_resource_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_row public.room_study_resources%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.room_study_resources r WHERE r.id = p_resource_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF auth.uid() IS NULL OR NOT public.room_has_capability(v_row.room_id, auth.uid(), 'study')
     OR (v_row.added_by <> auth.uid() AND NOT public.room_has_capability(v_row.room_id, auth.uid(), 'manage_members')) THEN
    RAISE EXCEPTION 'Only the member who added it or a room manager can remove this resource.' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.room_study_resources WHERE id = p_resource_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_resource_progress(p_resource_id uuid, p_position numeric, p_duration numeric DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_room uuid;
BEGIN
  SELECT r.room_id INTO v_room FROM public.room_study_resources r WHERE r.id = p_resource_id;
  IF v_room IS NULL OR auth.uid() IS NULL OR NOT public.room_has_capability(v_room, auth.uid(), 'study') THEN
    RAISE EXCEPTION 'Not authorized to save progress for this resource.' USING ERRCODE = '42501';
  END IF;
  IF p_position IS NULL OR p_position < 0 OR p_position > 86400
     OR (p_duration IS NOT NULL AND (p_duration <= 0 OR p_duration > 86400)) THEN
    RAISE EXCEPTION 'Invalid playback position.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.room_resource_progress (resource_id, room_id, user_id, position_seconds, duration_seconds, updated_at)
  VALUES (p_resource_id, v_room, auth.uid(), p_position, p_duration, now())
  ON CONFLICT (resource_id, user_id) DO UPDATE
  SET position_seconds = EXCLUDED.position_seconds,
      duration_seconds = COALESCE(EXCLUDED.duration_seconds, public.room_resource_progress.duration_seconds),
      updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.add_resource_note(p_resource_id uuid, p_at_seconds numeric, p_body text, p_scope text DEFAULT 'room')
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_room uuid;
  v_id uuid;
BEGIN
  SELECT r.room_id INTO v_room FROM public.room_study_resources r WHERE r.id = p_resource_id;
  IF v_room IS NULL OR auth.uid() IS NULL OR NOT public.room_has_capability(v_room, auth.uid(), 'study') THEN
    RAISE EXCEPTION 'Not authorized to add notes to this resource.' USING ERRCODE = '42501';
  END IF;
  IF p_at_seconds IS NULL OR p_at_seconds < 0 OR p_at_seconds > 86400 OR p_scope NOT IN ('room', 'personal')
     OR char_length(COALESCE(btrim(p_body), '')) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'A timestamped note needs text (2000 characters) and a valid time.' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM public.room_resource_notes n WHERE n.resource_id = p_resource_id) >= 1000 THEN
    RAISE EXCEPTION 'This resource already has 1000 notes.' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.room_resource_notes (resource_id, room_id, user_id, at_seconds, body, scope)
  VALUES (p_resource_id, v_room, auth.uid(), p_at_seconds, btrim(p_body), p_scope)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_resource_note(p_note_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_row public.room_resource_notes%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.room_resource_notes n WHERE n.id = p_note_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF auth.uid() IS NULL OR NOT public.room_has_capability(v_row.room_id, auth.uid(), 'study')
     OR (v_row.user_id <> auth.uid()
         AND (v_row.scope <> 'room' OR NOT public.room_has_capability(v_row.room_id, auth.uid(), 'manage_members'))) THEN
    RAISE EXCEPTION 'Only the author or a room manager can delete this note.' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.room_resource_notes WHERE id = p_note_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. Voice moderation (owner/manager mute and stop screen share). Listeners
--    enforce it too, so a modified client cannot keep talking to the room.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.room_voice_moderation (
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  audio_muted boolean NOT NULL DEFAULT false,
  screen_blocked boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);
ALTER TABLE public.room_voice_moderation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.room_voice_moderation FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.room_voice_moderation TO authenticated;
DROP POLICY IF EXISTS "Chat members read voice moderation" ON public.room_voice_moderation;
CREATE POLICY "Chat members read voice moderation" ON public.room_voice_moderation FOR SELECT TO authenticated
USING (public.room_has_capability(room_id, auth.uid(), 'chat'));

CREATE OR REPLACE FUNCTION public.set_room_voice_moderation(
  p_room_id uuid, p_user_id uuid, p_audio_muted boolean, p_screen_blocked boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_target_role text;
BEGIN
  IF auth.uid() IS NULL OR p_user_id IS NULL OR p_audio_muted IS NULL OR p_screen_blocked IS NULL
     OR NOT public.room_has_capability(p_room_id, auth.uid(), 'manage_members') THEN
    RAISE EXCEPTION 'Only the owner or a member manager can mute members.' USING ERRCODE = '42501';
  END IF;
  v_target_role := public.room_user_role(p_room_id, p_user_id);
  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'That person is not a member of this room.' USING ERRCODE = 'P0002';
  END IF;
  IF p_user_id = auth.uid() OR (v_target_role = 'owner' AND public.room_user_role(p_room_id, auth.uid()) <> 'owner') THEN
    RAISE EXCEPTION 'You cannot moderate this member.' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.room_voice_moderation (room_id, user_id, audio_muted, screen_blocked, updated_by, updated_at)
  VALUES (p_room_id, p_user_id, p_audio_muted, p_screen_blocked, auth.uid(), now())
  ON CONFLICT (room_id, user_id) DO UPDATE
  SET audio_muted = EXCLUDED.audio_muted, screen_blocked = EXCLUDED.screen_blocked,
      updated_by = EXCLUDED.updated_by, updated_at = now();
END;
$$;

-- ---------------------------------------------------------------------------
-- 9. Consented recordings (private bucket, retention) and manual transcripts.
--    Automatic transcription is AI and belongs to Action 17.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.room_recordings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'consent' CHECK (status IN ('consent', 'recording', 'stopped', 'cancelled', 'deleted')),
  participants uuid[] NOT NULL CHECK (cardinality(participants) BETWEEN 1 AND 12),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  stopped_at timestamptz,
  storage_path text CHECK (storage_path IS NULL OR storage_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(webm|ogg|m4a)$'),
  duration_seconds integer CHECK (duration_seconds IS NULL OR duration_seconds BETWEEN 0 AND 86400),
  retention_until timestamptz
);
CREATE INDEX IF NOT EXISTS room_recordings_room_idx ON public.room_recordings (room_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS room_recordings_one_active_idx ON public.room_recordings (room_id)
  WHERE status IN ('consent', 'recording');
CREATE TABLE IF NOT EXISTS public.room_recording_consents (
  recording_id uuid NOT NULL REFERENCES public.room_recordings(id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  decision text NOT NULL CHECK (decision IN ('granted', 'declined')),
  decided_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recording_id, user_id)
);
CREATE TABLE IF NOT EXISTS public.room_recording_transcripts (
  recording_id uuid PRIMARY KEY REFERENCES public.room_recordings(id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  body text NOT NULL DEFAULT '' CHECK (char_length(body) <= 200000),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.room_recordings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_recording_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_recording_transcripts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.room_recordings, public.room_recording_consents, public.room_recording_transcripts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.room_recordings, public.room_recording_consents, public.room_recording_transcripts TO authenticated;

-- Participants (and room managers) may see a recording; nobody else.
CREATE OR REPLACE FUNCTION public.can_view_room_recording(p_recording_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_row public.room_recordings%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RETURN false; END IF;
  SELECT * INTO v_row FROM public.room_recordings r WHERE r.id = p_recording_id;
  IF NOT FOUND OR NOT public.room_has_capability(v_row.room_id, auth.uid(), 'chat') THEN RETURN false; END IF;
  RETURN auth.uid() = ANY (v_row.participants)
    OR public.room_has_capability(v_row.room_id, auth.uid(), 'manage_members');
END;
$$;
REVOKE ALL ON FUNCTION public.can_view_room_recording(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_view_room_recording(uuid) TO authenticated;

DROP POLICY IF EXISTS "Participants read recordings" ON public.room_recordings;
CREATE POLICY "Participants read recordings" ON public.room_recordings FOR SELECT TO authenticated
USING (public.can_view_room_recording(id));
DROP POLICY IF EXISTS "Participants read recording consent" ON public.room_recording_consents;
CREATE POLICY "Participants read recording consent" ON public.room_recording_consents FOR SELECT TO authenticated
USING (public.can_view_room_recording(recording_id));
DROP POLICY IF EXISTS "Participants read transcripts" ON public.room_recording_transcripts;
CREATE POLICY "Participants read transcripts" ON public.room_recording_transcripts FOR SELECT TO authenticated
USING (public.can_view_room_recording(recording_id));

CREATE OR REPLACE FUNCTION public.request_room_recording(p_room_id uuid, p_participants uuid[])
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_participants uuid[];
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.room_has_capability(p_room_id, auth.uid(), 'manage_members')
     OR NOT public.room_has_capability(p_room_id, auth.uid(), 'chat') THEN
    RAISE EXCEPTION 'Only the owner or a member manager can ask to record.' USING ERRCODE = '42501';
  END IF;
  SELECT array_agg(DISTINCT u) INTO v_participants
  FROM unnest(array_append(COALESCE(p_participants, ARRAY[]::uuid[]), auth.uid())) AS t(u)
  WHERE u IS NOT NULL;
  IF cardinality(v_participants) > 12 THEN
    RAISE EXCEPTION 'A recording can include at most 12 participants.' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_participants) u WHERE NOT public.room_member_can(p_room_id, u, 'chat')) THEN
    RAISE EXCEPTION 'Every participant must be a member who can use voice.' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.room_recordings r WHERE r.room_id = p_room_id AND r.status IN ('consent', 'recording')) THEN
    RAISE EXCEPTION 'A recording is already pending or running in this room.' USING ERRCODE = '23505';
  END IF;
  INSERT INTO public.room_recordings (room_id, requested_by, participants)
  VALUES (p_room_id, auth.uid(), v_participants)
  RETURNING id INTO v_id;
  INSERT INTO public.room_recording_consents (recording_id, room_id, user_id, decision)
  VALUES (v_id, p_room_id, auth.uid(), 'granted');
  IF cardinality(v_participants) = 1 THEN
    UPDATE public.room_recordings SET status = 'recording', started_at = now() WHERE id = v_id;
  END IF;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.respond_room_recording(p_recording_id uuid, p_granted boolean)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.room_recordings%ROWTYPE;
  v_granted integer;
BEGIN
  SELECT * INTO v_row FROM public.room_recordings r WHERE r.id = p_recording_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR p_granted IS NULL OR NOT (auth.uid() = ANY (v_row.participants))
     OR NOT public.room_has_capability(v_row.room_id, auth.uid(), 'chat') THEN
    RAISE EXCEPTION 'Only listed participants can answer this recording request.' USING ERRCODE = '42501';
  END IF;
  IF v_row.status <> 'consent' THEN
    RAISE EXCEPTION 'This recording request is no longer waiting for consent.' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.room_recording_consents (recording_id, room_id, user_id, decision)
  VALUES (p_recording_id, v_row.room_id, auth.uid(), CASE WHEN p_granted THEN 'granted' ELSE 'declined' END)
  ON CONFLICT (recording_id, user_id) DO UPDATE SET decision = EXCLUDED.decision, decided_at = now();
  IF NOT p_granted THEN
    UPDATE public.room_recordings SET status = 'cancelled', stopped_at = now() WHERE id = p_recording_id;
    RETURN 'cancelled';
  END IF;
  SELECT count(*) INTO v_granted FROM public.room_recording_consents c
  WHERE c.recording_id = p_recording_id AND c.decision = 'granted' AND c.user_id = ANY (v_row.participants);
  IF v_granted = cardinality(v_row.participants) THEN
    UPDATE public.room_recordings SET status = 'recording', started_at = now() WHERE id = p_recording_id;
    RETURN 'recording';
  END IF;
  RETURN 'consent';
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_room_recording(p_recording_id uuid, p_storage_path text, p_duration_seconds integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_row public.room_recordings%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.room_recordings r WHERE r.id = p_recording_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR v_row.requested_by <> auth.uid() THEN
    RAISE EXCEPTION 'Only the member who started this recording can finish it.' USING ERRCODE = '42501';
  END IF;
  IF v_row.status <> 'recording' THEN
    RAISE EXCEPTION 'This recording is not running.' USING ERRCODE = '23514';
  END IF;
  IF p_storage_path IS NULL OR p_storage_path !~ ('^' || v_row.room_id::text || '/' || v_row.id::text || '\.(webm|ogg|m4a)$')
     OR p_duration_seconds IS NULL OR p_duration_seconds NOT BETWEEN 0 AND 86400 THEN
    RAISE EXCEPTION 'Invalid recording file.' USING ERRCODE = '22023';
  END IF;
  UPDATE public.room_recordings
  SET status = 'stopped', stopped_at = now(), storage_path = p_storage_path,
      duration_seconds = p_duration_seconds, retention_until = now() + interval '7 days'
  WHERE id = p_recording_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_room_recording(p_recording_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_row public.room_recordings%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.room_recordings r WHERE r.id = p_recording_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL
     OR (v_row.requested_by <> auth.uid() AND NOT public.room_has_capability(v_row.room_id, auth.uid(), 'manage_members')) THEN
    RAISE EXCEPTION 'Only the requester or a room manager can cancel this recording.' USING ERRCODE = '42501';
  END IF;
  IF v_row.status IN ('consent', 'recording') THEN
    UPDATE public.room_recordings SET status = 'cancelled', stopped_at = now() WHERE id = p_recording_id;
  END IF;
END;
$$;

-- Marks a finished recording deleted and returns its storage path so the
-- caller removes the object (storage delete policy below).
CREATE OR REPLACE FUNCTION public.delete_room_recording(p_recording_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_row public.room_recordings%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.room_recordings r WHERE r.id = p_recording_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL
     OR (v_row.requested_by <> auth.uid() AND NOT public.room_has_capability(v_row.room_id, auth.uid(), 'manage_members')) THEN
    RAISE EXCEPTION 'Only the requester or a room manager can delete this recording.' USING ERRCODE = '42501';
  END IF;
  UPDATE public.room_recordings SET status = 'deleted' WHERE id = p_recording_id;
  DELETE FROM public.room_recording_transcripts t WHERE t.recording_id = p_recording_id;
  RETURN v_row.storage_path;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_room_transcript(p_recording_id uuid, p_expected_version bigint, p_body text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.room_recordings%ROWTYPE;
  v_version bigint;
BEGIN
  SELECT * INTO v_row FROM public.room_recordings r WHERE r.id = p_recording_id;
  IF NOT FOUND OR NOT public.can_view_room_recording(p_recording_id) THEN
    RAISE EXCEPTION 'Only participants can edit this transcript.' USING ERRCODE = '42501';
  END IF;
  IF v_row.status <> 'stopped' OR char_length(COALESCE(p_body, '')) > 200000 THEN
    RAISE EXCEPTION 'Transcripts can be written for finished recordings (200000 characters).' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_expected_version, 0) = 0 THEN
    INSERT INTO public.room_recording_transcripts (recording_id, room_id, body, updated_by)
    VALUES (p_recording_id, v_row.room_id, COALESCE(p_body, ''), auth.uid())
    ON CONFLICT (recording_id) DO NOTHING
    RETURNING version INTO v_version;
  ELSE
    UPDATE public.room_recording_transcripts
    SET body = COALESCE(p_body, ''), version = version + 1, updated_by = auth.uid(), updated_at = now()
    WHERE recording_id = p_recording_id AND version = p_expected_version
    RETURNING version INTO v_version;
  END IF;
  IF v_version IS NULL THEN
    RAISE EXCEPTION 'Transcript update rejected: expected version does not match.' USING ERRCODE = '40001';
  END IF;
  RETURN v_version;
END;
$$;

-- Service-role only: the cleanup job deletes recordings past retention and
-- removes the returned objects.
CREATE OR REPLACE FUNCTION public.expire_room_recordings()
RETURNS TABLE (storage_path text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.room_recordings r SET status = 'deleted'
  WHERE r.status = 'stopped' AND r.retention_until IS NOT NULL AND r.retention_until < now()
  RETURNING r.storage_path;
END;
$$;
REVOKE ALL ON FUNCTION public.expire_room_recordings() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_room_recordings() TO service_role;

-- Private recordings bucket: objects live at <room_id>/<recording_id>.<ext>.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('room_recordings', 'room_recordings', false, 104857600, ARRAY['audio/webm', 'audio/ogg', 'audio/mp4'])
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.room_recording_object_access(p_name text, p_action text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_match text[];
  v_row public.room_recordings%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR p_name IS NULL THEN RETURN false; END IF;
  v_match := regexp_match(p_name, '^([0-9a-f-]{36})/([0-9a-f-]{36})\.(webm|ogg|m4a)$');
  IF v_match IS NULL THEN RETURN false; END IF;
  SELECT * INTO v_row FROM public.room_recordings r WHERE r.id = v_match[2]::uuid AND r.room_id = v_match[1]::uuid;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_action = 'insert' THEN
    RETURN v_row.status = 'recording' AND v_row.requested_by = auth.uid()
      AND public.room_has_capability(v_row.room_id, auth.uid(), 'chat');
  ELSIF p_action = 'select' THEN
    RETURN v_row.status = 'stopped' AND public.can_view_room_recording(v_row.id);
  ELSIF p_action = 'delete' THEN
    RETURN v_row.status IN ('recording', 'stopped', 'cancelled', 'deleted')
      AND (v_row.requested_by = auth.uid() OR public.room_has_capability(v_row.room_id, auth.uid(), 'manage_members'));
  END IF;
  RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION public.room_recording_object_access(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.room_recording_object_access(text, text) TO authenticated;

DROP POLICY IF EXISTS "Recorder uploads a consented recording" ON storage.objects;
CREATE POLICY "Recorder uploads a consented recording" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'room_recordings' AND public.room_recording_object_access(name, 'insert'));
DROP POLICY IF EXISTS "Participants read finished recordings" ON storage.objects;
CREATE POLICY "Participants read finished recordings" ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'room_recordings' AND public.room_recording_object_access(name, 'select'));
DROP POLICY IF EXISTS "Requester or manager deletes recordings" ON storage.objects;
CREATE POLICY "Requester or manager deletes recordings" ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'room_recordings' AND public.room_recording_object_access(name, 'delete'));

-- ---------------------------------------------------------------------------
-- 10. Searchable history (capability-scoped per source)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_room_history(p_room_id uuid, p_query text, p_limit integer DEFAULT 40)
RETURNS TABLE (kind text, item_id uuid, title text, snippet text, created_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_query text := btrim(COALESCE(p_query, ''));
  v_pattern text;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 40), 1), 100);
  v_chat boolean;
  v_study boolean;
  v_watch boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT public.room_has_active_access(p_room_id) THEN
    RAISE EXCEPTION 'Not authorized to search this room.' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_query) NOT BETWEEN 2 AND 100 THEN
    RAISE EXCEPTION 'Search for 2 to 100 characters.' USING ERRCODE = '22023';
  END IF;
  v_chat := public.room_has_capability(p_room_id, auth.uid(), 'chat');
  v_study := public.room_has_capability(p_room_id, auth.uid(), 'study');
  v_watch := public.room_has_capability(p_room_id, auth.uid(), 'watch');
  IF NOT (v_chat OR v_study OR v_watch) THEN
    RAISE EXCEPTION 'Not authorized to search this room.' USING ERRCODE = '42501';
  END IF;
  v_pattern := '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  RETURN QUERY
  SELECT * FROM (
    SELECT 'message'::text, m.id, 'Chat message'::text, left(m.content, 240), m.created_at
    FROM public.messages m
    WHERE v_chat AND m.room_id = p_room_id AND COALESCE(m.is_deleted, false) = false
      AND m.content IS NOT NULL AND m.content ILIKE v_pattern
    UNION ALL
    SELECT 'note', n.id, n.title, left(n.content, 240), n.updated_at
    FROM public.study_notes n
    WHERE v_study AND n.room_id = p_room_id AND (n.scope = 'room' OR n.owner_id = auth.uid())
      AND (n.title ILIKE v_pattern OR n.content ILIKE v_pattern)
    UNION ALL
    SELECT 'task', t.id, t.title, left(t.details, 240), t.created_at
    FROM public.room_tasks t
    WHERE v_study AND t.room_id = p_room_id AND (t.title ILIKE v_pattern OR t.details ILIKE v_pattern)
    UNION ALL
    SELECT 'poll', p.id, p.question, array_to_string(p.options, ' · '), p.created_at
    FROM public.room_polls p
    WHERE v_chat AND p.room_id = p_room_id
      AND (p.question ILIKE v_pattern OR array_to_string(p.options, ' ') ILIKE v_pattern)
    UNION ALL
    SELECT 'event', e.id, e.title, left(e.details, 240), e.starts_at
    FROM public.room_events e
    WHERE v_chat AND e.room_id = p_room_id AND (e.title ILIKE v_pattern OR e.details ILIKE v_pattern)
    UNION ALL
    SELECT 'clip', c.id, c.label, NULL::text, c.created_at
    FROM public.room_media_clips c
    WHERE v_watch AND c.room_id = p_room_id AND c.label ILIKE v_pattern
    UNION ALL
    SELECT 'resource', r.id, r.title, NULL::text, r.created_at
    FROM public.room_study_resources r
    WHERE v_study AND r.room_id = p_room_id AND r.title ILIKE v_pattern
    UNION ALL
    SELECT 'resource_note', rn.id, 'Timestamped note'::text, left(rn.body, 240), rn.created_at
    FROM public.room_resource_notes rn
    WHERE v_study AND rn.room_id = p_room_id AND (rn.scope = 'room' OR rn.user_id = auth.uid())
      AND rn.body ILIKE v_pattern
    UNION ALL
    SELECT 'transcript', tr.recording_id, 'Recording transcript'::text, left(tr.body, 240), tr.updated_at
    FROM public.room_recording_transcripts tr
    JOIN public.room_recordings rec ON rec.id = tr.recording_id
    WHERE v_chat AND tr.room_id = p_room_id AND rec.status = 'stopped'
      AND public.can_view_room_recording(tr.recording_id) AND tr.body ILIKE v_pattern
  ) AS results (kind, item_id, title, snippet, created_at)
  ORDER BY results.created_at DESC
  LIMIT v_limit;
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants: RPCs for signed-in members only.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  public.list_study_note_versions(uuid),
  public.restore_study_note_version(uuid, bigint, bigint),
  public.set_study_note_locked(uuid, boolean),
  public.raise_room_hand(uuid),
  public.lower_room_hand(uuid, uuid),
  public.create_room_poll(uuid, text, text[]),
  public.vote_room_poll(uuid, integer),
  public.close_room_poll(uuid),
  public.delete_room_poll(uuid),
  public.get_room_poll_results(uuid),
  public.create_room_countdown(uuid, text, timestamptz),
  public.cancel_room_countdown(uuid),
  public.create_room_task(uuid, text, text, uuid, timestamptz),
  public.update_room_task(uuid, text, text, uuid, timestamptz),
  public.set_room_task_done(uuid, boolean),
  public.delete_room_task(uuid),
  public.create_room_event(uuid, text, text, timestamptz, timestamptz),
  public.cancel_room_event(uuid),
  public.add_study_resource(uuid, text, text, text, uuid),
  public.delete_study_resource(uuid),
  public.save_resource_progress(uuid, numeric, numeric),
  public.add_resource_note(uuid, numeric, text, text),
  public.delete_resource_note(uuid),
  public.set_room_voice_moderation(uuid, uuid, boolean, boolean),
  public.request_room_recording(uuid, uuid[]),
  public.respond_room_recording(uuid, boolean),
  public.finish_room_recording(uuid, text, integer),
  public.cancel_room_recording(uuid),
  public.delete_room_recording(uuid),
  public.save_room_transcript(uuid, bigint, text),
  public.search_room_history(uuid, text, integer)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.list_study_note_versions(uuid),
  public.restore_study_note_version(uuid, bigint, bigint),
  public.set_study_note_locked(uuid, boolean),
  public.raise_room_hand(uuid),
  public.lower_room_hand(uuid, uuid),
  public.create_room_poll(uuid, text, text[]),
  public.vote_room_poll(uuid, integer),
  public.close_room_poll(uuid),
  public.delete_room_poll(uuid),
  public.get_room_poll_results(uuid),
  public.create_room_countdown(uuid, text, timestamptz),
  public.cancel_room_countdown(uuid),
  public.create_room_task(uuid, text, text, uuid, timestamptz),
  public.update_room_task(uuid, text, text, uuid, timestamptz),
  public.set_room_task_done(uuid, boolean),
  public.delete_room_task(uuid),
  public.create_room_event(uuid, text, text, timestamptz, timestamptz),
  public.cancel_room_event(uuid),
  public.add_study_resource(uuid, text, text, text, uuid),
  public.delete_study_resource(uuid),
  public.save_resource_progress(uuid, numeric, numeric),
  public.add_resource_note(uuid, numeric, text, text),
  public.delete_resource_note(uuid),
  public.set_room_voice_moderation(uuid, uuid, boolean, boolean),
  public.request_room_recording(uuid, uuid[]),
  public.respond_room_recording(uuid, boolean),
  public.finish_room_recording(uuid, text, integer),
  public.cancel_room_recording(uuid),
  public.delete_room_recording(uuid),
  public.save_room_transcript(uuid, bigint, text),
  public.search_room_history(uuid, text, integer)
TO authenticated;
