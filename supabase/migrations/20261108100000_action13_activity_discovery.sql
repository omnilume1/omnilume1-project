-- Action 13: activity, discovery, events and management. Additive only.
--
-- Privacy model
--   * Discovery (discover_rooms) returns only public, unlocked, unscheduled,
--     not-being-deleted, non-group rooms the viewer is not banned from. A
--     private, locked (invite-only) or converted room is never returned to a
--     non-member. E2EE exists for personal chats only (messages.ciphertext);
--     nothing here reads ciphertext.
--   * Activity rows hold kind + actor + entity id only. Labels are resolved
--     at read time and only when the viewer holds the matching capability.
--   * All writes go through SECURITY DEFINER RPCs/triggers with
--     search_path = ''. Helpers used by RLS policies stay executable by
--     authenticated (policies run as the caller).

-- ---------------------------------------------------------------------------
-- 1. Activity / room history
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.room_activity (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN (
    'member_joined', 'member_left', 'role_changed', 'announcement', 'file_shared',
    'poll_created', 'event_scheduled', 'task_created', 'task_done', 'note_created',
    'queue_added', 'clip_saved', 'group_converted'
  )),
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  entity_id uuid,
  detail text CHECK (detail IS NULL OR char_length(detail) <= 40),
  dedupe_key text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS room_activity_room_idx ON public.room_activity (room_id, created_at DESC);
ALTER TABLE public.room_activity ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.room_activity FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.room_activity TO authenticated;
DROP POLICY IF EXISTS "Approved members read room activity" ON public.room_activity;
CREATE POLICY "Approved members read room activity" ON public.room_activity FOR SELECT TO authenticated
USING (public.room_has_active_access(room_id) AND public.is_approved_room_member(room_id, auth.uid()));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'room_activity') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.room_activity;
  END IF;
END $$;

-- One trigger function for every source table. It never blocks the action
-- that caused it, never records ghost-mode members, and skips deletions
-- caused by the room itself being deleted.
CREATE OR REPLACE FUNCTION public.log_room_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_room uuid;
  v_kind text;
  v_actor uuid;
  v_entity uuid;
  v_detail text;
  v_key text;
BEGIN
  IF TG_TABLE_NAME = 'room_members' THEN
    IF TG_OP = 'DELETE' THEN
      IF OLD.join_status <> 'approved' OR OLD.is_ghost_mode
         OR NOT EXISTS (SELECT 1 FROM public.rooms r WHERE r.id = OLD.room_id) THEN
        RETURN NULL;
      END IF;
      v_room := OLD.room_id; v_kind := 'member_left'; v_actor := OLD.user_id; v_entity := OLD.user_id;
      v_key := 'member_left:' || OLD.user_id::text || ':' || floor(extract(epoch FROM clock_timestamp()))::bigint::text;
    ELSIF TG_OP = 'INSERT' THEN
      IF NEW.join_status <> 'approved' OR NEW.is_ghost_mode OR NEW.role = 'owner' THEN RETURN NULL; END IF;
      v_room := NEW.room_id; v_kind := 'member_joined'; v_actor := NEW.user_id; v_entity := NEW.user_id; v_detail := NEW.role;
      v_key := 'member_joined:' || NEW.user_id::text || ':' || floor(extract(epoch FROM NEW.joined_at))::bigint::text;
    ELSE
      IF NEW.is_ghost_mode THEN RETURN NULL; END IF;
      IF OLD.join_status <> 'approved' AND NEW.join_status = 'approved' THEN
        v_room := NEW.room_id; v_kind := 'member_joined'; v_actor := NEW.user_id; v_entity := NEW.user_id; v_detail := NEW.role;
        v_key := 'member_joined:' || NEW.user_id::text || ':' || floor(extract(epoch FROM clock_timestamp()))::bigint::text;
      ELSIF NEW.join_status = 'approved' AND OLD.role IS DISTINCT FROM NEW.role THEN
        v_room := NEW.room_id; v_kind := 'role_changed'; v_actor := auth.uid(); v_entity := NEW.user_id; v_detail := NEW.role;
        v_key := 'role_changed:' || NEW.user_id::text || ':' || NEW.role || ':' || floor(extract(epoch FROM clock_timestamp()))::bigint::text;
      ELSE
        RETURN NULL;
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'room_announcements' THEN
    v_room := NEW.room_id; v_kind := 'announcement'; v_actor := NEW.author_id; v_entity := NEW.id;
    v_key := 'announcement:' || NEW.id::text;
  ELSIF TG_TABLE_NAME = 'room_files' THEN
    IF NEW.retention_state <> 'active' THEN RETURN NULL; END IF;
    v_room := NEW.room_id; v_kind := 'file_shared'; v_actor := NEW.owner_id; v_entity := NEW.id;
    v_key := 'file_shared:' || NEW.id::text;
  ELSIF TG_TABLE_NAME = 'room_polls' THEN
    v_room := NEW.room_id; v_kind := 'poll_created'; v_actor := NEW.created_by; v_entity := NEW.id;
    v_key := 'poll_created:' || NEW.id::text;
  ELSIF TG_TABLE_NAME = 'room_events' THEN
    v_room := NEW.room_id; v_kind := 'event_scheduled'; v_actor := NEW.created_by; v_entity := NEW.id;
    v_key := 'event_scheduled:' || NEW.id::text;
  ELSIF TG_TABLE_NAME = 'room_tasks' THEN
    IF TG_OP = 'INSERT' THEN
      v_room := NEW.room_id; v_kind := 'task_created'; v_actor := NEW.created_by; v_entity := NEW.id;
      v_key := 'task_created:' || NEW.id::text;
    ELSIF NEW.status = 'done' AND OLD.status <> 'done' THEN
      v_room := NEW.room_id; v_kind := 'task_done'; v_actor := NEW.completed_by; v_entity := NEW.id;
      v_key := 'task_done:' || NEW.id::text || ':' || floor(extract(epoch FROM COALESCE(NEW.completed_at, now())))::bigint::text;
    ELSE
      RETURN NULL;
    END IF;
  ELSIF TG_TABLE_NAME = 'study_notes' THEN
    IF NEW.scope <> 'room' THEN RETURN NULL; END IF;
    v_room := NEW.room_id; v_kind := 'note_created'; v_actor := NEW.owner_id; v_entity := NEW.id;
    v_key := 'note_created:' || NEW.id::text;
  ELSIF TG_TABLE_NAME = 'room_media_queue' THEN
    v_room := NEW.room_id; v_kind := 'queue_added'; v_actor := NEW.added_by; v_entity := NEW.id;
    v_key := 'queue_added:' || NEW.id::text;
  ELSIF TG_TABLE_NAME = 'room_media_clips' THEN
    v_room := NEW.room_id; v_kind := 'clip_saved'; v_actor := NEW.created_by; v_entity := NEW.id;
    v_key := 'clip_saved:' || NEW.id::text;
  ELSE
    RETURN NULL;
  END IF;

  IF v_actor IS NOT NULL AND TG_TABLE_NAME <> 'room_members' AND EXISTS (
    SELECT 1 FROM public.room_members rm
    WHERE rm.room_id = v_room AND rm.user_id = v_actor AND rm.is_ghost_mode
  ) THEN
    v_actor := NULL;
  END IF;

  BEGIN
    INSERT INTO public.room_activity (room_id, kind, actor_id, entity_id, detail, dedupe_key)
    VALUES (v_room, v_kind, v_actor, v_entity, v_detail, v_key)
    ON CONFLICT (room_id, dedupe_key) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'room activity skipped (%)', SQLSTATE;
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.log_room_activity() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS log_room_activity ON public.room_members;
CREATE TRIGGER log_room_activity AFTER INSERT OR UPDATE OF join_status, role OR DELETE ON public.room_members
FOR EACH ROW EXECUTE FUNCTION public.log_room_activity();
DROP TRIGGER IF EXISTS log_room_activity ON public.room_announcements;
CREATE TRIGGER log_room_activity AFTER INSERT ON public.room_announcements
FOR EACH ROW EXECUTE FUNCTION public.log_room_activity();
DROP TRIGGER IF EXISTS log_room_activity ON public.room_files;
CREATE TRIGGER log_room_activity AFTER INSERT ON public.room_files
FOR EACH ROW EXECUTE FUNCTION public.log_room_activity();
DROP TRIGGER IF EXISTS log_room_activity ON public.room_polls;
CREATE TRIGGER log_room_activity AFTER INSERT ON public.room_polls
FOR EACH ROW EXECUTE FUNCTION public.log_room_activity();
DROP TRIGGER IF EXISTS log_room_activity ON public.room_events;
CREATE TRIGGER log_room_activity AFTER INSERT ON public.room_events
FOR EACH ROW EXECUTE FUNCTION public.log_room_activity();
DROP TRIGGER IF EXISTS log_room_activity ON public.room_tasks;
CREATE TRIGGER log_room_activity AFTER INSERT OR UPDATE OF status ON public.room_tasks
FOR EACH ROW EXECUTE FUNCTION public.log_room_activity();
DROP TRIGGER IF EXISTS log_room_activity ON public.study_notes;
CREATE TRIGGER log_room_activity AFTER INSERT ON public.study_notes
FOR EACH ROW EXECUTE FUNCTION public.log_room_activity();
DROP TRIGGER IF EXISTS log_room_activity ON public.room_media_queue;
CREATE TRIGGER log_room_activity AFTER INSERT ON public.room_media_queue
FOR EACH ROW EXECUTE FUNCTION public.log_room_activity();
DROP TRIGGER IF EXISTS log_room_activity ON public.room_media_clips;
CREATE TRIGGER log_room_activity AFTER INSERT ON public.room_media_clips
FOR EACH ROW EXECUTE FUNCTION public.log_room_activity();

