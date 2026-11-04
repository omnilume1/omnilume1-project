-- Action 09 forward repair: converge the pre-existing room attachment bucket
-- to the approved private 50 MiB contract. This updates only bucket metadata;
-- it neither reads, writes, moves, nor deletes storage.objects rows.
--
-- The allow-list matches the Action 09 client and RPC validation, including
-- FLAC. Existing objects remain readable through the existing private policies.

UPDATE storage.buckets
SET
  public = false,
  file_size_limit = 52428800,
  allowed_mime_types = ARRAY[
    'application/pdf',
    'application/x-subrip',
    'text/plain',
    'text/markdown',
    'text/vtt',
    'image/gif',
    'image/jpeg',
    'image/png',
    'image/webp',
    'audio/mpeg',
    'audio/flac',
    'audio/ogg',
    'audio/wav',
    'audio/webm',
    'video/mp4',
    'video/ogg',
    'video/webm'
  ]::text[]
WHERE id = 'room_attachments'
  AND (
    public IS DISTINCT FROM false
    OR file_size_limit IS DISTINCT FROM 52428800
    OR allowed_mime_types IS DISTINCT FROM ARRAY[
      'application/pdf',
      'application/x-subrip',
      'text/plain',
      'text/markdown',
      'text/vtt',
      'image/gif',
      'image/jpeg',
      'image/png',
      'image/webp',
      'audio/mpeg',
      'audio/flac',
      'audio/ogg',
      'audio/wav',
      'audio/webm',
      'video/mp4',
      'video/ogg',
      'video/webm'
    ]::text[]
  );
