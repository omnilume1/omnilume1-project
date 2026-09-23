-- Action 09 forward FLAC support. This migration changes only validation
-- metadata and functions; it never reads, writes, moves, or deletes
-- storage.objects rows. Existing room_attachments objects are untouched.

-- Keep continuous MIME enforcement while replacing the inspected pre-FLAC
-- check. The new constraint is validated before the old one is removed.
ALTER TABLE public.room_files
  ADD CONSTRAINT room_files_mime_type_flac_check
  CHECK (mime_type IN (
    'application/pdf', 'application/x-subrip', 'text/plain', 'text/markdown', 'text/vtt',
    'image/gif', 'image/jpeg', 'image/png', 'image/webp',
    'audio/mpeg', 'audio/flac', 'audio/ogg', 'audio/wav', 'audio/webm',
    'video/mp4', 'video/ogg', 'video/webm'
  )) NOT VALID;

ALTER TABLE public.room_files
  VALIDATE CONSTRAINT room_files_mime_type_flac_check;

ALTER TABLE public.room_files
  DROP CONSTRAINT room_files_mime_type_check;

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
     OR p_size_bytes IS NULL OR p_size_bytes <= 0 OR p_size_bytes > 52428800
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
     OR p_file_size IS NULL OR p_file_size <= 0 OR p_file_size > 52428800 THEN
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

REVOKE ALL ON FUNCTION public.register_room_file(uuid, text, text, text, text, bigint, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.register_temporary_media(uuid, text, text, text, text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_room_file(uuid, text, text, text, text, bigint, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.register_temporary_media(uuid, text, text, text, text, bigint) TO authenticated, service_role;