CREATE OR REPLACE FUNCTION public.list_room_activity(
  p_room_id uuid, p_limit integer DEFAULT 40, p_before timestamptz DEFAULT NULL
)
RETURNS TABLE (
  id bigint, kind text, actor_id uuid, actor_name text, entity_id uuid,
  detail text, label text, created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_uid uuid := auth.uid();
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 40), 1), 100);
  v_chat boolean; v_files boolean; v_study boolean; v_watch boolean; v_ann boolean;
BEGIN
  IF v_uid IS NULL OR NOT public.room_has_active_access(p_room_id)
     OR NOT public.is_approved_room_member(p_room_id, v_uid) THEN
    RAISE EXCEPTION 'Not authorized to view this room''s activity.' USING ERRCODE = '42501';
  END IF;
  v_chat := public.room_has_capability(p_room_id, v_uid, 'chat');
  v_files := public.room_has_capability(p_room_id, v_uid, 'files');
  v_study := public.room_has_capability(p_room_id, v_uid, 'study');
  v_watch := public.room_has_capability(p_room_id, v_uid, 'watch');
  v_ann := public.room_feature_enabled(p_room_id, 'announcements');

  RETURN QUERY
  SELECT a.id, a.kind, a.actor_id,
         COALESCE(NULLIF(btrim(mp.display_name), ''), NULLIF(btrim(pr.display_name), ''), 'A member'),
         a.entity_id, a.detail,
         CASE a.kind
           WHEN 'announcement' THEN (SELECT left(x.body, 120) FROM public.room_announcements x WHERE v_ann AND x.id = a.entity_id AND x.room_id = a.room_id)
           WHEN 'file_shared' THEN (SELECT f.original_name FROM public.room_files f WHERE v_files AND f.id = a.entity_id AND f.room_id = a.room_id AND f.retention_state = 'active')
           WHEN 'poll_created' THEN (SELECT x.question FROM public.room_polls x WHERE v_chat AND x.id = a.entity_id AND x.room_id = a.room_id)
           WHEN 'event_scheduled' THEN (SELECT x.title FROM public.room_events x WHERE v_chat AND x.id = a.entity_id AND x.room_id = a.room_id)
           WHEN 'task_created' THEN (SELECT x.title FROM public.room_tasks x WHERE v_study AND x.id = a.entity_id AND x.room_id = a.room_id)
           WHEN 'task_done' THEN (SELECT x.title FROM public.room_tasks x WHERE v_study AND x.id = a.entity_id AND x.room_id = a.room_id)
           WHEN 'note_created' THEN (SELECT x.title FROM public.study_notes x WHERE v_study AND x.id = a.entity_id AND x.room_id = a.room_id AND x.scope = 'room')
           WHEN 'queue_added' THEN (SELECT tm.file_name FROM public.room_media_queue q JOIN public.temporary_media tm ON tm.id = q.media_id WHERE v_watch AND q.id = a.entity_id AND q.room_id = a.room_id)
           WHEN 'clip_saved' THEN (SELECT x.label FROM public.room_media_clips x WHERE v_watch AND x.id = a.entity_id AND x.room_id = a.room_id)
           WHEN 'group_converted' THEN (SELECT r.name FROM public.rooms r WHERE r.id = a.room_id)
           ELSE NULL
         END,
         a.created_at
  FROM public.room_activity a
  LEFT JOIN public.profiles pr ON pr.id = a.actor_id
  LEFT JOIN public.room_member_profiles mp ON mp.room_id = a.room_id AND mp.user_id = a.actor_id
  WHERE a.room_id = p_room_id AND (p_before IS NULL OR a.created_at < p_before)
  ORDER BY a.created_at DESC, a.id DESC
  LIMIT v_limit;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Room Pulse (live activity bar): counts only, capability-scoped
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_room_pulse(p_room_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_chat boolean; v_study boolean;
BEGIN
  IF v_uid IS NULL OR NOT public.room_has_active_access(p_room_id)
     OR NOT public.is_approved_room_member(p_room_id, v_uid) THEN
    RAISE EXCEPTION 'Not authorized to view this room.' USING ERRCODE = '42501';
  END IF;
  v_chat := public.room_has_capability(p_room_id, v_uid, 'chat');
  v_study := public.room_has_capability(p_room_id, v_uid, 'study');
  RETURN jsonb_build_object(
    'members', (SELECT count(*) FROM public.room_members rm
                WHERE rm.room_id = p_room_id AND rm.join_status = 'approved' AND NOT rm.is_ghost_mode
                  AND (rm.guest_expires_at IS NULL OR rm.guest_expires_at > now())),
    'chat_15m', CASE WHEN v_chat THEN (SELECT count(*) FROM public.messages m
                WHERE m.room_id = p_room_id AND m.created_at > now() - interval '15 minutes'
                  AND NOT COALESCE(m.is_deleted, false)) END,
    'activity_1h', (SELECT count(*) FROM public.room_activity a
                    WHERE a.room_id = p_room_id AND a.created_at > now() - interval '1 hour'),
    'next_event', CASE WHEN v_chat THEN (SELECT jsonb_build_object('id', e.id, 'title', e.title, 'starts_at', e.starts_at)
                  FROM public.room_events e
                  WHERE e.room_id = p_room_id AND e.cancelled_at IS NULL
                    AND COALESCE(e.ends_at, e.starts_at + interval '1 hour') > now()
                  ORDER BY e.starts_at LIMIT 1) END,
    'open_tasks_mine', CASE WHEN v_study THEN (SELECT count(*) FROM public.room_tasks t
                  WHERE t.room_id = p_room_id AND t.assignee_id = v_uid AND t.status = 'open') END
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Discovery: search + filters, privacy enforced here
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.discover_rooms(
  p_query text DEFAULT NULL,
  p_lifespan text DEFAULT NULL,
  p_min_members integer DEFAULT NULL,
  p_feature text DEFAULT NULL,
  p_sort text DEFAULT 'newest',
  p_scope text DEFAULT 'public',
  p_limit integer DEFAULT 24,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid, name text, description text, username text, expiration_type text,
  deletion_scheduled_at timestamptz, created_at timestamptz, member_count integer,
  is_private boolean, viewer_role text, last_activity_at timestamptz,
  feature_flags jsonb, bookmarked boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_uid uuid := auth.uid();
  v_query text := btrim(COALESCE(p_query, ''));
  v_pattern text;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 24), 1), 48);
  v_offset integer := LEAST(GREATEST(COALESCE(p_offset, 0), 0), 10000);
