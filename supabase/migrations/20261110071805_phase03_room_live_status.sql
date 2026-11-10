-- Phase 03 (hostel roadmap): live room status.
--
-- public.room_live_status keeps one row per room: how many people are in the
-- room right now, how many sit at each spot (desk, screen, speaker, bed) and
-- the room's door (open, knock, dnd). It holds counts only: no user ids,
-- names or titles (roadmap §0.7). RLS is on with no policies and every table
-- privilege is revoked; clients go through the two functions below.
--
-- room_heartbeat: called by one browser per room (the lowest user id on the
-- public presence channel, so ghosts are never counted, §0.9) every 60 s.
-- It clamps every value, upserts the row and records a room_tick product
-- event at most once per 10 minutes while 2+ people are in. An activated
-- night is 3+ ticks (§0.10).
--
-- get_my_rooms_live: the live row for every room the caller is an approved
-- member of; `fresh` means a heartbeat arrived in the last 2 minutes.

CREATE TABLE public.room_live_status (
  room_id uuid PRIMARY KEY REFERENCES public.rooms (id) ON DELETE CASCADE,
  people integer NOT NULL DEFAULT 0 CHECK (people BETWEEN 0 AND 50),
  desk integer NOT NULL DEFAULT 0 CHECK (desk BETWEEN 0 AND 50),
  screen integer NOT NULL DEFAULT 0 CHECK (screen BETWEEN 0 AND 50),
  speaker integer NOT NULL DEFAULT 0 CHECK (speaker BETWEEN 0 AND 50),
  bed integer NOT NULL DEFAULT 0 CHECK (bed BETWEEN 0 AND 50),
  door text NOT NULL DEFAULT 'open' CHECK (door IN ('open', 'knock', 'dnd')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.room_live_status IS
  'Live counts per room from the public presence channel. Counts only, no user ids. Written only through room_heartbeat.';

ALTER TABLE public.room_live_status ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.room_live_status FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.room_heartbeat(
  p_room_id uuid,
  p_people integer,
  p_spots jsonb,
  p_door text
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_people integer;
  v_desk integer;
  v_screen integer;
  v_speaker integer;
  v_bed integer;
  v_door text;
  v_spots jsonb := CASE WHEN jsonb_typeof(p_spots) = 'object' THEN p_spots ELSE '{}'::jsonb END;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in first.' USING ERRCODE = '42501';
  END IF;

  IF p_room_id IS NULL OR NOT public.is_approved_room_member(p_room_id, auth.uid()) THEN
    RAISE EXCEPTION 'Not a member of this room.' USING ERRCODE = '42501';
  END IF;

  -- Clamp everything to 0..50; anything that isn't a number counts as 0.
  v_people := LEAST(GREATEST(COALESCE(p_people, 0), 0), 50);
  v_desk := CASE WHEN jsonb_typeof(v_spots -> 'desk') = 'number' THEN LEAST(GREATEST(floor((v_spots ->> 'desk')::numeric), 0), 50)::integer ELSE 0 END;
  v_screen := CASE WHEN jsonb_typeof(v_spots -> 'screen') = 'number' THEN LEAST(GREATEST(floor((v_spots ->> 'screen')::numeric), 0), 50)::integer ELSE 0 END;
  v_speaker := CASE WHEN jsonb_typeof(v_spots -> 'speaker') = 'number' THEN LEAST(GREATEST(floor((v_spots ->> 'speaker')::numeric), 0), 50)::integer ELSE 0 END;
  v_bed := CASE WHEN jsonb_typeof(v_spots -> 'bed') = 'number' THEN LEAST(GREATEST(floor((v_spots ->> 'bed')::numeric), 0), 50)::integer ELSE 0 END;
  v_door := CASE WHEN p_door IN ('open', 'knock', 'dnd') THEN p_door ELSE 'open' END;

  -- The upsert locks the room's row, so concurrent heartbeats run one at a
  -- time and the tick check below sees the other's tick.
  INSERT INTO public.room_live_status AS s (room_id, people, desk, screen, speaker, bed, door, updated_at)
  VALUES (p_room_id, v_people, v_desk, v_screen, v_speaker, v_bed, v_door, now())
  ON CONFLICT (room_id) DO UPDATE
  SET people = EXCLUDED.people,
      desk = EXCLUDED.desk,
      screen = EXCLUDED.screen,
      speaker = EXCLUDED.speaker,
      bed = EXCLUDED.bed,
      door = EXCLUDED.door,
      updated_at = now();

  IF v_people >= 2 AND NOT EXISTS (
    SELECT 1
    FROM public.product_events e
    WHERE e.room_id = p_room_id
      AND e.event = 'room_tick'
      AND e.created_at > now() - interval '10 minutes'
  ) THEN
    INSERT INTO public.product_events (event, room_id, meta)
    VALUES ('room_tick', p_room_id, jsonb_build_object(
      'people', v_people, 'desk', v_desk, 'screen', v_screen, 'speaker', v_speaker, 'bed', v_bed
    ));
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.room_heartbeat(uuid, integer, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.room_heartbeat(uuid, integer, jsonb, text) TO authenticated;

CREATE FUNCTION public.get_my_rooms_live()
 RETURNS TABLE(room_id uuid, people integer, desk integer, screen integer, speaker integer, bed integer, door text, fresh boolean)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT s.room_id, s.people, s.desk, s.screen, s.speaker, s.bed, s.door,
         s.updated_at > now() - interval '2 minutes'
  FROM public.room_live_status s
  JOIN public.room_members m ON m.room_id = s.room_id AND m.user_id = auth.uid()
  WHERE auth.uid() IS NOT NULL
    AND public.is_approved_room_member(s.room_id, auth.uid());
$function$;

REVOKE ALL ON FUNCTION public.get_my_rooms_live() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_rooms_live() TO authenticated;
