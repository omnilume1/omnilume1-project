-- Action 16 Stage 2: personal music uploads kept 7 days, opt-in sharing to
-- rooms/groups, playlists and listening history. Additive only.
--
-- Expiry never depends on the cron: playback RPCs, the storage SELECT policy
-- and signed-URL lifetimes all stop at expires_at; the daily cleanup only
-- reclaims space. Objects live flat at <owner_id>/<upload_id>.<ext> (+
-- <owner_id>/<upload_id>.cover.jpg) so account deletion's per-user prefix
-- sweep removes them before the auth-user cascade removes the rows.

-- ---------------------------------------------------------------------------
-- 1. Bucket and the single retention constant
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'music_uploads', 'music_uploads', false, 52428800,
  ARRAY['audio/mpeg', 'audio/flac', 'audio/ogg', 'audio/wav', 'audio/mp4', 'audio/aac', 'audio/webm', 'image/jpeg']
)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.music_upload_ttl()
RETURNS interval
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$ SELECT interval '7 days' $$;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.music_uploads (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  object_path text NOT NULL UNIQUE,
  cover_path text UNIQUE,
  mime_type text NOT NULL CHECK (mime_type IN ('audio/mpeg', 'audio/flac', 'audio/ogg', 'audio/wav', 'audio/mp4', 'audio/aac', 'audio/webm')),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 52428800),
  original_name text NOT NULL CHECK (char_length(original_name) BETWEEN 1 AND 180),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  artist text NOT NULL DEFAULT '' CHECK (char_length(artist) <= 200),
  album text NOT NULL DEFAULT '' CHECK (char_length(album) <= 200),
  album_artist text NOT NULL DEFAULT '' CHECK (char_length(album_artist) <= 200),
  track_no integer CHECK (track_no BETWEEN 1 AND 999),
  year integer CHECK (year BETWEEN 1000 AND 9999),
  genre text NOT NULL DEFAULT '' CHECK (char_length(genre) <= 80),
  duration_ms integer CHECK (duration_ms BETWEEN 0 AND 86400000),
  hue smallint NOT NULL DEFAULT 260 CHECK (hue BETWEEN 0 AND 359),
  lyrics text CHECK (char_length(lyrics) <= 20000),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'delete_pending', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  delete_requested_at timestamptz,
  deleted_at timestamptz,
  cleanup_attempts integer NOT NULL DEFAULT 0,
  last_cleanup_error text CHECK (char_length(last_cleanup_error) <= 1000),
  CONSTRAINT music_uploads_ttl CHECK (expires_at = created_at + public.music_upload_ttl()),
  CONSTRAINT music_uploads_object_path CHECK (object_path ~ ('^' || owner_id::text || '/' || id::text || '\.(mp3|flac|ogg|oga|opus|wav|m4a|aac|webm)$')),
  CONSTRAINT music_uploads_cover_path CHECK (cover_path IS NULL OR cover_path = owner_id::text || '/' || id::text || '.cover.jpg')
);
CREATE INDEX IF NOT EXISTS music_uploads_owner_idx ON public.music_uploads (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS music_uploads_due_idx ON public.music_uploads (expires_at) WHERE state <> 'deleted';

CREATE TABLE IF NOT EXISTS public.music_upload_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id uuid NOT NULL REFERENCES public.music_uploads(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target_kind text NOT NULL CHECK (target_kind IN ('room', 'group')),
  target_id uuid NOT NULL,
  attested_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (upload_id, target_kind, target_id)
);
CREATE INDEX IF NOT EXISTS music_upload_shares_target_idx ON public.music_upload_shares (target_kind, target_id);

CREATE TABLE IF NOT EXISTS public.music_playlists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS music_playlists_owner_idx ON public.music_playlists (owner_id, created_at);

CREATE TABLE IF NOT EXISTS public.music_playlist_items (
  playlist_id uuid NOT NULL REFERENCES public.music_playlists(id) ON DELETE CASCADE,
  upload_id uuid NOT NULL REFERENCES public.music_uploads(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (playlist_id, upload_id)
);

CREATE TABLE IF NOT EXISTS public.music_listening_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  upload_id uuid NOT NULL REFERENCES public.music_uploads(id) ON DELETE CASCADE,
  played_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS music_listening_history_user_idx ON public.music_listening_history (user_id, played_at DESC);

ALTER TABLE public.music_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.music_upload_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.music_playlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.music_playlist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.music_listening_history ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.music_uploads, public.music_upload_shares, public.music_playlists,
  public.music_playlist_items, public.music_listening_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.music_uploads, public.music_upload_shares TO authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.music_playlists, public.music_playlist_items TO authenticated;
GRANT UPDATE (name, updated_at) ON TABLE public.music_playlists TO authenticated;
GRANT SELECT, DELETE ON TABLE public.music_listening_history TO authenticated;

-- Owner-only reads; every write to uploads/shares/history goes through the RPCs below.
DROP POLICY IF EXISTS "Owners read their music uploads" ON public.music_uploads;
CREATE POLICY "Owners read their music uploads" ON public.music_uploads FOR SELECT TO authenticated
USING (owner_id = auth.uid());

DROP POLICY IF EXISTS "Owners read their music shares" ON public.music_upload_shares;
CREATE POLICY "Owners read their music shares" ON public.music_upload_shares FOR SELECT TO authenticated
USING (owner_id = auth.uid());

DROP POLICY IF EXISTS "Owners manage their playlists" ON public.music_playlists;
CREATE POLICY "Owners manage their playlists" ON public.music_playlists FOR ALL TO authenticated
USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS "Owners manage their playlist items" ON public.music_playlist_items;
CREATE POLICY "Owners manage their playlist items" ON public.music_playlist_items FOR ALL TO authenticated
USING (owner_id = auth.uid())
WITH CHECK (
  owner_id = auth.uid()
  AND EXISTS (SELECT 1 FROM public.music_playlists p WHERE p.id = playlist_id AND p.owner_id = auth.uid())
  AND EXISTS (SELECT 1 FROM public.music_uploads u WHERE u.id = upload_id AND u.owner_id = auth.uid())
);

DROP POLICY IF EXISTS "Listeners read their history" ON public.music_listening_history;
CREATE POLICY "Listeners read their history" ON public.music_listening_history FOR SELECT TO authenticated
USING (user_id = auth.uid());
DROP POLICY IF EXISTS "Listeners clear their history" ON public.music_listening_history;
CREATE POLICY "Listeners clear their history" ON public.music_listening_history FOR DELETE TO authenticated
USING (user_id = auth.uid());

-- At most 100 playlists per account.
CREATE OR REPLACE FUNCTION public.music_playlists_limit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF (SELECT count(*) FROM public.music_playlists p WHERE p.owner_id = NEW.owner_id) >= 100 THEN
    RAISE EXCEPTION 'You can have up to 100 playlists.' USING ERRCODE = '54000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS music_playlists_limit ON public.music_playlists;
CREATE TRIGGER music_playlists_limit BEFORE INSERT ON public.music_playlists
FOR EACH ROW EXECUTE FUNCTION public.music_playlists_limit();

-- ---------------------------------------------------------------------------
-- 3. Helpers (policy helpers run as the caller → EXECUTE to authenticated)
-- ---------------------------------------------------------------------------
-- Owner, or a member of a room/group the upload is shared to; active and unexpired only.
CREATE OR REPLACE FUNCTION public.music_can_play(p_upload_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_user_id IS NOT NULL AND p_user_id = auth.uid() AND EXISTS (
    SELECT 1 FROM public.music_uploads u
    WHERE u.id = p_upload_id AND u.state = 'active' AND u.expires_at > now()
      AND (
        u.owner_id = p_user_id
        OR EXISTS (
          SELECT 1 FROM public.music_upload_shares s
          WHERE s.upload_id = u.id
            AND (
              (s.target_kind = 'room' AND public.room_has_capability(s.target_id, p_user_id, 'watch'))
              OR (s.target_kind = 'group' AND public.is_group_member(s.target_id, p_user_id))
            )
        )
      )
  );
$$;

-- Storage INSERT: own flat prefix, known extension, at most 100 objects held.
CREATE OR REPLACE FUNCTION public.music_object_insert_ok(p_name text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL OR p_name IS NULL
     OR p_name !~ ('^' || uid::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(mp3|flac|ogg|oga|opus|wav|m4a|aac|webm|cover\.jpg)$') THEN
    RETURN false;
  END IF;
  RETURN (
    SELECT count(*) FROM storage.objects o
    WHERE o.bucket_id = 'music_uploads' AND o.name LIKE uid::text || '/%'
  ) < 100;
END;
$$;

-- Storage SELECT: the owner, while the registered upload is active and unexpired.
-- A not-yet-registered object in the owner's own prefix is readable too, so the
-- upload's INSERT … RETURNING succeeds; once registered, the row decides (an
-- expired row keeps the object unreadable until the cleanup removes it).
CREATE OR REPLACE FUNCTION public.music_object_readable(p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT auth.uid() IS NOT NULL AND (
    EXISTS (
      SELECT 1 FROM public.music_uploads u
      WHERE u.owner_id = auth.uid() AND u.state = 'active' AND u.expires_at > now()
        AND (u.object_path = p_name OR u.cover_path = p_name)
    )
    OR (
      split_part(p_name, '/', 1) = auth.uid()::text
      AND NOT EXISTS (SELECT 1 FROM public.music_uploads u WHERE u.object_path = p_name OR u.cover_path = p_name)
    )
  );
$$;

DROP POLICY IF EXISTS "Owners upload music into their prefix" ON storage.objects;
CREATE POLICY "Owners upload music into their prefix" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'music_uploads' AND public.music_object_insert_ok(name));
DROP POLICY IF EXISTS "Owners read unexpired music" ON storage.objects;
CREATE POLICY "Owners read unexpired music" ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'music_uploads' AND public.music_object_readable(name));
-- No UPDATE/DELETE policy: removal runs server-side with the service role.

-- ---------------------------------------------------------------------------
-- 4. Service-role RPCs (route handlers and the daily cleanup)
-- ---------------------------------------------------------------------------
-- Called by POST /api/music/uploads after it has sniffed the file's first bytes.
CREATE OR REPLACE FUNCTION public.register_music_upload(
  p_owner_id uuid,
  p_upload_id uuid,
  p_ext text,
  p_mime_type text,
  p_original_name text,
  p_title text,
  p_artist text,
  p_album text,
  p_album_artist text,
  p_track_no integer,
  p_year integer,
  p_genre text,
  p_duration_ms integer,
  p_hue integer,
  p_lyrics text,
  p_has_cover boolean
)
RETURNS public.music_uploads
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  object_path text;
  cover_path text;
  audio_meta jsonb;
  cover_meta jsonb;
  audio_size bigint;
  active_count integer;
  active_bytes bigint;
  row_out public.music_uploads%ROWTYPE;
BEGIN
  IF p_owner_id IS NULL OR p_upload_id IS NULL THEN
    RAISE EXCEPTION 'Invalid music upload.' USING ERRCODE = '22023';
  END IF;
  IF p_mime_type IS DISTINCT FROM (CASE p_ext
       WHEN 'mp3' THEN 'audio/mpeg' WHEN 'flac' THEN 'audio/flac'
       WHEN 'ogg' THEN 'audio/ogg' WHEN 'oga' THEN 'audio/ogg' WHEN 'opus' THEN 'audio/ogg'
       WHEN 'wav' THEN 'audio/wav' WHEN 'm4a' THEN 'audio/mp4' WHEN 'aac' THEN 'audio/aac'
       WHEN 'webm' THEN 'audio/webm' END)
     OR char_length(COALESCE(btrim(p_title), '')) NOT BETWEEN 1 AND 200
     OR char_length(COALESCE(p_original_name, '')) NOT BETWEEN 1 AND 180
     OR char_length(COALESCE(p_artist, '')) > 200 OR char_length(COALESCE(p_album, '')) > 200
     OR char_length(COALESCE(p_album_artist, '')) > 200 OR char_length(COALESCE(p_genre, '')) > 80
     OR char_length(COALESCE(p_lyrics, '')) > 20000
     OR (p_track_no IS NOT NULL AND p_track_no NOT BETWEEN 1 AND 999)
     OR (p_year IS NOT NULL AND p_year NOT BETWEEN 1000 AND 9999)
     OR (p_duration_ms IS NOT NULL AND p_duration_ms NOT BETWEEN 0 AND 86400000)
     OR p_hue IS NULL OR p_hue NOT BETWEEN 0 AND 359 THEN
    RAISE EXCEPTION 'Invalid music upload.' USING ERRCODE = '22023';
  END IF;

  object_path := p_owner_id::text || '/' || p_upload_id::text || '.' || p_ext;
  cover_path := CASE WHEN p_has_cover THEN p_owner_id::text || '/' || p_upload_id::text || '.cover.jpg' END;

  SELECT o.metadata INTO audio_meta FROM storage.objects o
  WHERE o.bucket_id = 'music_uploads' AND o.name = object_path AND o.owner_id = p_owner_id::text;
  audio_size := (audio_meta ->> 'size')::bigint;
  IF audio_meta IS NULL OR audio_meta ->> 'mimetype' IS DISTINCT FROM p_mime_type
     OR audio_size IS NULL OR audio_size NOT BETWEEN 1 AND 52428800 THEN
    RAISE EXCEPTION 'The uploaded file was not found or does not match.' USING ERRCODE = '22023';
  END IF;
  IF cover_path IS NOT NULL THEN
    SELECT o.metadata INTO cover_meta FROM storage.objects o
    WHERE o.bucket_id = 'music_uploads' AND o.name = cover_path AND o.owner_id = p_owner_id::text;
    IF cover_meta IS NULL OR cover_meta ->> 'mimetype' IS DISTINCT FROM 'image/jpeg'
       OR COALESCE((cover_meta ->> 'size')::bigint, 0) NOT BETWEEN 1 AND 2097152 THEN
      RAISE EXCEPTION 'The uploaded artwork was not found or does not match.' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Serialise one owner's registrations so the caps cannot be raced.
  PERFORM pg_advisory_xact_lock(hashtextextended('music_uploads:' || p_owner_id::text, 0));
  SELECT count(*), COALESCE(sum(u.size_bytes), 0) INTO active_count, active_bytes
  FROM public.music_uploads u
  WHERE u.owner_id = p_owner_id AND u.state = 'active' AND u.expires_at > now();
  IF active_count >= 40 THEN
    RAISE EXCEPTION 'You can keep up to 40 uploads at a time.' USING ERRCODE = '54000';
  END IF;
  IF active_bytes + audio_size > 314572800 THEN
    RAISE EXCEPTION 'Uploads are limited to 300 MB in total.' USING ERRCODE = '54000';
  END IF;

  INSERT INTO public.music_uploads (
    id, owner_id, object_path, cover_path, mime_type, size_bytes, original_name, title, artist, album,
    album_artist, track_no, year, genre, duration_ms, hue, lyrics, created_at, expires_at
  ) VALUES (
    p_upload_id, p_owner_id, object_path, cover_path, p_mime_type, audio_size, p_original_name, btrim(p_title),
    COALESCE(p_artist, ''), COALESCE(p_album, ''), COALESCE(p_album_artist, ''), p_track_no, p_year,
    COALESCE(p_genre, ''), p_duration_ms, p_hue, NULLIF(p_lyrics, ''), now(), now() + public.music_upload_ttl()
  )
  RETURNING * INTO row_out;
  RETURN row_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_music_uploads_due_for_cleanup(p_limit integer DEFAULT 200)
RETURNS TABLE (id uuid, object_path text, cover_path text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT u.id, u.object_path, u.cover_path
  FROM public.music_uploads u
  WHERE u.state = 'delete_pending' OR (u.state = 'active' AND u.expires_at <= now())
  ORDER BY u.expires_at
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
$$;

-- Objects with no upload row at all, older than an hour (abandoned or failed uploads).
CREATE OR REPLACE FUNCTION public.list_music_orphan_objects(p_limit integer DEFAULT 200)
RETURNS TABLE (name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT o.name
  FROM storage.objects o
  WHERE o.bucket_id = 'music_uploads'
    AND o.created_at < now() - interval '1 hour'
    AND NOT EXISTS (
      SELECT 1 FROM public.music_uploads u WHERE u.object_path = o.name OR u.cover_path = o.name
    )
  ORDER BY o.created_at
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
$$;

-- Runs after the storage objects were removed (success) or failed to be (p_error).
-- The row stays as a tombstone so playlists and history can show "expired".
CREATE OR REPLACE FUNCTION public.complete_music_upload_cleanup(p_upload_id uuid, p_error text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_error IS NULL THEN
    UPDATE public.music_uploads
    SET state = 'deleted', deleted_at = COALESCE(deleted_at, now()), last_cleanup_error = NULL
    WHERE id = p_upload_id;
    DELETE FROM public.music_upload_shares s WHERE s.upload_id = p_upload_id;
  ELSE
    UPDATE public.music_uploads
    SET cleanup_attempts = cleanup_attempts + 1, last_cleanup_error = left(p_error, 1000),
        state = CASE WHEN state = 'active' THEN 'delete_pending' ELSE state END,
        delete_requested_at = COALESCE(delete_requested_at, now())
    WHERE id = p_upload_id AND state <> 'deleted';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. User RPCs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.begin_music_upload_delete(p_upload_id uuid)
RETURNS text[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  row_in public.music_uploads%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO row_in FROM public.music_uploads u WHERE u.id = p_upload_id FOR UPDATE;
  IF NOT FOUND OR row_in.owner_id <> auth.uid() THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  IF row_in.state = 'deleted' THEN
    RETURN ARRAY[]::text[];
  END IF;
  UPDATE public.music_uploads
  SET state = 'delete_pending', delete_requested_at = COALESCE(delete_requested_at, now())
  WHERE id = p_upload_id;
  DELETE FROM public.music_upload_shares s WHERE s.upload_id = p_upload_id;
  RETURN array_remove(ARRAY[row_in.object_path, row_in.cover_path], NULL);
END;
$$;

-- Paths for the playback route; it signs them with TTL = min(1 h, remaining life).
CREATE OR REPLACE FUNCTION public.get_music_playback(p_upload_id uuid)
RETURNS TABLE (object_path text, cover_path text, expires_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.music_can_play(p_upload_id, auth.uid()) THEN
    RAISE EXCEPTION 'This song is not available.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT u.object_path, u.cover_path, u.expires_at FROM public.music_uploads u WHERE u.id = p_upload_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_music_share_targets()
RETURNS TABLE (target_kind text, target_id uuid, name text)
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
  SELECT 'room'::text, r.id, r.name
  FROM public.room_members rm
  JOIN public.rooms r ON r.id = rm.room_id
  WHERE rm.user_id = uid
    AND NOT EXISTS (SELECT 1 FROM public.groups g WHERE g.source_room_id = r.id)
    AND public.room_has_capability(r.id, uid, 'watch')
  UNION ALL
  SELECT 'group'::text, g.id, g.name
  FROM public.group_members gm
  JOIN public.groups g ON g.id = gm.group_id
  WHERE gm.user_id = uid
  ORDER BY 3
  LIMIT 200;
END;
$$;

CREATE OR REPLACE FUNCTION public.share_music_upload(p_upload_id uuid, p_target_kind text, p_target_id uuid, p_attest boolean)
RETURNS public.music_upload_shares
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := auth.uid();
  member_ok boolean;
  row_out public.music_upload_shares%ROWTYPE;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  IF p_attest IS NOT TRUE THEN
    RAISE EXCEPTION 'Confirm you have the right to share this file.' USING ERRCODE = '22023';
  END IF;
  IF p_target_kind IS NULL OR p_target_kind NOT IN ('room', 'group') OR p_target_id IS NULL THEN
    RAISE EXCEPTION 'Invalid share target.' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.music_uploads u
    WHERE u.id = p_upload_id AND u.owner_id = uid AND u.state = 'active' AND u.expires_at > now()
  ) THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  -- (An assignment, because plpgsql's IF … THEN parser stops at the CASE's first THEN.)
  member_ok := CASE p_target_kind
    WHEN 'room' THEN public.room_has_capability(p_target_id, uid, 'watch')
      AND NOT EXISTS (SELECT 1 FROM public.groups g WHERE g.source_room_id = p_target_id)
    ELSE public.is_group_member(p_target_id, uid) END;
  IF member_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  IF (SELECT count(*) FROM public.music_upload_shares s WHERE s.upload_id = p_upload_id) >= 20 THEN
    RAISE EXCEPTION 'An upload can be shared to at most 20 places.' USING ERRCODE = '54000';
  END IF;

  INSERT INTO public.music_upload_shares (upload_id, owner_id, target_kind, target_id)
  VALUES (p_upload_id, uid, p_target_kind, p_target_id)
  ON CONFLICT (upload_id, target_kind, target_id) DO UPDATE SET attested_at = now()
  RETURNING * INTO row_out;
  RETURN row_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.unshare_music_upload(p_share_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.music_upload_shares s WHERE s.id = p_share_id AND s.owner_id = auth.uid();
  RETURN FOUND;
END;
$$;

-- The owner's shares with readable target names.
CREATE OR REPLACE FUNCTION public.list_music_shares(p_upload_id uuid)
RETURNS TABLE (share_id uuid, target_kind text, target_id uuid, target_name text, created_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT s.id, s.target_kind, s.target_id,
    COALESCE(CASE s.target_kind
      WHEN 'room' THEN (SELECT r.name FROM public.rooms r WHERE r.id = s.target_id)
      ELSE (SELECT g.name FROM public.groups g WHERE g.id = s.target_id) END, 'Unavailable'),
    s.created_at
  FROM public.music_upload_shares s
  WHERE s.upload_id = p_upload_id AND s.owner_id = auth.uid()
  ORDER BY s.created_at;
END;
$$;

-- Uploads other people shared to rooms/groups the caller is in (active, unexpired).
CREATE OR REPLACE FUNCTION public.list_music_shared_with_me()
RETURNS TABLE (
  share_id uuid, upload_id uuid, target_kind text, target_id uuid, target_name text, owner_name text,
  title text, artist text, album text, duration_ms integer, hue smallint, has_cover boolean, lyrics text, expires_at timestamptz
)
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
  SELECT s.id, u.id, s.target_kind, s.target_id,
    CASE s.target_kind
      WHEN 'room' THEN (SELECT r.name FROM public.rooms r WHERE r.id = s.target_id)
      ELSE (SELECT g.name FROM public.groups g WHERE g.id = s.target_id) END,
    COALESCE((SELECT p.display_name FROM public.profiles p WHERE p.id = u.owner_id), 'A member'),
    u.title, u.artist, u.album, u.duration_ms, u.hue, u.cover_path IS NOT NULL, u.lyrics, u.expires_at
  FROM public.music_upload_shares s
  JOIN public.music_uploads u ON u.id = s.upload_id
  WHERE u.owner_id <> uid AND u.state = 'active' AND u.expires_at > now()
    AND (
      (s.target_kind = 'room' AND public.room_has_capability(s.target_id, uid, 'watch'))
      OR (s.target_kind = 'group' AND public.is_group_member(s.target_id, uid))
    )
  ORDER BY s.created_at DESC
  LIMIT 200;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_music_play(p_upload_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL OR NOT public.music_can_play(p_upload_id, uid) THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.music_listening_history h
    WHERE h.user_id = uid AND h.upload_id = p_upload_id AND h.played_at > now() - interval '30 seconds'
  ) THEN
    RETURN;
  END IF;
  INSERT INTO public.music_listening_history (user_id, upload_id) VALUES (uid, p_upload_id);
  -- Keep the newest 500 plays per listener.
  DELETE FROM public.music_listening_history h
  WHERE h.user_id = uid AND h.id < (
    SELECT min(k.id) FROM (
      SELECT x.id FROM public.music_listening_history x WHERE x.user_id = uid ORDER BY x.id DESC LIMIT 500
    ) k
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.list_my_music_history(p_limit integer DEFAULT 100)
RETURNS TABLE (
  id bigint, upload_id uuid, played_at timestamptz, title text, artist text, album text,
  duration_ms integer, hue smallint, has_cover boolean, owned boolean, playable boolean
)
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
  SELECT h.id, u.id, h.played_at, u.title, u.artist, u.album, u.duration_ms, u.hue,
    u.cover_path IS NOT NULL AND u.state = 'active', u.owner_id = uid, public.music_can_play(u.id, uid)
  FROM public.music_listening_history h
  JOIN public.music_uploads u ON u.id = h.upload_id
  WHERE h.user_id = uid
  ORDER BY h.played_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Function privileges
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  public.music_upload_ttl(),
  public.music_playlists_limit(),
  public.music_can_play(uuid, uuid),
  public.music_object_insert_ok(text),
  public.music_object_readable(text),
  public.register_music_upload(uuid, uuid, text, text, text, text, text, text, text, integer, integer, text, integer, integer, text, boolean),
  public.list_music_uploads_due_for_cleanup(integer),
  public.list_music_orphan_objects(integer),
  public.complete_music_upload_cleanup(uuid, text),
  public.begin_music_upload_delete(uuid),
  public.get_music_playback(uuid),
  public.list_music_share_targets(),
  public.share_music_upload(uuid, text, uuid, boolean),
  public.unshare_music_upload(uuid),
  public.list_music_shares(uuid),
  public.list_music_shared_with_me(),
  public.record_music_play(uuid),
  public.list_my_music_history(integer)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.music_upload_ttl(),
  public.music_playlists_limit(),
  public.music_can_play(uuid, uuid),
  public.music_object_insert_ok(text),
  public.music_object_readable(text),
  public.begin_music_upload_delete(uuid),
  public.get_music_playback(uuid),
  public.list_music_share_targets(),
  public.share_music_upload(uuid, text, uuid, boolean),
  public.unshare_music_upload(uuid),
  public.list_music_shares(uuid),
  public.list_music_shared_with_me(),
  public.record_music_play(uuid),
  public.list_my_music_history(integer)
TO authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.register_music_upload(uuid, uuid, text, text, text, text, text, text, text, integer, integer, text, integer, integer, text, boolean),
  public.list_music_uploads_due_for_cleanup(integer),
  public.list_music_orphan_objects(integer),
  public.complete_music_upload_cleanup(uuid, text)
TO service_role;