BEGIN
  IF p_lifespan IS NOT NULL AND p_lifespan NOT IN ('permanent', 'recoverable', 'irreversible') THEN
    RAISE EXCEPTION 'Unknown lifespan filter.' USING ERRCODE = '22023';
  END IF;
  IF p_feature IS NOT NULL AND p_feature NOT IN ('chat', 'watch', 'files', 'study', 'announcements') THEN
    RAISE EXCEPTION 'Unknown feature filter.' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_sort, 'newest') NOT IN ('newest', 'members', 'active') THEN
    RAISE EXCEPTION 'Unknown sort.' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_scope, 'public') NOT IN ('public', 'mine') THEN
    RAISE EXCEPTION 'Unknown scope.' USING ERRCODE = '22023';
  END IF;
  IF p_min_members IS NOT NULL AND (p_min_members < 0 OR p_min_members > 100000) THEN
    RAISE EXCEPTION 'Unknown member filter.' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_query) > 100 THEN
    RAISE EXCEPTION 'Search for up to 100 characters.' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_scope, 'public') = 'mine' AND v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to search your rooms.' USING ERRCODE = '42501';
  END IF;
  v_pattern := '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  RETURN QUERY
  WITH visible AS (
    SELECT r.*,
           s.feature_flags AS flags,
           COALESCE(s.is_locked, false) AS locked,
           public.room_user_role(r.id, v_uid) AS my_role
    FROM public.rooms r
    LEFT JOIN public.room_control_settings s ON s.room_id = r.id
    WHERE public.room_has_active_access(r.id)
      AND (
        (COALESCE(p_scope, 'public') = 'public'
          AND NOT r.is_private AND NOT r.is_group AND r.scheduled_for IS NULL
          AND r.deletion_scheduled_at IS NULL AND NOT COALESCE(s.is_locked, false)
          AND (v_uid IS NULL OR NOT public.room_user_is_restricted(r.id, v_uid)))
        OR
        (p_scope = 'mine' AND public.is_approved_room_member(r.id, v_uid))
      )
      AND (p_lifespan IS NULL OR r.expiration_type = p_lifespan)
      AND (v_query = '' OR r.name ILIKE v_pattern OR COALESCE(r.username, '') ILIKE v_pattern
           OR COALESCE(r.description, '') ILIKE v_pattern)
      AND (p_feature IS NULL OR COALESCE(s.feature_flags ->> p_feature, 'true') = 'true')
  ), counted AS (
    SELECT v.*,
           (SELECT count(*)::integer FROM public.room_members rm
            WHERE rm.room_id = v.id AND rm.join_status = 'approved' AND NOT rm.is_ghost_mode
              AND (rm.guest_expires_at IS NULL OR rm.guest_expires_at > now())) AS members,
           (SELECT max(a.created_at) FROM public.room_activity a WHERE a.room_id = v.id) AS last_act
    FROM visible v
  )
  SELECT c.id, c.name, c.description,
         CASE WHEN c.is_private AND c.my_role IS NULL THEN NULL ELSE c.username END,
         c.expiration_type, c.deletion_scheduled_at, c.created_at, c.members,
         c.is_private, c.my_role, c.last_act, c.flags,
         EXISTS (SELECT 1 FROM public.room_bookmarks b
                 WHERE b.user_id = v_uid AND b.kind = 'room' AND b.entity_id = c.id)
  FROM counted c
  WHERE p_min_members IS NULL OR c.members >= p_min_members
  ORDER BY
    CASE WHEN COALESCE(p_sort, 'newest') = 'members' THEN c.members END DESC NULLS LAST,
    CASE WHEN COALESCE(p_sort, 'newest') = 'active' THEN c.last_act END DESC NULLS LAST,
    c.created_at DESC, c.id
  LIMIT v_limit OFFSET v_offset;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Bookmarks / saved content (private to the user)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.room_bookmarks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('room', 'message', 'file')),
  entity_id uuid NOT NULL,
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind, entity_id),
  CHECK (kind <> 'room' OR entity_id = room_id)
);
CREATE INDEX IF NOT EXISTS room_bookmarks_user_idx ON public.room_bookmarks (user_id, created_at DESC);
ALTER TABLE public.room_bookmarks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.room_bookmarks FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.room_bookmarks TO authenticated;
DROP POLICY IF EXISTS "Users read their own bookmarks" ON public.room_bookmarks;
CREATE POLICY "Users read their own bookmarks" ON public.room_bookmarks FOR SELECT TO authenticated
USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.set_room_bookmark(
  p_room_id uuid, p_kind text, p_entity_id uuid, p_saved boolean, p_note text DEFAULT ''
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to save items.' USING ERRCODE = '42501';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('room', 'message', 'file') OR p_room_id IS NULL OR p_entity_id IS NULL
     OR char_length(COALESCE(p_note, '')) > 200 THEN
    RAISE EXCEPTION 'That item cannot be saved.' USING ERRCODE = '22023';
  END IF;

  IF NOT COALESCE(p_saved, true) THEN
    DELETE FROM public.room_bookmarks
    WHERE user_id = v_uid AND kind = p_kind AND entity_id = p_entity_id;
    RETURN false;
  END IF;

  IF NOT public.room_has_active_access(p_room_id) OR public.room_user_is_restricted(p_room_id, v_uid) THEN
    RAISE EXCEPTION 'That item is not available.' USING ERRCODE = '42501';
  END IF;

  IF p_kind = 'room' THEN
    IF p_entity_id <> p_room_id THEN
      RAISE EXCEPTION 'That item cannot be saved.' USING ERRCODE = '22023';
    END IF;
    IF NOT public.is_approved_room_member(p_room_id, v_uid) AND NOT EXISTS (
      SELECT 1 FROM public.rooms r WHERE r.id = p_room_id AND NOT r.is_private AND NOT r.is_group
    ) THEN
      RAISE EXCEPTION 'That room is not available.' USING ERRCODE = '42501';
    END IF;
  ELSIF p_kind = 'message' THEN
    IF NOT public.room_has_capability(p_room_id, v_uid, 'chat') OR NOT EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.id = p_entity_id AND m.room_id = p_room_id AND NOT COALESCE(m.is_deleted, false) AND m.content IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'That message is not available.' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF NOT public.room_has_capability(p_room_id, v_uid, 'files') OR NOT EXISTS (
      SELECT 1 FROM public.room_files f
      WHERE f.id = p_entity_id AND f.room_id = p_room_id AND f.retention_state = 'active'
    ) THEN
      RAISE EXCEPTION 'That file is not available.' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF (SELECT count(*) FROM public.room_bookmarks b WHERE b.user_id = v_uid) >= 200
     AND NOT EXISTS (SELECT 1 FROM public.room_bookmarks b WHERE b.user_id = v_uid AND b.kind = p_kind AND b.entity_id = p_entity_id) THEN
    RAISE EXCEPTION 'You can save up to 200 items.' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.room_bookmarks (user_id, room_id, kind, entity_id, note)
  VALUES (v_uid, p_room_id, p_kind, p_entity_id, COALESCE(p_note, ''))
  ON CONFLICT (user_id, kind, entity_id) DO UPDATE SET note = EXCLUDED.note;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_my_bookmarks(p_limit integer DEFAULT 50)
RETURNS TABLE (
  id uuid, kind text, room_id uuid, room_name text, entity_id uuid,
  label text, note text, created_at timestamptz
)
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
    RAISE EXCEPTION 'Sign in to see saved items.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT b.id, b.kind, b.room_id, r.name, b.entity_id, l.label, b.note, b.created_at
  FROM public.room_bookmarks b
  JOIN public.rooms r ON r.id = b.room_id
  CROSS JOIN LATERAL (
    SELECT CASE b.kind
      WHEN 'room' THEN r.name
      WHEN 'message' THEN (SELECT left(m.content, 120) FROM public.messages m
        WHERE m.id = b.entity_id AND m.room_id = b.room_id AND NOT COALESCE(m.is_deleted, false)
          AND public.room_has_capability(b.room_id, v_uid, 'chat'))
      ELSE (SELECT f.original_name FROM public.room_files f
        WHERE f.id = b.entity_id AND f.room_id = b.room_id AND f.retention_state = 'active'
          AND public.room_has_capability(b.room_id, v_uid, 'files'))
    END AS label
  ) l
  WHERE b.user_id = v_uid
    AND l.label IS NOT NULL
    AND public.room_has_active_access(b.room_id)
    AND NOT public.room_user_is_restricted(b.room_id, v_uid)
    AND (public.is_approved_room_member(b.room_id, v_uid)
         OR (b.kind = 'room' AND NOT r.is_private AND NOT r.is_group))
  ORDER BY b.created_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Room templates (own + built-in)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.room_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  builtin_key text UNIQUE CHECK (builtin_key IS NULL OR char_length(builtin_key) BETWEEN 1 AND 40),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 200),
  config jsonb NOT NULL CHECK (
    jsonb_typeof(config) = 'object'
    AND config ?& ARRAY['is_private', 'expiration_type', 'feature_flags', 'default_layout', 'theme']
    AND config ->> 'expiration_type' IN ('permanent', 'recoverable', 'irreversible')
    AND config ->> 'default_layout' IN ('balanced', 'stage', 'chat')
    AND config ->> 'theme' IN ('violet', 'ocean', 'emerald', 'amber', 'rose', 'graphite')
    AND jsonb_typeof(config -> 'is_private') = 'boolean'
    AND jsonb_typeof(config -> 'feature_flags') = 'object'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_id IS NULL) = (builtin_key IS NOT NULL)),
  UNIQUE (owner_id, name)
);
ALTER TABLE public.room_templates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.room_templates FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.room_templates TO authenticated;
DROP POLICY IF EXISTS "Users read built-in and own templates" ON public.room_templates;
CREATE POLICY "Users read built-in and own templates" ON public.room_templates FOR SELECT TO authenticated
USING (owner_id IS NULL OR owner_id = auth.uid());

