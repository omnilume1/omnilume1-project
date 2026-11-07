-- Raise active upload contracts to 500 MiB without rewriting applied history.
-- Hosted Supabase projects must also set their global file limit to at least
-- 500 MiB in Storage settings; bucket limits cannot exceed that project limit.

UPDATE storage.buckets
SET file_size_limit = 524288000
WHERE id IN ('room_attachments', 'music_uploads', 'room_recordings');

ALTER TABLE public.room_files
  DROP CONSTRAINT IF EXISTS room_files_size_bytes_check;
ALTER TABLE public.room_files
  ADD CONSTRAINT room_files_size_bytes_check
  CHECK (size_bytes > 0 AND size_bytes <= 524288000) NOT VALID;
ALTER TABLE public.room_files
  VALIDATE CONSTRAINT room_files_size_bytes_check;

ALTER TABLE public.music_uploads
  DROP CONSTRAINT IF EXISTS music_uploads_size_bytes_check;
ALTER TABLE public.music_uploads
  ADD CONSTRAINT music_uploads_size_bytes_check
  CHECK (size_bytes BETWEEN 1 AND 524288000) NOT VALID;
ALTER TABLE public.music_uploads
  VALIDATE CONSTRAINT music_uploads_size_bytes_check;

CREATE OR REPLACE FUNCTION public.register_room_file(
  p_room_id uuid,
  p_object_path text,
  p_original_name text,
  p_normalized_name text,
  p_mime_type text,
  p_size_bytes bigint,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS public.room_files
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  file_row public.room_files%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.room_has_capability(p_room_id, auth.uid(), 'files')
     OR p_object_path !~* ('^' || p_room_id::text || '/files/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]{1,16}$')
     OR char_length(COALESCE(p_original_name, '')) NOT BETWEEN 1 AND 180
     OR char_length(COALESCE(p_normalized_name, '')) NOT BETWEEN 1 AND 180
     OR p_mime_type NOT IN (
       'application/pdf', 'application/x-subrip', 'text/plain', 'text/markdown', 'text/vtt',
       'image/gif', 'image/jpeg', 'image/png', 'image/webp',
       'audio/mpeg', 'audio/flac', 'audio/ogg', 'audio/wav', 'audio/webm',
       'video/mp4', 'video/ogg', 'video/webm'
     )
     OR (
       p_mime_type = 'audio/flac'
       AND (
         p_original_name !~* '\.flac$'
         OR p_normalized_name !~* '\.flac$'
         OR p_object_path !~* '\.flac$'
       )
     )
     OR (
       p_mime_type <> 'audio/flac'
       AND (
         p_original_name ~* '\.flac$'
         OR p_normalized_name ~* '\.flac$'
         OR p_object_path ~* '\.flac$'
       )
     )
     OR p_size_bytes IS NULL OR p_size_bytes <= 0 OR p_size_bytes > 524288000
     OR p_metadata IS NULL OR jsonb_typeof(p_metadata) <> 'object' THEN
    RAISE EXCEPTION 'Invalid or unauthorized room file.';
  END IF;

  INSERT INTO public.room_files (
    room_id, owner_id, object_path, original_name, normalized_name, mime_type, size_bytes, metadata
  ) VALUES (
    p_room_id, auth.uid(), p_object_path, p_original_name, p_normalized_name, p_mime_type, p_size_bytes, p_metadata
  )
  RETURNING * INTO file_row;

  RETURN file_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.register_temporary_media(
  p_room_id uuid,
  p_file_name text,
  p_file_path text,
  p_media_type text,
  p_mime_type text DEFAULT NULL,
  p_file_size bigint DEFAULT NULL
)
RETURNS public.temporary_media
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  room_row public.rooms%ROWTYPE;
  media_row public.temporary_media%ROWTYPE;
  active_deadline timestamptz;
  media_expires_at timestamptz;
BEGIN
  IF auth.uid() IS NULL
     OR p_media_type NOT IN ('audio', 'video', 'url')
     OR char_length(COALESCE(p_file_name, '')) NOT BETWEEN 1 AND 512
     OR NOT public.room_has_capability(p_room_id, auth.uid(), 'watch_control') THEN
    RAISE EXCEPTION 'Invalid or unauthorized temporary media.';
  END IF;

  IF p_media_type = 'url' THEN
    IF p_file_path !~* '^https?://' OR p_mime_type IS NOT NULL OR p_file_size IS NOT NULL THEN
      RAISE EXCEPTION 'Invalid cast URL.';
    END IF;
  ELSIF p_file_path !~* ('^' || p_room_id::text || '/media/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]{1,16}$')
     OR p_mime_type NOT IN ('audio/mpeg', 'audio/flac', 'audio/ogg', 'audio/wav', 'audio/webm', 'video/mp4', 'video/ogg', 'video/webm')
     OR (p_mime_type = 'audio/flac' AND (p_media_type <> 'audio' OR p_file_name !~* '\.flac$' OR p_file_path !~* '\.flac$'))
     OR (p_mime_type <> 'audio/flac' AND (p_file_name ~* '\.flac$' OR p_file_path ~* '\.flac$'))
     OR p_file_size IS NULL OR p_file_size <= 0 OR p_file_size > 524288000 THEN
    RAISE EXCEPTION 'Invalid temporary-media object.';
  END IF;

  SELECT * INTO room_row FROM public.rooms r WHERE r.id = p_room_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Room not found.'; END IF;
  active_deadline := CASE
    WHEN room_row.expiration_type = 'permanent' THEN now() + interval '24 hours'
    WHEN room_row.reopened_until IS NOT NULL AND room_row.reopened_until > now() THEN room_row.reopened_until
    ELSE room_row.expires_at
  END;
  media_expires_at := LEAST(now() + interval '24 hours', active_deadline);
  IF media_expires_at IS NULL OR media_expires_at <= now() THEN
    RAISE EXCEPTION 'This room is not open for temporary media.';
  END IF;

  INSERT INTO public.temporary_media (
    room_id, user_id, file_name, file_url, media_type, expires_at,
    storage_bucket, storage_path, mime_type, file_size
  ) VALUES (
    p_room_id, auth.uid(), p_file_name, p_file_path, p_media_type, media_expires_at,
    CASE WHEN p_media_type = 'url' THEN NULL ELSE 'room_attachments' END,
    CASE WHEN p_media_type = 'url' THEN NULL ELSE p_file_path END,
    p_mime_type, p_file_size
  )
  RETURNING * INTO media_row;
  RETURN media_row;
END;
$$;

-- Music uploads use a server-side storage metadata check before this service-role
-- RPC. Passing that verified metadata supports both Supabase and direct R2 uploads.
DROP FUNCTION IF EXISTS public.register_music_upload(
  uuid, uuid, text, text, text, text, text, text, text,
  integer, integer, text, integer, integer, text, boolean
);

CREATE FUNCTION public.register_music_upload(
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
  p_has_cover boolean,
  p_audio_size bigint,
  p_cover_size bigint
)
RETURNS public.music_uploads
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  object_path text;
  cover_path text;
  audio_size bigint := p_audio_size;
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
     OR p_hue IS NULL OR p_hue NOT BETWEEN 0 AND 359
     OR audio_size IS NULL OR audio_size NOT BETWEEN 1 AND 524288000 THEN
    RAISE EXCEPTION 'Invalid music upload.' USING ERRCODE = '22023';
  END IF;

  object_path := p_owner_id::text || '/' || p_upload_id::text || '.' || p_ext;
  cover_path := CASE WHEN p_has_cover THEN p_owner_id::text || '/' || p_upload_id::text || '.cover.jpg' END;
  IF p_has_cover IS TRUE AND (p_cover_size IS NULL OR p_cover_size NOT BETWEEN 1 AND 524288000) THEN
    RAISE EXCEPTION 'The uploaded artwork was not found or does not match.' USING ERRCODE = '22023';
  ELSIF p_has_cover IS NOT TRUE AND p_cover_size IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid music upload.' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('music_uploads:' || p_owner_id::text, 0));
  SELECT count(*), COALESCE(sum(u.size_bytes), 0) INTO active_count, active_bytes
  FROM public.music_uploads u
  WHERE u.owner_id = p_owner_id AND u.state = 'active' AND u.expires_at > now();
  IF active_count >= 40 THEN
    RAISE EXCEPTION 'You can keep up to 40 uploads at a time.' USING ERRCODE = '54000';
  END IF;
  IF active_bytes + audio_size > 524288000 THEN
    RAISE EXCEPTION 'Uploads are limited to 500 MB in total.' USING ERRCODE = '54000';
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

CREATE OR REPLACE FUNCTION public.update_music_upload_tags(
  p_upload_id uuid,
  p_title text DEFAULT NULL,
  p_artist text DEFAULT NULL,
  p_album text DEFAULT NULL,
  p_album_artist text DEFAULT NULL,
  p_track_no integer DEFAULT NULL,
  p_year integer DEFAULT NULL,
  p_add_cover boolean DEFAULT false
)
RETURNS public.music_uploads
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := auth.uid();
  row_in public.music_uploads%ROWTYPE;
  row_out public.music_uploads%ROWTYPE;
  cover text;
  cover_meta jsonb;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO row_in FROM public.music_uploads u WHERE u.id = p_upload_id FOR UPDATE;
  IF NOT FOUND OR row_in.owner_id <> uid OR row_in.state <> 'active' OR row_in.expires_at <= now() THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  IF (p_title IS NOT NULL AND char_length(btrim(p_title)) NOT BETWEEN 1 AND 200)
     OR char_length(COALESCE(p_artist, '')) > 200 OR char_length(COALESCE(p_album, '')) > 200
     OR char_length(COALESCE(p_album_artist, '')) > 200
     OR (p_track_no IS NOT NULL AND p_track_no NOT BETWEEN 1 AND 999)
     OR (p_year IS NOT NULL AND p_year NOT BETWEEN 1000 AND 9999) THEN
    RAISE EXCEPTION 'Invalid tags.' USING ERRCODE = '22023';
  END IF;

  IF p_add_cover IS TRUE THEN
    IF row_in.cover_path IS NOT NULL THEN
      RAISE EXCEPTION 'This upload already has artwork.' USING ERRCODE = '22023';
    END IF;
    cover := uid::text || '/' || p_upload_id::text || '.cover.jpg';
    SELECT o.metadata INTO cover_meta FROM storage.objects o
    WHERE o.bucket_id = 'music_uploads' AND o.name = cover AND o.owner_id = uid::text;
    IF cover_meta IS NULL OR cover_meta ->> 'mimetype' IS DISTINCT FROM 'image/jpeg'
       OR COALESCE((cover_meta ->> 'size')::bigint, 0) NOT BETWEEN 1 AND 524288000 THEN
      RAISE EXCEPTION 'The uploaded artwork was not found or does not match.' USING ERRCODE = '22023';
    END IF;
  END IF;

  UPDATE public.music_uploads SET
    title = COALESCE(btrim(p_title), title),
    artist = COALESCE(p_artist, artist),
    album = COALESCE(p_album, album),
    album_artist = COALESCE(p_album_artist, album_artist),
    track_no = COALESCE(p_track_no, track_no),
    year = COALESCE(p_year, year),
    cover_path = CASE WHEN p_add_cover IS TRUE THEN cover ELSE cover_path END
  WHERE id = p_upload_id
  RETURNING * INTO row_out;
  RETURN row_out;
END;
$$;

REVOKE ALL ON FUNCTION public.register_music_upload(
  uuid, uuid, text, text, text, text, text, text, text,
  integer, integer, text, integer, integer, text, boolean, bigint, bigint
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_music_upload(
  uuid, uuid, text, text, text, text, text, text, text,
  integer, integer, text, integer, integer, text, boolean, bigint, bigint
) TO service_role;
