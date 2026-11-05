-- Action 16 / 16.13 (part): "Fix tags" for an upload from a MusicBrainz match the
-- owner picked. Additive only. Clients still have no UPDATE on music_uploads;
-- this owner-only RPC is the single write path. NULL arguments keep the value.
-- p_add_cover attaches <owner>/<id>.cover.jpg (uploaded by the owner into the
-- existing cover slot) only when the upload has no cover yet.

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
       OR COALESCE((cover_meta ->> 'size')::bigint, 0) NOT BETWEEN 1 AND 2097152 THEN
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

REVOKE ALL ON FUNCTION public.update_music_upload_tags(uuid, text, text, text, text, integer, integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_music_upload_tags(uuid, text, text, text, text, integer, integer, boolean) TO authenticated, service_role;
