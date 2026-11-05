-- Action 11: shared Watch queue and clips/highlights.
--
-- Both reference registered room media (temporary_media), so they follow the
-- media lifecycle: when the media expires and is cleaned up, its queue
-- entries and clips go with it. Members who can watch read them (RLS);
-- every write goes through an RPC that re-checks room capabilities:
--   queue: add = watch; remove own = watch; remove any / reorder =
--          watch_control.
--   clips: create = watch; delete own = watch; delete any = watch_control.
-- Clients get a revision hint over the private sync-watch topic and re-read
-- through RLS; queue and clip contents never travel over Broadcast.

CREATE TABLE IF NOT EXISTS public.room_media_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  media_id uuid NOT NULL REFERENCES public.temporary_media(id) ON DELETE CASCADE,
  added_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, media_id)
);
CREATE INDEX IF NOT EXISTS room_media_queue_room_position_idx ON public.room_media_queue (room_id, position);
CREATE INDEX IF NOT EXISTS room_media_queue_media_idx ON public.room_media_queue (media_id);
CREATE INDEX IF NOT EXISTS room_media_queue_added_by_idx ON public.room_media_queue (added_by);

CREATE TABLE IF NOT EXISTS public.room_media_clips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  media_id uuid NOT NULL REFERENCES public.temporary_media(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  start_seconds numeric(10, 2) NOT NULL CHECK (start_seconds >= 0 AND start_seconds <= 172800),
  end_seconds numeric(10, 2) CHECK (end_seconds IS NULL OR (end_seconds > start_seconds AND end_seconds <= 172800)),
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS room_media_clips_media_idx ON public.room_media_clips (media_id, start_seconds);
CREATE INDEX IF NOT EXISTS room_media_clips_room_idx ON public.room_media_clips (room_id);
CREATE INDEX IF NOT EXISTS room_media_clips_created_by_idx ON public.room_media_clips (created_by);

ALTER TABLE public.room_media_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_media_clips ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.room_media_queue FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.room_media_clips FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.room_media_queue TO authenticated;
GRANT SELECT ON TABLE public.room_media_clips TO authenticated;

DROP POLICY IF EXISTS "Watch members read the room queue" ON public.room_media_queue;
CREATE POLICY "Watch members read the room queue"
ON public.room_media_queue FOR SELECT TO authenticated
USING (public.room_has_capability(room_id, auth.uid(), 'watch'));

DROP POLICY IF EXISTS "Watch members read room clips" ON public.room_media_clips;
CREATE POLICY "Watch members read room clips"
ON public.room_media_clips FOR SELECT TO authenticated
USING (public.room_has_capability(room_id, auth.uid(), 'watch'));

-- Live, registered media of this room (not expired).
CREATE OR REPLACE FUNCTION public.room_media_is_live(p_room_id uuid, p_media_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.temporary_media tm
    WHERE tm.id = p_media_id AND tm.room_id = p_room_id AND tm.expires_at > now()
  );
$$;
REVOKE ALL ON FUNCTION public.room_media_is_live(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.add_media_to_queue(p_room_id uuid, p_media_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid;
BEGIN
  IF v_uid IS NULL OR NOT public.room_has_capability(p_room_id, v_uid, 'watch') THEN
    RAISE EXCEPTION 'You cannot add to this room''s queue.' USING ERRCODE = '42501';
  END IF;
  IF NOT public.room_media_is_live(p_room_id, p_media_id) THEN
    RAISE EXCEPTION 'That media is not available in this room.' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('room-media-queue:' || p_room_id::text, 0));
  IF (SELECT count(*) FROM public.room_media_queue q WHERE q.room_id = p_room_id) >= 50 THEN
    RAISE EXCEPTION 'The queue holds up to 50 items.' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.room_media_queue q WHERE q.room_id = p_room_id AND q.media_id = p_media_id) THEN
    RAISE EXCEPTION 'That media is already in the queue.' USING ERRCODE = '23505';
  END IF;
  INSERT INTO public.room_media_queue (room_id, media_id, added_by, position)
  VALUES (
    p_room_id, p_media_id, v_uid,
    COALESCE((SELECT max(q.position) + 1 FROM public.room_media_queue q WHERE q.room_id = p_room_id), 0)
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_media_from_queue(p_item_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_item public.room_media_queue%ROWTYPE;
BEGIN
  SELECT * INTO v_item FROM public.room_media_queue q WHERE q.id = p_item_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_uid IS NULL
     OR NOT (
       public.room_has_capability(v_item.room_id, v_uid, 'watch_control')
       OR (v_item.added_by = v_uid AND public.room_has_capability(v_item.room_id, v_uid, 'watch'))
     ) THEN
    RAISE EXCEPTION 'You cannot remove this queue item.' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('room-media-queue:' || v_item.room_id::text, 0));
  DELETE FROM public.room_media_queue q WHERE q.id = p_item_id;
  -- Keep positions dense.
  UPDATE public.room_media_queue q
  SET position = ordered.new_position
  FROM (
    SELECT q2.id, (row_number() OVER (ORDER BY q2.position, q2.created_at) - 1)::integer AS new_position
    FROM public.room_media_queue q2 WHERE q2.room_id = v_item.room_id
  ) ordered
  WHERE q.id = ordered.id AND q.position <> ordered.new_position;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.move_media_in_queue(p_item_id uuid, p_to_index integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_item public.room_media_queue%ROWTYPE;
  v_count integer;
  v_target integer;
BEGIN
  SELECT * INTO v_item FROM public.room_media_queue q WHERE q.id = p_item_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_uid IS NULL OR NOT public.room_has_capability(v_item.room_id, v_uid, 'watch_control') THEN
    RAISE EXCEPTION 'Only members who control Watch can reorder the queue.' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('room-media-queue:' || v_item.room_id::text, 0));
  SELECT count(*) INTO v_count FROM public.room_media_queue q WHERE q.room_id = v_item.room_id;
  v_target := GREATEST(0, LEAST(v_count - 1, COALESCE(p_to_index, 0)));
  WITH ordered AS (
    SELECT q.id, row_number() OVER (ORDER BY q.position, q.created_at) - 1 AS idx
    FROM public.room_media_queue q WHERE q.room_id = v_item.room_id AND q.id <> p_item_id
  ), placed AS (
    SELECT ordered.id, (CASE WHEN ordered.idx >= v_target THEN ordered.idx + 1 ELSE ordered.idx END)::integer AS new_position FROM ordered
    UNION ALL
    SELECT p_item_id, v_target
  )
  UPDATE public.room_media_queue q SET position = placed.new_position
  FROM placed WHERE q.id = placed.id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_media_clip(p_room_id uuid, p_media_id uuid, p_start numeric, p_end numeric, p_label text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid;
BEGIN
  IF v_uid IS NULL OR NOT public.room_has_capability(p_room_id, v_uid, 'watch') THEN
    RAISE EXCEPTION 'You cannot save clips in this room.' USING ERRCODE = '42501';
  END IF;
  IF NOT public.room_media_is_live(p_room_id, p_media_id) THEN
    RAISE EXCEPTION 'That media is not available in this room.' USING ERRCODE = 'P0002';
  END IF;
  IF (SELECT count(*) FROM public.room_media_clips c WHERE c.media_id = p_media_id) >= 200 THEN
    RAISE EXCEPTION 'This media already has 200 clips.' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.room_media_clips (room_id, media_id, created_by, start_seconds, end_seconds, label)
  VALUES (p_room_id, p_media_id, v_uid, round(p_start, 2), CASE WHEN p_end IS NULL THEN NULL ELSE round(p_end, 2) END, btrim(p_label))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_media_clip(p_clip_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_clip public.room_media_clips%ROWTYPE;
BEGIN
  SELECT * INTO v_clip FROM public.room_media_clips c WHERE c.id = p_clip_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_uid IS NULL
     OR NOT (
       public.room_has_capability(v_clip.room_id, v_uid, 'watch_control')
       OR (v_clip.created_by = v_uid AND public.room_has_capability(v_clip.room_id, v_uid, 'watch'))
     ) THEN
    RAISE EXCEPTION 'You cannot delete this clip.' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.room_media_clips c WHERE c.id = p_clip_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.add_media_to_queue(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.remove_media_from_queue(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.move_media_in_queue(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_media_clip(uuid, uuid, numeric, numeric, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_media_clip(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_media_to_queue(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_media_from_queue(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.move_media_in_queue(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_media_clip(uuid, uuid, numeric, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_media_clip(uuid) TO authenticated;