INSERT INTO public.room_templates (builtin_key, name, description, config) VALUES
  ('study-session', 'Study session', 'Focus timer, notes and whiteboard; Watch off.',
   '{"is_private": true, "expiration_type": "recoverable", "duration_hours": 24, "default_layout": "balanced", "theme": "emerald", "rules": "Stay on topic and keep chat short during focus blocks.", "welcome_message": "Welcome! Start the shared timer when everyone is ready.", "feature_flags": {"chat": true, "watch": false, "files": true, "study": true, "announcements": true}}'::jsonb),
  ('watch-party', 'Watch party', 'Watch together with chat; Study off.',
   '{"is_private": false, "expiration_type": "recoverable", "duration_hours": 6, "default_layout": "stage", "theme": "rose", "rules": "Be kind and avoid spoilers.", "welcome_message": "Grab a seat - the show starts soon.", "feature_flags": {"chat": true, "watch": true, "files": false, "study": false, "announcements": true}}'::jsonb),
  ('project-room', 'Project room', 'Everything on, kept as a permanent home.',
   '{"is_private": true, "expiration_type": "permanent", "duration_hours": null, "default_layout": "chat", "theme": "ocean", "rules": "", "welcome_message": "Welcome to the project room.", "feature_flags": {"chat": true, "watch": true, "files": true, "study": true, "announcements": true}}'::jsonb)
