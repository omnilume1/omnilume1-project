-- Action 16 Stage 3 repair: a stale queue delta raised SQLSTATE 40001
-- (serialization_failure), which PostgREST retries automatically, so the
-- call looped instead of returning. Same function, code 55000 instead.

CREATE OR REPLACE FUNCTION public.music_listen_control(
  p_kind text, p_target uuid, p_action text,
  p_upload_id uuid DEFAULT NULL, p_position_ms integer DEFAULT NULL, p_index integer DEFAULT NULL, p_flag boolean DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid uuid := auth.uid();
  s public.music_listen_sessions%ROWTYPE;
  host_gone boolean;
  pos integer;
  shared_ok boolean;
  out_json jsonb;
BEGIN
  IF uid IS NULL OR NOT public.music_listen_can_join(p_kind, p_target) THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('start', 'play', 'pause', 'seek', 'load', 'enqueue', 'remove', 'next', 'host_only', 'end') THEN
    RAISE EXCEPTION 'Invalid action.' USING ERRCODE = '22023';
  END IF;
  IF p_position_ms IS NOT NULL AND (p_position_ms < 0 OR p_position_ms > 86400000) THEN
    RAISE EXCEPTION 'Invalid position.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.music_listen_sessions (target_kind, target_id, host_id, ended_at)
  VALUES (p_kind, p_target, uid, now())
  ON CONFLICT (target_kind, target_id) DO NOTHING;
  SELECT * INTO s FROM public.music_listen_sessions x WHERE x.target_kind = p_kind AND x.target_id = p_target FOR UPDATE;

  host_gone := s.host_id IS NULL OR NOT CASE s.target_kind
    WHEN 'room' THEN EXISTS (
      SELECT 1 FROM public.room_members rm
      WHERE rm.room_id = s.target_id AND rm.user_id = s.host_id AND rm.join_status = 'approved')
    ELSE EXISTS (SELECT 1 FROM public.group_members gm WHERE gm.group_id = s.target_id AND gm.user_id = s.host_id) END;

  IF p_action = 'start' THEN
    -- Join a live session; take over an ended, abandoned (host left) or idle (> 6 h) one.
    IF s.ended_at IS NULL AND NOT host_gone AND s.updated_at > now() - interval '6 hours' THEN
      RETURN public.music_listen_json(s);
    END IF;
    UPDATE public.music_listen_sessions x
    SET host_id = uid, host_only = COALESCE(p_flag, false), upload_id = NULL, position_ms = 0, is_playing = false,
        anchor_at = now(), queue = '{}', seq = x.seq + 1, ended_at = NULL, updated_at = now()
    WHERE x.id = s.id RETURNING * INTO s;
  ELSE
    IF s.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'No one is listening here right now.' USING ERRCODE = 'P0002';
    END IF;
    IF p_action IN ('host_only', 'end') AND s.host_id IS DISTINCT FROM uid AND NOT (p_action = 'end' AND host_gone) THEN
      RAISE EXCEPTION 'Only the host can do that.' USING ERRCODE = '42501';
    END IF;
    IF s.host_only AND s.host_id IS DISTINCT FROM uid AND NOT (p_action = 'end' AND host_gone) THEN
      RAISE EXCEPTION 'Only the host can control playback.' USING ERRCODE = '42501';
    END IF;
    IF p_action IN ('load', 'enqueue') THEN
      SELECT EXISTS (
        SELECT 1 FROM public.music_upload_shares sh JOIN public.music_uploads u ON u.id = sh.upload_id
        WHERE sh.upload_id = p_upload_id AND sh.target_kind = p_kind AND sh.target_id = p_target
          AND u.state = 'active' AND u.expires_at > now()
      ) INTO shared_ok;
      IF shared_ok IS NOT TRUE THEN
        RAISE EXCEPTION 'Share this song to the room or group first.' USING ERRCODE = '22023';
      END IF;
    END IF;

    -- Where the shared playhead is right now (anchor maths), then apply the change.
    pos := LEAST(86400000, s.position_ms + CASE WHEN s.is_playing
      THEN GREATEST(0, (extract(epoch FROM now() - s.anchor_at) * 1000)::integer) ELSE 0 END);
    IF p_action = 'next' AND s.upload_id IS DISTINCT FROM p_upload_id THEN
      -- Several listeners finish the same song at once: only the first advance applies.
      RETURN public.music_listen_json(s);
    END IF;
    IF p_action IN ('play', 'pause', 'seek') AND s.upload_id IS NULL THEN
      RAISE EXCEPTION 'Pick a song first.' USING ERRCODE = '22023';
    END IF;
    IF p_action = 'seek' AND p_position_ms IS NULL THEN
      RAISE EXCEPTION 'Invalid position.' USING ERRCODE = '22023';
    END IF;
    IF p_action = 'enqueue' AND cardinality(s.queue) >= 100 THEN
      RAISE EXCEPTION 'The queue holds up to 100 songs.' USING ERRCODE = '54000';
    END IF;
    IF p_action = 'remove' AND (p_index IS NULL OR p_index < 0 OR p_index >= cardinality(s.queue) OR s.queue[p_index + 1] IS DISTINCT FROM p_upload_id) THEN
      RAISE EXCEPTION 'The queue changed. Try again.' USING ERRCODE = '55000';
    END IF;

    UPDATE public.music_listen_sessions x SET
      upload_id = CASE p_action
        WHEN 'load' THEN p_upload_id
        WHEN 'next' THEN COALESCE(x.queue[1], x.upload_id)
        ELSE x.upload_id END,
      queue = CASE p_action
        WHEN 'enqueue' THEN x.queue || p_upload_id
        WHEN 'remove' THEN x.queue[1:p_index] || x.queue[p_index + 2:cardinality(x.queue)]
        WHEN 'next' THEN COALESCE(x.queue[2:cardinality(x.queue)], '{}')
        ELSE x.queue END,
      is_playing = CASE p_action
        WHEN 'play' THEN true WHEN 'load' THEN true WHEN 'pause' THEN false WHEN 'end' THEN false
        WHEN 'next' THEN cardinality(x.queue) > 0
        ELSE x.is_playing END,
      position_ms = CASE
        WHEN p_action IN ('load', 'next') THEN 0
        WHEN p_action IN ('play', 'pause', 'seek') THEN COALESCE(p_position_ms, pos)
        ELSE pos END,
      host_only = CASE WHEN p_action = 'host_only' THEN COALESCE(p_flag, false) ELSE x.host_only END,
      ended_at = CASE WHEN p_action = 'end' THEN now() ELSE NULL END,
      anchor_at = now(), seq = x.seq + 1, updated_at = now()
    WHERE x.id = s.id RETURNING * INTO s;
  END IF;

  out_json := public.music_listen_json(s);
  PERFORM realtime.send(out_json, 'state', 'music_listen_' || p_kind || '_' || p_target::text, true);
  RETURN out_json;
END;
$$;
