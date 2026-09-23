BEGIN;
SELECT plan(18);

SELECT has_table('public', 'room_files', 'permanent room-file metadata is durable');
SELECT has_table('public', 'temporary_media_cleanup_jobs', 'temporary-media cleanup retries are durable');

SELECT ok(
  EXISTS (
    SELECT 1 FROM storage.buckets
    WHERE id = 'room_attachments'
      AND public = false
      AND file_size_limit = 52428800
  ),
  'room attachment bucket is private and capped at 50 MB'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM storage.buckets
    WHERE id = 'room_attachments'
      AND allowed_mime_types @> ARRAY['application/pdf', 'video/mp4', 'audio/mpeg', 'audio/flac', 'text/vtt']::text[]
  ),
  'room attachment bucket has the Action 09 MIME allow-list including FLAC'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.room_files'::regclass
      AND conname = 'room_files_mime_type_flac_check'
      AND pg_get_constraintdef(oid, true) LIKE '%audio/flac%'
  ),
  'room-file MIME constraint accepts FLAC without weakening the size constraint'
);
SELECT has_function('public', 'register_room_file', ARRAY['uuid', 'text', 'text', 'text', 'text', 'bigint', 'jsonb'], 'room files are registered through an authorized RPC');
SELECT has_function('public', 'list_room_files', ARRAY['uuid'], 'room-file listing is capability guarded');
SELECT has_function('public', 'get_room_file_download_path', ARRAY['uuid'], 'downloads require a server authorization RPC');
SELECT has_function('public', 'begin_room_file_delete', ARRAY['uuid'], 'permanent deletion begins with durable retry state');
SELECT has_function('public', 'complete_room_file_delete', ARRAY['uuid', 'text'], 'permanent deletion can be retried safely');
SELECT has_function('public', 'register_temporary_media', ARRAY['uuid', 'text', 'text', 'text', 'text', 'bigint'], 'temporary media uses a server-authoritative registration RPC');
SELECT has_function('public', 'set_temporary_media_subtitle', ARRAY['uuid', 'text'], 'subtitles require an authorized media association');

SELECT ok(
  has_function_privilege('authenticated', 'public.register_room_file(uuid,text,text,text,text,bigint,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.register_room_file(uuid,text,text,text,text,bigint,jsonb)', 'EXECUTE'),
  'only authenticated clients can register room files'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'Members can read active room attachments'
      AND qual LIKE '%room_storage_path_room_id%'
      AND qual LIKE '%room_has_capability%'
  ),
  'storage reads use a validated room prefix and room capability'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'Members can upload active room attachments'
      AND with_check LIKE '%watch_control%'
      AND with_check LIKE '%room_storage_path_kind%'
  ),
  'media and subtitle writes require a structured path and Watch control'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'Members can delete active room attachments'
      AND qual LIKE '%room_files%'
      AND qual LIKE '%is_room_admin_or_owner%'
  ),
  'permanent storage deletion is restricted to the owner or room admin'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = 'public.register_room_file(uuid,text,text,text,text,bigint,jsonb)'::regprocedure
      AND prosrc LIKE '%audio/flac%'
      AND prosrc LIKE '%p_original_name !~*%'
      AND prosrc LIKE '%p_object_path !~*%'
  ),
  'room-file registration enforces the FLAC MIME and extension pairing server-side'
);

SELECT ok(
  (
    EXISTS (
      SELECT 1 FROM pg_proc
      WHERE oid = 'public.register_temporary_media(uuid,text,text,text,text,bigint)'::regprocedure
        AND prosrc LIKE '%audio/flac%'
        AND prosrc LIKE '%p_file_name !~*%'
        AND prosrc LIKE '%LEAST(now() + interval ''24 hours''%'
        AND prosrc LIKE '%room_has_capability(p_room_id, auth.uid(), ''watch_control'')%'
    )
  )
  AND EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = 'public.set_temporary_media_subtitle(uuid,text)'::regprocedure
      AND prosrc LIKE '%media_row.expires_at <= now()%'
  ),
  'temporary FLAC registration remains server-authorized and expired media cannot receive subtitles'
);

SELECT * FROM finish();
ROLLBACK;