ON CONFLICT (builtin_key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.save_room_template(p_room_id uuid, p_name text, p_description text DEFAULT '')
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_room public.rooms%ROWTYPE;
  v_settings public.room_control_settings%ROWTYPE;
  v_id uuid;
BEGIN
  IF v_uid IS NULL OR NOT public.room_has_capability(p_room_id, v_uid, 'manage_settings') THEN
    RAISE EXCEPTION 'Only members who manage room settings can save a template.' USING ERRCODE = '42501';
  END IF;
  IF char_length(COALESCE(btrim(p_name), '')) NOT BETWEEN 1 AND 60 OR char_length(COALESCE(p_description, '')) > 200 THEN
    RAISE EXCEPTION 'Give the template a name of up to 60 characters.' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM public.room_templates t WHERE t.owner_id = v_uid) >= 20 THEN
    RAISE EXCEPTION 'You can keep up to 20 templates.' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_room FROM public.rooms r WHERE r.id = p_room_id;
  SELECT * INTO v_settings FROM public.room_control_settings s WHERE s.room_id = p_room_id;
  IF NOT FOUND OR v_room.id IS NULL THEN
    RAISE EXCEPTION 'That room is not available.' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.room_templates (owner_id, name, description, config)
  VALUES (v_uid, btrim(p_name), COALESCE(p_description, ''), jsonb_build_object(
    'is_private', v_room.is_private,
    'expiration_type', v_room.expiration_type,
    'duration_hours', CASE WHEN v_room.expiration_type = 'permanent' OR v_room.expires_at IS NULL THEN NULL
      ELSE LEAST(720, GREATEST(1, round(extract(epoch FROM (v_room.expires_at - v_room.created_at)) / 3600)))::integer END,
    'default_layout', v_settings.default_layout,
    'theme', v_settings.theme,
    'rules', v_settings.rules,
    'welcome_message', v_settings.welcome_message,
    'feature_flags', v_settings.feature_flags))
  RETURNING id INTO v_id;
  RETURN v_id;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'You already have a template with that name.' USING ERRCODE = '23505';
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_room_template(p_template_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.room_templates t WHERE t.id = p_template_id AND t.owner_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Template not found.' USING ERRCODE = '42501';
  END IF;
END;
$$;

-- Applies a template's room controls and appearance. Privacy and lifespan
-- are creation-time fields (applied by the create form), not changed here.
CREATE OR REPLACE FUNCTION public.apply_room_template(p_room_id uuid, p_template_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_config jsonb;
  v_settings public.room_control_settings%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR public.room_user_role(p_room_id, v_uid) IS DISTINCT FROM 'owner'
     OR NOT public.room_has_active_access(p_room_id) THEN
    RAISE EXCEPTION 'Only the room owner can apply a template.' USING ERRCODE = '42501';
  END IF;
  SELECT t.config INTO v_config FROM public.room_templates t
  WHERE t.id = p_template_id AND (t.owner_id IS NULL OR t.owner_id = v_uid);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Template not found.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_settings FROM public.room_control_settings s WHERE s.room_id = p_room_id;
  PERFORM public.update_room_controls(
    p_room_id, COALESCE(v_config ->> 'rules', ''), COALESCE(v_config ->> 'welcome_message', ''),
    v_settings.is_locked, v_config -> 'feature_flags');
  PERFORM public.update_room_appearance(
    p_room_id, v_config ->> 'default_layout', v_settings.layout_locked, v_config ->> 'theme');
  RETURN jsonb_build_object('applied', true);
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Trust levels: derived from facts, never stored, never self-assigned
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_room_trust_levels(p_room_id uuid)
RETURNS TABLE (user_id uuid, level text, tenure_days integer, contributions integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_uid uuid := auth.uid();
  v_manager boolean;
BEGIN
  IF v_uid IS NULL OR NOT public.room_has_active_access(p_room_id)
     OR NOT public.is_approved_room_member(p_room_id, v_uid) THEN
    RAISE EXCEPTION 'Not authorized to view this room.' USING ERRCODE = '42501';
  END IF;
  v_manager := public.room_has_capability(p_room_id, v_uid, 'manage_members');
  RETURN QUERY
  SELECT m.user_id,
         CASE
           WHEN m.role IN ('owner', 'admin') THEN 'steward'
           WHEN m.role = 'guest' THEN 'new'
           WHEN m.days >= 7 AND m.contrib >= 25 THEN 'trusted'
           WHEN m.days < 1 OR m.contrib < 3 THEN 'new'
           ELSE 'member'
         END,
         m.days, m.contrib
  FROM (
    SELECT rm.user_id, rm.role,
           GREATEST(0, floor(extract(epoch FROM (now() - rm.joined_at)) / 86400))::integer AS days,
           ((SELECT count(*) FROM public.messages x
             WHERE x.room_id = rm.room_id AND x.sender_id = rm.user_id AND NOT COALESCE(x.is_deleted, false))
            + (SELECT count(*) FROM public.room_activity a
               WHERE a.room_id = rm.room_id AND a.actor_id = rm.user_id
                 AND a.kind IN ('file_shared', 'poll_created', 'event_scheduled', 'task_created', 'task_done', 'note_created', 'clip_saved', 'queue_added')))::integer AS contrib
    FROM public.room_members rm
    WHERE rm.room_id = p_room_id AND rm.join_status = 'approved'
      AND (rm.guest_expires_at IS NULL OR rm.guest_expires_at > now())
      AND NOT public.room_user_is_restricted(rm.room_id, rm.user_id)
      AND (v_manager OR rm.user_id = v_uid)
  ) m;
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. Backup / export: owner or admin, rate limited, audited, no keys
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.room_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  truncated boolean NOT NULL DEFAULT false,
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS room_exports_room_idx ON public.room_exports (room_id, created_at DESC);
ALTER TABLE public.room_exports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.room_exports FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.room_exports TO authenticated;
DROP POLICY IF EXISTS "Room managers read export audit" ON public.room_exports;
CREATE POLICY "Room managers read export audit" ON public.room_exports FOR SELECT TO authenticated
USING (public.is_room_admin_or_owner(room_id, auth.uid()));

CREATE OR REPLACE FUNCTION public.export_room_snapshot(p_room_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_export uuid := gen_random_uuid();
  v_room jsonb; v_members jsonb; v_announcements jsonb; v_messages jsonb; v_notes jsonb;
  v_tasks jsonb; v_polls jsonb; v_events jsonb; v_files jsonb; v_clips jsonb;
  v_message_total integer; v_encrypted integer; v_truncated boolean;
  v_counts jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.room_has_active_access(p_room_id)
     OR NOT public.is_room_admin_or_owner(p_room_id, v_uid) THEN
    RAISE EXCEPTION 'Only a room owner or admin can export this room.' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.rooms r WHERE r.id = p_room_id FOR UPDATE;
  IF (SELECT count(*) FROM public.room_exports e
      WHERE e.room_id = p_room_id AND e.created_at > now() - interval '1 hour') >= 3
     OR (SELECT count(*) FROM public.room_exports e
         WHERE e.requested_by = v_uid AND e.created_at > now() - interval '1 day') >= 10 THEN
    RAISE EXCEPTION 'Export limit reached. Try again later.' USING ERRCODE = 'P0429';
  END IF;

  SELECT jsonb_build_object('id', r.id, 'name', r.name, 'description', r.description,
           'expiration_type', r.expiration_type, 'is_private', r.is_private, 'is_group', r.is_group,
           'created_at', r.created_at,
           'rules', s.rules, 'welcome_message', s.welcome_message, 'feature_flags', s.feature_flags,
           'default_layout', s.default_layout, 'theme', s.theme)
    INTO v_room
  FROM public.rooms r LEFT JOIN public.room_control_settings s ON s.room_id = r.id WHERE r.id = p_room_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id', rm.user_id, 'role', rm.role, 'joined_at', rm.joined_at,
           'display_name', COALESCE(NULLIF(btrim(mp.display_name), ''), pr.display_name)) ORDER BY rm.joined_at), '[]'::jsonb)
    INTO v_members
  FROM public.room_members rm
  LEFT JOIN public.profiles pr ON pr.id = rm.user_id
  LEFT JOIN public.room_member_profiles mp ON mp.room_id = rm.room_id AND mp.user_id = rm.user_id
  WHERE rm.room_id = p_room_id AND rm.join_status = 'approved';

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', a.id, 'author_id', a.author_id, 'body', a.body,
           'is_pinned', a.is_pinned, 'created_at', a.created_at) ORDER BY a.created_at), '[]'::jsonb)
    INTO v_announcements FROM public.room_announcements a WHERE a.room_id = p_room_id;

  -- Plaintext chat only: end-to-end encrypted rows (ciphertext) are counted,
  -- never exported, and no key material is read.
  SELECT count(*) FILTER (WHERE m.ciphertext IS NOT NULL), count(*) FILTER (WHERE m.ciphertext IS NULL AND m.content IS NOT NULL AND NOT COALESCE(m.is_deleted, false))
    INTO v_encrypted, v_message_total
  FROM public.messages m WHERE m.room_id = p_room_id;
  v_truncated := v_message_total > 5000;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', x.id, 'sender_id', x.sender_id, 'content', x.content,
           'created_at', x.created_at, 'reply_to_id', x.reply_to_id, 'pinned_at', x.pinned_at) ORDER BY x.created_at), '[]'::jsonb)
    INTO v_messages
  FROM (SELECT m.* FROM public.messages m
        WHERE m.room_id = p_room_id AND m.ciphertext IS NULL AND m.content IS NOT NULL AND NOT COALESCE(m.is_deleted, false)
        ORDER BY m.created_at DESC LIMIT 5000) x;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', n.id, 'title', n.title, 'content', n.content,
           'version', n.version, 'updated_at', n.updated_at) ORDER BY n.created_at), '[]'::jsonb)
    INTO v_notes FROM public.study_notes n WHERE n.room_id = p_room_id AND n.scope = 'room';
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'details', t.details,
           'assignee_id', t.assignee_id, 'due_at', t.due_at, 'status', t.status) ORDER BY t.created_at), '[]'::jsonb)
    INTO v_tasks FROM public.room_tasks t WHERE t.room_id = p_room_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', p.id, 'question', p.question, 'options', p.options,
           'closed_at', p.closed_at, 'created_at', p.created_at) ORDER BY p.created_at), '[]'::jsonb)
    INTO v_polls FROM public.room_polls p WHERE p.room_id = p_room_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', e.id, 'title', e.title, 'details', e.details,
           'starts_at', e.starts_at, 'ends_at', e.ends_at, 'cancelled_at', e.cancelled_at) ORDER BY e.starts_at), '[]'::jsonb)
    INTO v_events FROM public.room_events e WHERE e.room_id = p_room_id;
  -- File manifest only: no storage paths, URLs or signed links.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', f.id, 'name', f.original_name, 'mime_type', f.mime_type,
           'size_bytes', f.size_bytes, 'created_at', f.created_at) ORDER BY f.created_at), '[]'::jsonb)
    INTO v_files FROM public.room_files f WHERE f.room_id = p_room_id AND f.retention_state = 'active';
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', c.id, 'label', c.label, 'start_seconds', c.start_seconds,
           'end_seconds', c.end_seconds, 'created_at', c.created_at) ORDER BY c.created_at), '[]'::jsonb)
    INTO v_clips FROM public.room_media_clips c WHERE c.room_id = p_room_id;

  v_counts := jsonb_build_object('members', jsonb_array_length(v_members), 'messages', jsonb_array_length(v_messages),
    'encrypted_messages_excluded', v_encrypted, 'announcements', jsonb_array_length(v_announcements),
    'notes', jsonb_array_length(v_notes), 'tasks', jsonb_array_length(v_tasks), 'polls', jsonb_array_length(v_polls),
    'events', jsonb_array_length(v_events), 'files', jsonb_array_length(v_files), 'clips', jsonb_array_length(v_clips));

  INSERT INTO public.room_exports (id, room_id, requested_by, counts, truncated)
  VALUES (v_export, p_room_id, v_uid, v_counts, v_truncated);

  RETURN jsonb_build_object('export_id', v_export, 'format', 'omnilume-room-export-1', 'exported_at', now(),
    'truncated', v_truncated, 'counts', v_counts, 'room', v_room, 'members', v_members,
    'announcements', v_announcements, 'messages', v_messages, 'notes', v_notes, 'tasks', v_tasks,
    'polls', v_polls, 'events', v_events, 'files', v_files, 'clips', v_clips);
