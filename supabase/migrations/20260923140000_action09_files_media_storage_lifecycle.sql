-- Action 09: private room files and media lifecycle.
-- Forward-only: this migration adds a private bucket contract, metadata tables,
-- retry state, bounded RPCs, and narrower storage policies. It does not alter
-- or remove room, chat, lifecycle, or Realtime data.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'room_attachments',
  'room_attachments',
  false,
  52428800,
  ARRAY[
    'application/pdf', 'application/x-subrip', 'text/plain', 'text/markdown', 'text/vtt',
    'image/gif', 'image/jpeg', 'image/png', 'image/webp',
    'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm',
    'video/mp4', 'video/ogg', 'video/webm'
  ]
)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.room_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  storage_provider text NOT NULL DEFAULT 'supabase' CHECK (storage_provider = 'supabase'),
  storage_bucket text NOT NULL DEFAULT 'room_attachments' CHECK (storage_bucket = 'room_attachments'),
  object_path text NOT NULL CHECK (char_length(object_path) BETWEEN 1 AND 512),
  original_name text NOT NULL CHECK (char_length(original_name) BETWEEN 1 AND 180),
  normalized_name text NOT NULL CHECK (char_length(normalized_name) BETWEEN 1 AND 180),
  mime_type text NOT NULL CHECK (mime_type IN (
    'application/pdf', 'application/x-subrip', 'text/plain', 'text/markdown', 'text/vtt',
    'image/gif', 'image/jpeg', 'image/png', 'image/webp',
    'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm',
    'video/mp4', 'video/ogg', 'video/webm'
  )),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 52428800),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  retention_state text NOT NULL DEFAULT 'active' CHECK (retention_state IN ('active', 'delete_pending', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  delete_requested_at timestamptz,
  deleted_at timestamptz,
  last_cleanup_error text,
  cleanup_attempts integer NOT NULL DEFAULT 0 CHECK (cleanup_attempts >= 0),
  UNIQUE (storage_bucket, object_path)
);

CREATE UNIQUE INDEX IF NOT EXISTS room_files_one_active_name_per_room
  ON public.room_files (room_id, normalized_name)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS room_files_room_active_created_idx
  ON public.room_files (room_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS room_files_pending_cleanup_idx
  ON public.room_files (delete_requested_at)
  WHERE retention_state = 'delete_pending';

ALTER TABLE public.temporary_media
  ADD COLUMN IF NOT EXISTS storage_bucket text,
  ADD COLUMN IF NOT EXISTS storage_path text,
  ADD COLUMN IF NOT EXISTS mime_type text,
  ADD COLUMN IF NOT EXISTS file_size bigint,
  ADD COLUMN IF NOT EXISTS subtitle_path text;

CREATE INDEX IF NOT EXISTS temporary_media_expiry_idx
  ON public.temporary_media (expires_at);

CREATE TABLE IF NOT EXISTS public.temporary_media_cleanup_jobs (
  media_id uuid PRIMARY KEY REFERENCES public.temporary_media(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  last_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS temporary_media_cleanup_jobs_pending_idx
  ON public.temporary_media_cleanup_jobs (updated_at)
  WHERE status IN ('pending', 'failed');

ALTER TABLE public.room_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.temporary_media_cleanup_jobs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.room_files FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.temporary_media_cleanup_jobs FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.temporary_media FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.room_storage_path_room_id(p_object_name text)
RETURNS uuid
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO ''
AS $$
DECLARE
  candidate text;
BEGIN
  candidate := split_part(COALESCE(p_object_name, ''), '/', 1);
  IF candidate ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RETURN candidate::uuid;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.room_storage_path_kind(p_object_name text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO ''
AS $$
DECLARE
  second_segment text;
BEGIN
  IF public.room_storage_path_room_id(p_object_name) IS NULL
     OR p_object_name IS NULL
     OR p_object_name LIKE '%..%'
     OR position('\\' IN p_object_name) > 0 THEN
    RETURN NULL;
  END IF;
  second_segment := split_part(p_object_name, '/', 2);
  IF second_segment IN ('files', 'media', 'subtitles') THEN
    RETURN second_segment;
  END IF;
  -- Existing Actions 01–08 objects used a direct room-prefix path. They are
  -- retained read-only for compatibility while Action 09 writes structured paths.
  RETURN 'legacy';
END;
$$;

-- These are the Action 05 policy names inspected in the current linked
-- migration history. ALTER preserves their identity and role instead of
-- dropping/recreating a policy in this additive forward migration.
ALTER POLICY "Members can read active room attachments" ON storage.objects
USING (
  bucket_id = 'room_attachments'
  AND public.room_storage_path_room_id(name) IS NOT NULL
  AND (
    (
      public.room_storage_path_kind(name) IN ('files', 'legacy')
      AND public.room_has_capability(public.room_storage_path_room_id(name), auth.uid(), 'files')
    )
    OR (
      public.room_storage_path_kind(name) IN ('media', 'subtitles', 'legacy')
      AND public.room_has_capability(public.room_storage_path_room_id(name), auth.uid(), 'watch')
    )
  )
);

ALTER POLICY "Members can upload active room attachments" ON storage.objects
WITH CHECK (
  bucket_id = 'room_attachments'
  AND public.room_storage_path_room_id(name) IS NOT NULL
  AND (
    (
      public.room_storage_path_kind(name) = 'files'
      AND public.room_has_capability(public.room_storage_path_room_id(name), auth.uid(), 'files')
    )
    OR (
      public.room_storage_path_kind(name) IN ('media', 'subtitles')
      AND public.room_has_capability(public.room_storage_path_room_id(name), auth.uid(), 'watch_control')
    )
  )
);

ALTER POLICY "Members can delete active room attachments" ON storage.objects
USING (
  bucket_id = 'room_attachments'
  AND public.room_storage_path_room_id(name) IS NOT NULL
  AND (
    (
      public.room_storage_path_kind(name) = 'files'
      AND (
        EXISTS (
          SELECT 1
          FROM public.room_files rf
          WHERE rf.storage_bucket = storage.objects.bucket_id
            AND rf.object_path = storage.objects.name
            AND rf.owner_id = auth.uid()
            AND rf.deleted_at IS NULL
        )
        OR public.is_room_admin_or_owner(public.room_storage_path_room_id(name), auth.uid())
      )
    )
    OR (
      public.room_storage_path_kind(name) IN ('media', 'subtitles')
      AND public.room_has_capability(public.room_storage_path_room_id(name), auth.uid(), 'watch_control')
    )
  )
);

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
     OR p_object_path !~* ('^' || p_room_id::text || '/files/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.[a-z0-9]{1,16}$')
     OR char_length(COALESCE(p_original_name, '')) NOT BETWEEN 1 AND 180
     OR char_length(COALESCE(p_normalized_name, '')) NOT BETWEEN 1 AND 180
     OR p_mime_type NOT IN (
       'application/pdf', 'application/x-subrip', 'text/plain', 'text/markdown', 'text/vtt',
       'image/gif', 'image/jpeg', 'image/png', 'image/webp',
       'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm',
       'video/mp4', 'video/ogg', 'video/webm'
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

CREATE OR REPLACE FUNCTION public.list_room_files(p_room_id uuid)
RETURNS SETOF public.room_files
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.room_has_capability(p_room_id, auth.uid(), 'files') THEN
    RAISE EXCEPTION 'Not authorized to view room files.';
  END IF;

  RETURN QUERY
  SELECT rf.*
  FROM public.room_files rf
  WHERE rf.room_id = p_room_id AND rf.deleted_at IS NULL
  ORDER BY rf.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_room_file_download_path(p_file_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  file_row public.room_files%ROWTYPE;
BEGIN
  SELECT * INTO file_row
  FROM public.room_files rf
  WHERE rf.id = p_file_id AND rf.deleted_at IS NULL;

  IF NOT FOUND OR auth.uid() IS NULL
     OR NOT public.room_has_capability(file_row.room_id, auth.uid(), 'files') THEN
    RAISE EXCEPTION 'Not authorized to download this room file.';
  END IF;
  RETURN file_row.object_path;
END;
$$;

CREATE OR REPLACE FUNCTION public.begin_room_file_delete(p_file_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  file_row public.room_files%ROWTYPE;
BEGIN
  SELECT * INTO file_row FROM public.room_files rf WHERE rf.id = p_file_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL
     OR NOT (file_row.owner_id = auth.uid() OR public.is_room_admin_or_owner(file_row.room_id, auth.uid())) THEN
    RAISE EXCEPTION 'Not authorized to delete this room file.';
  END IF;

  IF file_row.deleted_at IS NOT NULL THEN
    RETURN NULL;
  END IF;

  UPDATE public.room_files
  SET retention_state = 'delete_pending',
      delete_requested_at = COALESCE(delete_requested_at, now()),
      cleanup_attempts = cleanup_attempts + 1,
      last_cleanup_error = NULL
  WHERE id = p_file_id;
  RETURN file_row.object_path;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_room_file_delete(p_file_id uuid, p_error text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  file_row public.room_files%ROWTYPE;
  caller_is_service boolean := COALESCE(current_setting('request.jwt.claim.role', true), '') = 'service_role';
BEGIN
  SELECT * INTO file_row FROM public.room_files rf WHERE rf.id = p_file_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT caller_is_service AND (auth.uid() IS NULL
     OR NOT (file_row.owner_id = auth.uid() OR public.is_room_admin_or_owner(file_row.room_id, auth.uid()))) THEN
    RAISE EXCEPTION 'Not authorized to finalize this room-file cleanup.';
  END IF;

  IF p_error IS NULL THEN
    UPDATE public.room_files
    SET retention_state = 'deleted', deleted_at = COALESCE(deleted_at, now()), last_cleanup_error = NULL
    WHERE id = p_file_id;
  ELSE
    UPDATE public.room_files
    SET retention_state = 'delete_pending',
        cleanup_attempts = cleanup_attempts + 1,
        last_cleanup_error = left(p_error, 1000)
    WHERE id = p_file_id;
  END IF;
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
  ELSIF p_file_path !~* ('^' || p_room_id::text || '/media/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.[a-z0-9]{1,16}$')
     OR p_mime_type NOT IN ('audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'video/mp4', 'video/ogg', 'video/webm')
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

CREATE OR REPLACE FUNCTION public.set_temporary_media_subtitle(
  p_media_id uuid,
  p_subtitle_path text
)
RETURNS public.temporary_media
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  media_row public.temporary_media%ROWTYPE;
BEGIN
  SELECT * INTO media_row FROM public.temporary_media tm WHERE tm.id = p_media_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL
     OR media_row.expires_at <= now()
     OR NOT public.room_has_capability(media_row.room_id, auth.uid(), 'watch_control')
     OR p_subtitle_path !~* ('^' || media_row.room_id::text || '/subtitles/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.(vtt|srt)$') THEN
    RAISE EXCEPTION 'Invalid or unauthorized subtitle association.';
  END IF;

  UPDATE public.temporary_media
  SET subtitle_path = p_subtitle_path
  WHERE id = p_media_id
  RETURNING * INTO media_row;
  RETURN media_row;
END;
$$;

REVOKE ALL ON FUNCTION public.room_storage_path_room_id(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.room_storage_path_kind(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.register_room_file(uuid, text, text, text, text, bigint, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_room_files(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_room_file_download_path(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.begin_room_file_delete(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.complete_room_file_delete(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.register_temporary_media(uuid, text, text, text, text, bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_temporary_media_subtitle(uuid, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.room_storage_path_room_id(text), public.room_storage_path_kind(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.register_room_file(uuid, text, text, text, text, bigint, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_room_files(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_room_file_download_path(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.begin_room_file_delete(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_room_file_delete(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.register_temporary_media(uuid, text, text, text, text, bigint) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_temporary_media_subtitle(uuid, text) TO authenticated, service_role;
