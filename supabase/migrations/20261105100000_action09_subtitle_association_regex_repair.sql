-- Action 09 repair (D8), found while redesigning room Realtime for D7.
-- Additive and narrowly scoped: one function body, no data, grants or
-- policies change.
--
-- set_temporary_media_subtitle (20260923140000) validates the subtitle path
-- with '...\\.(vtt|srt)$'. Inside a $$ body with standard_conforming_strings
-- on, that is a regex for a literal backslash followed by any character, so
-- every valid <room>/subtitles/<uuid>.(vtt|srt) path is rejected. Verified
-- read-only in production on 2026-11-05: a valid path is rejected, and the
-- deployed body still contains the doubled backslash.
-- 20260924093000 already fixed the same doubled backslash in
-- register_room_file and register_temporary_media but missed this function.
-- The D7 Watch design binds subtitles to their media row through this RPC
-- instead of broadcasting signed subtitle URLs, so it must work.
--
-- Only '\\.' changes to '\.'. CREATE OR REPLACE keeps the existing grants
-- (authenticated and service_role, not anon).
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
     OR p_subtitle_path !~* ('^' || media_row.room_id::text || '/subtitles/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(vtt|srt)$') THEN
    RAISE EXCEPTION 'Invalid or unauthorized subtitle association.';
  END IF;

  UPDATE public.temporary_media
  SET subtitle_path = p_subtitle_path
  WHERE id = p_media_id
  RETURNING * INTO media_row;
  RETURN media_row;
END;
$$;