END;
$$;

-- The server records the SHA-256 of the exact bytes it returned (once).
CREATE OR REPLACE FUNCTION public.record_room_export_digest(p_export_id uuid, p_sha256 text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid digest.' USING ERRCODE = '22023';
  END IF;
  UPDATE public.room_exports e SET sha256 = p_sha256
  WHERE e.id = p_export_id AND e.requested_by = auth.uid() AND e.sha256 IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Export not found.' USING ERRCODE = '42501';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. Event management: RSVPs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.room_event_rsvps (
  event_id uuid NOT NULL REFERENCES public.room_events(id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  response text NOT NULL CHECK (response IN ('going', 'maybe', 'declined')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS room_event_rsvps_room_idx ON public.room_event_rsvps (room_id);
ALTER TABLE public.room_event_rsvps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.room_event_rsvps FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.room_event_rsvps TO authenticated;
DROP POLICY IF EXISTS "Read own or managed RSVPs" ON public.room_event_rsvps;
CREATE POLICY "Read own or managed RSVPs" ON public.room_event_rsvps FOR SELECT TO authenticated
USING (user_id = auth.uid() OR public.room_has_capability(room_id, auth.uid(), 'manage_announcements'));

CREATE OR REPLACE FUNCTION public.set_event_rsvp(p_event_id uuid, p_response text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_event public.room_events%ROWTYPE;
BEGIN
  SELECT * INTO v_event FROM public.room_events e WHERE e.id = p_event_id;
  IF v_uid IS NULL OR NOT FOUND OR NOT public.room_has_capability(v_event.room_id, v_uid, 'chat') THEN
    RAISE EXCEPTION 'You cannot respond to this event.' USING ERRCODE = '42501';
  END IF;
  IF p_response IS NULL THEN
    DELETE FROM public.room_event_rsvps WHERE event_id = p_event_id AND user_id = v_uid;
    RETURN;
  END IF;
  IF p_response NOT IN ('going', 'maybe', 'declined') THEN
    RAISE EXCEPTION 'Choose going, maybe or declined.' USING ERRCODE = '22023';
  END IF;
  IF v_event.cancelled_at IS NOT NULL OR COALESCE(v_event.ends_at, v_event.starts_at + interval '1 hour') < now() THEN
    RAISE EXCEPTION 'This event is no longer open for responses.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.room_event_rsvps (event_id, room_id, user_id, response)
  VALUES (p_event_id, v_event.room_id, v_uid, p_response)
  ON CONFLICT (event_id, user_id) DO UPDATE SET response = EXCLUDED.response, updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.list_event_rsvp_counts(p_room_id uuid)
RETURNS TABLE (event_id uuid, going integer, maybe integer, declined integer, my_response text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT public.room_has_capability(p_room_id, v_uid, 'chat') THEN
    RAISE EXCEPTION 'Not authorized to view these events.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT e.id,
         (SELECT count(*)::integer FROM public.room_event_rsvps r WHERE r.event_id = e.id AND r.response = 'going'),
         (SELECT count(*)::integer FROM public.room_event_rsvps r WHERE r.event_id = e.id AND r.response = 'maybe'),
         (SELECT count(*)::integer FROM public.room_event_rsvps r WHERE r.event_id = e.id AND r.response = 'declined'),
         (SELECT r.response FROM public.room_event_rsvps r WHERE r.event_id = e.id AND r.user_id = v_uid)
  FROM public.room_events e
  WHERE e.room_id = p_room_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 9. Cross-room personal dashboard + smart organization input
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_my_room_overview()
RETURNS TABLE (
  room_id uuid, name text, role text, expiration_type text, expires_at timestamptz,
  is_group boolean, member_count integer, unread_count integer,
  last_activity_at timestamptz, next_event_at timestamptz, open_tasks integer, bookmarked boolean
)
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
    RAISE EXCEPTION 'Sign in to see your rooms.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT r.id, r.name, rm.role, r.expiration_type, r.expires_at, r.is_group,
         (SELECT count(*)::integer FROM public.room_members x
          WHERE x.room_id = r.id AND x.join_status = 'approved' AND NOT x.is_ghost_mode
            AND (x.guest_expires_at IS NULL OR x.guest_expires_at > now())),
         CASE WHEN public.room_has_capability(r.id, v_uid, 'chat') THEN
           (SELECT count(*)::integer FROM (
              SELECT 1 FROM public.messages m
              WHERE m.room_id = r.id AND m.created_at > COALESCE(rs.last_read_at, rm.joined_at)
                AND m.sender_id <> v_uid AND NOT COALESCE(m.is_deleted, false)
              LIMIT 100) capped)
         ELSE 0 END,
         (SELECT max(a.created_at) FROM public.room_activity a WHERE a.room_id = r.id),
         CASE WHEN public.room_has_capability(r.id, v_uid, 'chat') THEN
           (SELECT min(e.starts_at) FROM public.room_events e
            WHERE e.room_id = r.id AND e.cancelled_at IS NULL AND COALESCE(e.ends_at, e.starts_at + interval '1 hour') > now())
         END,
         CASE WHEN public.room_has_capability(r.id, v_uid, 'study') THEN
           (SELECT count(*)::integer FROM public.room_tasks t
            WHERE t.room_id = r.id AND t.assignee_id = v_uid AND t.status = 'open')
         ELSE 0 END,
         EXISTS (SELECT 1 FROM public.room_bookmarks b WHERE b.user_id = v_uid AND b.kind = 'room' AND b.entity_id = r.id)
  FROM public.room_members rm
  JOIN public.rooms r ON r.id = rm.room_id
  LEFT JOIN public.room_read_states rs ON rs.room_id = r.id AND rs.user_id = v_uid
  WHERE rm.user_id = v_uid AND rm.join_status = 'approved'
    AND public.room_has_active_access(r.id)
    AND public.room_user_role(r.id, v_uid) IS NOT NULL
  ORDER BY r.created_at DESC
  LIMIT 200;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_my_upcoming_events(p_limit integer DEFAULT 10)
RETURNS TABLE (
  event_id uuid, room_id uuid, room_name text, title text,
  starts_at timestamptz, my_response text
)
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
    RAISE EXCEPTION 'Sign in to see your events.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT e.id, e.room_id, r.name, e.title, e.starts_at,
         (SELECT s.response FROM public.room_event_rsvps s WHERE s.event_id = e.id AND s.user_id = v_uid)
  FROM public.room_events e
  JOIN public.rooms r ON r.id = e.room_id
  WHERE e.cancelled_at IS NULL
    AND COALESCE(e.ends_at, e.starts_at + interval '1 hour') > now()
    AND e.starts_at < now() + interval '30 days'
    AND public.room_has_capability(e.room_id, v_uid, 'chat')
  ORDER BY e.starts_at
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
END;
$$;

CREATE OR REPLACE FUNCTION public.list_my_open_tasks(p_limit integer DEFAULT 10)
RETURNS TABLE (
  task_id uuid, room_id uuid, room_name text, title text, due_at timestamptz
)
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
    RAISE EXCEPTION 'Sign in to see your tasks.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT t.id, t.room_id, r.name, t.title, t.due_at
  FROM public.room_tasks t
  JOIN public.rooms r ON r.id = t.room_id
  WHERE t.assignee_id = v_uid AND t.status = 'open'
    AND public.room_has_capability(t.room_id, v_uid, 'study')
  ORDER BY t.due_at NULLS LAST, t.created_at
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants: signed-in only, except discovery which Explore also serves signed
-- out (it returns only what anon can already read).
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  public.list_room_activity(uuid, integer, timestamptz),
  public.get_room_pulse(uuid),
  public.discover_rooms(text, text, integer, text, text, text, integer, integer),
  public.set_room_bookmark(uuid, text, uuid, boolean, text),
  public.list_my_bookmarks(integer),
  public.save_room_template(uuid, text, text),
  public.delete_room_template(uuid),
  public.apply_room_template(uuid, uuid),
  public.get_room_trust_levels(uuid),
  public.export_room_snapshot(uuid),
  public.record_room_export_digest(uuid, text),
  public.set_event_rsvp(uuid, text),
  public.list_event_rsvp_counts(uuid),
  public.list_my_room_overview(),
  public.list_my_upcoming_events(integer),
  public.list_my_open_tasks(integer)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.list_room_activity(uuid, integer, timestamptz),
  public.get_room_pulse(uuid),
  public.discover_rooms(text, text, integer, text, text, text, integer, integer),
  public.set_room_bookmark(uuid, text, uuid, boolean, text),
  public.list_my_bookmarks(integer),
  public.save_room_template(uuid, text, text),
  public.delete_room_template(uuid),
  public.apply_room_template(uuid, uuid),
  public.get_room_trust_levels(uuid),
  public.export_room_snapshot(uuid),
  public.record_room_export_digest(uuid, text),
  public.set_event_rsvp(uuid, text),
  public.list_event_rsvp_counts(uuid),
  public.list_my_room_overview(),
  public.list_my_upcoming_events(integer),
  public.list_my_open_tasks(integer)
TO authenticated;

GRANT EXECUTE ON FUNCTION public.discover_rooms(text, text, integer, text, text, text, integer, integer) TO anon;
