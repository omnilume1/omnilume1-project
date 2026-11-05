-- Action 10: media metadata cached with the media row.
--
-- Title, artist, album, year, duration and artwork are read by the server
-- from the stored file's own embedded tags (or its file name), once, at
-- registration, and kept on the temporary_media row so every member and
-- every "Cast again" reuses them. No external metadata provider is used and
-- the row (and so the cached artwork) is deleted with the media.
--
-- Clients still cannot write temporary_media (revoked in 20260923140000);
-- only the server records metadata after reading the file itself. Members
-- read it through the existing watch-capability SELECT policy.

ALTER TABLE public.temporary_media
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.temporary_media DROP CONSTRAINT IF EXISTS temporary_media_metadata_shape_check;
ALTER TABLE public.temporary_media ADD CONSTRAINT temporary_media_metadata_shape_check CHECK (
  jsonb_typeof(metadata) = 'object'
  AND octet_length(metadata::text) <= 409600
  AND (metadata - ARRAY['title', 'artist', 'album', 'year', 'duration_seconds', 'source', 'artwork', 'extracted_at']) = '{}'::jsonb
  AND (NOT (metadata ? 'source') OR metadata ->> 'source' IN ('tags', 'filename'))
  AND (
    NOT (metadata ? 'artwork')
    OR (
      jsonb_typeof(metadata -> 'artwork') = 'object'
      AND metadata -> 'artwork' ->> 'mime_type' IN ('image/jpeg', 'image/png')
      AND (metadata -> 'artwork' ->> 'data') ~ '^[A-Za-z0-9+/]+={0,2}$'
    )
  )
);

REVOKE INSERT, UPDATE, DELETE ON TABLE public.temporary_media FROM anon, authenticated;
