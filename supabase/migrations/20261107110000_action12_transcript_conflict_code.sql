-- Action 12 follow-up: a stale transcript save used SQLSTATE 40001, which
-- PostgREST treats as a retryable serialization failure, so clients never saw
-- a usable error. Same function and checks; the conflict now raises 23514
-- (the code the other Action 12 RPCs use for rejected state changes).
CREATE OR REPLACE FUNCTION public.save_room_transcript(p_recording_id uuid, p_expected_version bigint, p_body text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.room_recordings%ROWTYPE;
  v_version bigint;
BEGIN
  SELECT * INTO v_row FROM public.room_recordings r WHERE r.id = p_recording_id;
  IF NOT FOUND OR NOT public.can_view_room_recording(p_recording_id) THEN
    RAISE EXCEPTION 'Only participants can edit this transcript.' USING ERRCODE = '42501';
  END IF;
  IF v_row.status <> 'stopped' OR char_length(COALESCE(p_body, '')) > 200000 THEN
    RAISE EXCEPTION 'Transcripts can be written for finished recordings (200000 characters).' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_expected_version, 0) = 0 THEN
    INSERT INTO public.room_recording_transcripts (recording_id, room_id, body, updated_by)
    VALUES (p_recording_id, v_row.room_id, COALESCE(p_body, ''), auth.uid())
    ON CONFLICT (recording_id) DO NOTHING
    RETURNING version INTO v_version;
  ELSE
    UPDATE public.room_recording_transcripts
    SET body = COALESCE(p_body, ''), version = version + 1, updated_by = auth.uid(), updated_at = now()
    WHERE recording_id = p_recording_id AND version = p_expected_version
    RETURNING version INTO v_version;
  END IF;
  IF v_version IS NULL THEN
    RAISE EXCEPTION 'Transcript update rejected: expected version does not match.' USING ERRCODE = '23514';
  END IF;
  RETURN v_version;
END;
$$;

REVOKE ALL ON FUNCTION public.save_room_transcript(uuid, bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_room_transcript(uuid, bigint, text) TO authenticated;
