-- Action 16 Stage 3: "Listening to …" for friends, and Listen Together in a
-- room or group. Additive only.
--
-- Presence: one now-playing row per listener, written only by an RPC that
-- copies title/artist from an upload the caller may play. Friends read it
-- through a definer RPC (not blocked, privacy 'friends', fresh < 5 min).
--
-- Listen Together: one session row per room/group, written only by
-- music_listen_control (membership, host-only, track shared to that exact
-- room/group). Every change is pushed with realtime.send to the private topic
-- music_listen_<room|group>_<uuid>. Clients get a SELECT policy on that topic
-- and no INSERT policy, so nobody can publish or spoof state on it.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.music_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  presence text NOT NULL DEFAULT 'friends' CONSTRAINT music_settings_presence CHECK (presence IN ('friends', 'nobody')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.music_now_playing (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL,
  artist text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.music_listen_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_kind text NOT NULL CONSTRAINT music_listen_target_kind CHECK (target_kind IN ('room', 'group')),
  target_id uuid NOT NULL,
  host_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  host_only boolean NOT NULL DEFAULT false,
  upload_id uuid REFERENCES public.music_uploads(id) ON DELETE SET NULL,
  position_ms integer NOT NULL DEFAULT 0 CONSTRAINT music_listen_position CHECK (position_ms BETWEEN 0 AND 86400000),
  is_playing boolean NOT NULL DEFAULT false,
  anchor_at timestamptz NOT NULL DEFAULT now(),
  queue uuid[] NOT NULL DEFAULT '{}' CONSTRAINT music_listen_queue_size CHECK (cardinality(queue) <= 100),
  seq bigint NOT NULL DEFAULT 0,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT music_listen_one_per_target UNIQUE (target_kind, target_id)
);

ALTER TABLE public.music_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.music_now_playing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.music_listen_sessions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.music_settings, public.music_now_playing, public.music_listen_sessions
  FROM PUBLIC, anon, authenticated;
-- Own setting is readable; every write and every other read goes through the RPCs below.
GRANT SELECT ON TABLE public.music_settings TO authenticated;
DROP POLICY IF EXISTS "Listeners read their music settings" ON public.music_settings;
CREATE POLICY "Listeners read their music settings" ON public.music_settings FOR SELECT TO authenticated
USING (user_id = auth.uid());
-- music_now_playing and music_listen_sessions: RLS on, no grants, no policies.

-- ---------------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------------
-- Caller may take part in Listen Together for this room/group (same audience
-- as sharing: room 'watch' capability unless converted, or group membership).
CREATE OR REPLACE FUNCTION public.music_listen_can_join(p_kind text, p_target uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(auth.uid() IS NOT NULL AND p_target IS NOT NULL AND CASE p_kind
    WHEN 'room' THEN public.room_has_capability(p_target, auth.uid(), 'watch')
      AND NOT EXISTS (SELECT 1 FROM public.groups g WHERE g.source_room_id = p_target)
    WHEN 'group' THEN public.is_group_member(p_target, auth.uid())
    ELSE false END, false);
$$;

-- Realtime topic policy helper: validates the text before any uuid cast.
CREATE OR REPLACE FUNCTION public.can_receive_music_listen_topic(p_topic text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL OR p_topic IS NULL
     OR p_topic !~ '^music_listen_(room|group)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  RETURN public.music_listen_can_join(split_part(p_topic, '_', 3), split_part(p_topic, '_', 4)::uuid);
END;
$$;

-- Session state as sent to clients (also pushed over realtime).
CREATE OR REPLACE FUNCTION public.music_listen_json(s public.music_listen_sessions)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'target_kind', s.target_kind, 'target_id', s.target_id,
    'host_id', s.host_id,
    'host_name', COALESCE((SELECT p.display_name FROM public.profiles p WHERE p.id = s.host_id), 'A member'),
    'host_only', s.host_only, 'upload_id', s.upload_id, 'position_ms', s.position_ms,
    'is_playing', s.is_playing, 'anchor_at', s.anchor_at, 'queue', to_jsonb(s.queue), 'seq', s.seq,
    'ended', s.ended_at IS NOT NULL, 'server_now', now()
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. Presence RPCs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_music_presence(p_presence text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  IF p_presence IS NULL OR p_presence NOT IN ('friends', 'nobody') THEN
    RAISE EXCEPTION 'Invalid setting.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.music_settings (user_id, presence) VALUES (uid, p_presence)
  ON CONFLICT (user_id) DO UPDATE SET presence = EXCLUDED.presence, updated_at = now();
  IF p_presence = 'nobody' THEN
    DELETE FROM public.music_now_playing np WHERE np.user_id = uid;
  END IF;
  RETURN p_presence;
END;
$$;

-- NULL clears. Title/artist are copied from the upload, never taken from the client.
CREATE OR REPLACE FUNCTION public.set_music_now_playing(p_upload_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  IF p_upload_id IS NULL
     OR EXISTS (SELECT 1 FROM public.music_settings s WHERE s.user_id = uid AND s.presence = 'nobody') THEN
    DELETE FROM public.music_now_playing np WHERE np.user_id = uid;
    RETURN;
  END IF;
  IF NOT public.music_can_play(p_upload_id, uid) THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.music_now_playing (user_id, title, artist)
  SELECT uid, u.title, u.artist FROM public.music_uploads u WHERE u.id = p_upload_id
  ON CONFLICT (user_id) DO UPDATE SET title = EXCLUDED.title, artist = EXCLUDED.artist, updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.list_friends_listening()
RETURNS TABLE (user_id uuid, display_name text, username text, avatar_url text, title text, artist text, updated_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT np.user_id, p.display_name, p.username, p.avatar_url, np.title, np.artist, np.updated_at
  FROM public.music_now_playing np
  JOIN public.friendships f ON f.user_one = LEAST(uid, np.user_id) AND f.user_two = GREATEST(uid, np.user_id)
  LEFT JOIN public.profiles p ON p.id = np.user_id
  WHERE np.user_id <> uid
    AND np.updated_at > now() - interval '5 minutes'
    AND NOT EXISTS (SELECT 1 FROM public.music_settings s WHERE s.user_id = np.user_id AND s.presence = 'nobody')
    AND NOT EXISTS (
      SELECT 1 FROM public.user_blocks b
      WHERE (b.blocker_id = uid AND b.blocked_id = np.user_id) OR (b.blocker_id = np.user_id AND b.blocked_id = uid)
    )
  ORDER BY np.updated_at DESC
  LIMIT 200;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Listen Together RPCs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_music_listen_session(p_kind text, p_target uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  s public.music_listen_sessions%ROWTYPE;
BEGIN
  IF NOT public.music_listen_can_join(p_kind, p_target) THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO s FROM public.music_listen_sessions x WHERE x.target_kind = p_kind AND x.target_id = p_target;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN public.music_listen_json(s);
END;
$$;

-- Songs that can be played together here: active, unexpired, shared to this room/group.
CREATE OR REPLACE FUNCTION public.list_music_listen_tracks(p_kind text, p_target uuid)
RETURNS TABLE (
  upload_id uuid, owner_name text, title text, artist text, album text, duration_ms integer, hue smallint,
  has_cover boolean, lyrics text, expires_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.music_listen_can_join(p_kind, p_target) THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT u.id, COALESCE((SELECT p.display_name FROM public.profiles p WHERE p.id = u.owner_id), 'A member'),
    u.title, u.artist, u.album, u.duration_ms, u.hue, u.cover_path IS NOT NULL, u.lyrics, u.expires_at
  FROM public.music_upload_shares s
  JOIN public.music_uploads u ON u.id = s.upload_id
  WHERE s.target_kind = p_kind AND s.target_id = p_target AND u.state = 'active' AND u.expires_at > now()
  ORDER BY s.created_at DESC
  LIMIT 200;
END;
$$;

-- One entry point for every change; server-side seq, anchor and queue deltas.
-- Actions: start, play, pause, seek, load, enqueue, remove, next, host_only, end.
CREATE OR REPLACE FUNCTION public.music_listen_control(
  p_kind text, p_target uuid, p_action text,
  p_upload_id uuid DEFAULT NULL, p_position_ms integer DEFAULT NULL, p_index integer DEFAULT NULL, p_flag boolean DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := auth.uid();
  s public.music_listen_sessions%ROWTYPE;
  host_gone boolean;
  pos integer;
  shared_ok boolean;
  out_json jsonb;
BEGIN
  IF uid IS NULL OR NOT public.music_listen_can_join(p_kind, p_target) THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('start', 'play', 'pause', 'seek', 'load', 'enqueue', 'remove', 'next', 'host_only', 'end') THEN
    RAISE EXCEPTION 'Invalid action.' USING ERRCODE = '22023';
  END IF;
  IF p_position_ms IS NOT NULL AND (p_position_ms < 0 OR p_position_ms > 86400000) THEN
    RAISE EXCEPTION 'Invalid position.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.music_listen_sessions (target_kind, target_id, host_id, ended_at)
  VALUES (p_kind, p_target, uid, now())
  ON CONFLICT (target_kind, target_id) DO NOTHING;
  SELECT * INTO s FROM public.music_listen_sessions x WHERE x.target_kind = p_kind AND x.target_id = p_target FOR UPDATE;

  host_gone := s.host_id IS NULL OR NOT CASE s.target_kind
    WHEN 'room' THEN EXISTS (
      SELECT 1 FROM public.room_members rm
      WHERE rm.room_id = s.target_id AND rm.user_id = s.host_id AND rm.join_status = 'approved')
    ELSE EXISTS (SELECT 1 FROM public.group_members gm WHERE gm.group_id = s.target_id AND gm.user_id = s.host_id) END;

  IF p_action = 'start' THEN
    -- Join a live session; take over an ended, abandoned (host left) or idle (> 6 h) one.
    IF s.ended_at IS NULL AND NOT host_gone AND s.updated_at > now() - interval '6 hours' THEN
      RETURN public.music_listen_json(s);
    END IF;
    UPDATE public.music_listen_sessions x
    SET host_id = uid, host_only = COALESCE(p_flag, false), upload_id = NULL, position_ms = 0, is_playing = false,
        anchor_at = now(), queue = '{}', seq = x.seq + 1, ended_at = NULL, updated_at = now()
    WHERE x.id = s.id RETURNING * INTO s;
  ELSE
    IF s.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'No one is listening here right now.' USING ERRCODE = 'P0002';
    END IF;
    IF p_action IN ('host_only', 'end') AND s.host_id IS DISTINCT FROM uid AND NOT (p_action = 'end' AND host_gone) THEN
      RAISE EXCEPTION 'Only the host can do that.' USING ERRCODE = '42501';
    END IF;
    IF s.host_only AND s.host_id IS DISTINCT FROM uid AND NOT (p_action = 'end' AND host_gone) THEN
      RAISE EXCEPTION 'Only the host can control playback.' USING ERRCODE = '42501';
    END IF;
    IF p_action IN ('load', 'enqueue') THEN
      SELECT EXISTS (
        SELECT 1 FROM public.music_upload_shares sh JOIN public.music_uploads u ON u.id = sh.upload_id
        WHERE sh.upload_id = p_upload_id AND sh.target_kind = p_kind AND sh.target_id = p_target
          AND u.state = 'active' AND u.expires_at > now()
      ) INTO shared_ok;
      IF shared_ok IS NOT TRUE THEN
        RAISE EXCEPTION 'Share this song to the room or group first.' USING ERRCODE = '22023';
      END IF;
    END IF;

    -- Where the shared playhead is right now (anchor maths), then apply the change.
    pos := LEAST(86400000, s.position_ms + CASE WHEN s.is_playing
      THEN GREATEST(0, (extract(epoch FROM now() - s.anchor_at) * 1000)::integer) ELSE 0 END);
    IF p_action = 'next' AND s.upload_id IS DISTINCT FROM p_upload_id THEN
      -- Several listeners finish the same song at once: only the first advance applies.
      RETURN public.music_listen_json(s);
    END IF;
    IF p_action IN ('play', 'pause', 'seek') AND s.upload_id IS NULL THEN
      RAISE EXCEPTION 'Pick a song first.' USING ERRCODE = '22023';
    END IF;
    IF p_action = 'seek' AND p_position_ms IS NULL THEN
      RAISE EXCEPTION 'Invalid position.' USING ERRCODE = '22023';
    END IF;
    IF p_action = 'enqueue' AND cardinality(s.queue) >= 100 THEN
      RAISE EXCEPTION 'The queue holds up to 100 songs.' USING ERRCODE = '54000';
    END IF;
    IF p_action = 'remove' AND (p_index IS NULL OR p_index < 0 OR p_index >= cardinality(s.queue) OR s.queue[p_index + 1] IS DISTINCT FROM p_upload_id) THEN
      RAISE EXCEPTION 'The queue changed. Try again.' USING ERRCODE = '40001';
    END IF;

    UPDATE public.music_listen_sessions x SET
      upload_id = CASE p_action
        WHEN 'load' THEN p_upload_id
        WHEN 'next' THEN COALESCE(x.queue[1], x.upload_id)
        ELSE x.upload_id END,
      queue = CASE p_action
        WHEN 'enqueue' THEN x.queue || p_upload_id
        WHEN 'remove' THEN x.queue[1:p_index] || x.queue[p_index + 2:cardinality(x.queue)]
        WHEN 'next' THEN COALESCE(x.queue[2:cardinality(x.queue)], '{}')
        ELSE x.queue END,
      is_playing = CASE p_action
        WHEN 'play' THEN true WHEN 'load' THEN true WHEN 'pause' THEN false WHEN 'end' THEN false
        WHEN 'next' THEN cardinality(x.queue) > 0
        ELSE x.is_playing END,
      position_ms = CASE
        WHEN p_action IN ('load', 'next') THEN 0
        WHEN p_action IN ('play', 'pause', 'seek') THEN COALESCE(p_position_ms, pos)
        ELSE pos END,
      host_only = CASE WHEN p_action = 'host_only' THEN COALESCE(p_flag, false) ELSE x.host_only END,
      ended_at = CASE WHEN p_action = 'end' THEN now() ELSE NULL END,
      anchor_at = now(), seq = x.seq + 1, updated_at = now()
    WHERE x.id = s.id RETURNING * INTO s;
  END IF;

  out_json := public.music_listen_json(s);
  PERFORM realtime.send(out_json, 'state', 'music_listen_' || p_kind || '_' || p_target::text, true);
  RETURN out_json;
END;
$$;

-- Members receive the topic; there is deliberately no INSERT policy (server-only publishing).
DROP POLICY IF EXISTS "Members receive their Listen Together channel" ON realtime.messages;
CREATE POLICY "Members receive their Listen Together channel" ON realtime.messages
FOR SELECT TO authenticated
USING (
  realtime.messages.extension IN ('broadcast', 'presence')
  AND public.can_receive_music_listen_topic((SELECT realtime.topic()))
);

-- ---------------------------------------------------------------------------
-- 5. Function privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  public.music_listen_can_join(text, uuid),
  public.can_receive_music_listen_topic(text),
  public.music_listen_json(public.music_listen_sessions),
  public.set_music_presence(text),
  public.set_music_now_playing(uuid),
  public.list_friends_listening(),
  public.get_music_listen_session(text, uuid),
  public.list_music_listen_tracks(text, uuid),
  public.music_listen_control(text, uuid, text, uuid, integer, integer, boolean)
FROM PUBLIC, anon, authenticated;

-- Policy helpers run as the caller, so authenticated needs EXECUTE on them.
GRANT EXECUTE ON FUNCTION
  public.music_listen_can_join(text, uuid),
  public.can_receive_music_listen_topic(text),
  public.set_music_presence(text),
  public.set_music_now_playing(uuid),
  public.list_friends_listening(),
  public.get_music_listen_session(text, uuid),
  public.list_music_listen_tracks(text, uuid),
  public.music_listen_control(text, uuid, text, uuid, integer, integer, boolean)
TO authenticated, service_role;
