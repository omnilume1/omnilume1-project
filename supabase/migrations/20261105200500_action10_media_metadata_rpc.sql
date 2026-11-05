-- Action 10: the metadata cache is written through an RPC, like every other
-- temporary_media write. Only the server (service role) may call it, after
-- reading the stored file's own tags; the table's
-- temporary_media_metadata_shape_check still validates every value.

CREATE OR REPLACE FUNCTION public.cache_temporary_media_metadata(p_media_id uuid, p_room_id uuid, p_metadata jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_media_id IS NULL OR p_room_id IS NULL OR p_metadata IS NULL THEN
    RAISE EXCEPTION 'Invalid media metadata.' USING ERRCODE = '22023';
  END IF;
  UPDATE public.temporary_media
  SET metadata = p_metadata
  WHERE id = p_media_id AND room_id = p_room_id;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.cache_temporary_media_metadata(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cache_temporary_media_metadata(uuid, uuid, jsonb) TO service_role;
