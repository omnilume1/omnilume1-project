-- Phase 02 (hostel roadmap): product event ledger, ref attribution and the
-- night boundary.
--
-- public.product_events holds only an event name, an optional room, an
-- optional ref tag and a tiny validated meta object. No user id, IP, message
-- text or title is ever stored (roadmap §0.7). RLS is on with no policies and
-- every table privilege is revoked: clients can neither read nor write it
-- directly. The only client write path is log_product_event, which validates
-- every input and checks room membership.
--
-- room_tick is written only by the server-side heartbeat (phase 03), never by
-- a client call, so it is not accepted here.
--
-- public.night_date(ts): a night runs 06:00 to 06:00 Asia/Kolkata (§0.10).

CREATE TABLE public.product_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event text NOT NULL CHECK (event IN (
    'room_created', 'invite_created', 'share_completed', 'call_in_shared',
    'join_viewed', 'joined', 'guest_joined', 'spot_joined', 'drop_in',
    'knock_sent', 'timer_started', 'timer_completed', 'room_tick',
    'recap_shared', 'report_created'
  )),
  room_id uuid NULL,
  ref text NULL CHECK (ref ~ '^[a-z0-9-]{1,40}$'),
  meta jsonb NULL CHECK (pg_column_size(meta) <= 512),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.product_events IS
  'Anonymous product metrics. No user ids, IPs, message text or titles. Written only through log_product_event / room_heartbeat.';

CREATE INDEX product_events_event_created_at_idx ON public.product_events (event, created_at);
CREATE INDEX product_events_room_created_at_idx ON public.product_events (room_id, created_at);

ALTER TABLE public.product_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.product_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.product_events_id_seq FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.log_product_event(
  p_event text,
  p_room_id uuid DEFAULT NULL,
  p_ref text DEFAULT NULL,
  p_meta jsonb DEFAULT NULL
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  meta_key text;
  meta_value jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in to log events.' USING ERRCODE = '42501';
  END IF;

  IF p_event IS NULL OR p_event NOT IN (
    'room_created', 'invite_created', 'share_completed', 'call_in_shared',
    'join_viewed', 'joined', 'guest_joined', 'spot_joined', 'drop_in',
    'knock_sent', 'timer_started', 'timer_completed',
    'recap_shared', 'report_created'
  ) THEN
    RAISE EXCEPTION 'Unknown event.' USING ERRCODE = '22023';
  END IF;

  IF p_ref IS NOT NULL AND p_ref !~ '^[a-z0-9-]{1,40}$' THEN
    RAISE EXCEPTION 'Invalid ref.' USING ERRCODE = '22023';
  END IF;

  IF p_meta IS NOT NULL THEN
    IF jsonb_typeof(p_meta) <> 'object' OR pg_column_size(p_meta) > 512 THEN
      RAISE EXCEPTION 'Invalid meta.' USING ERRCODE = '22023';
    END IF;
    FOR meta_key, meta_value IN SELECT key, value FROM jsonb_each(p_meta) LOOP
      IF meta_key NOT IN ('spot', 'people', 'minutes', 'template', 'from', 'variant') THEN
        RAISE EXCEPTION 'Invalid meta key.' USING ERRCODE = '22023';
      END IF;
      IF jsonb_typeof(meta_value) = 'string' THEN
        IF length(meta_value #>> '{}') > 40 THEN
          RAISE EXCEPTION 'Invalid meta value.' USING ERRCODE = '22023';
        END IF;
      ELSIF jsonb_typeof(meta_value) = 'number' THEN
        IF (meta_value #>> '{}')::numeric NOT BETWEEN -100000 AND 100000 THEN
          RAISE EXCEPTION 'Invalid meta value.' USING ERRCODE = '22023';
        END IF;
      ELSIF jsonb_typeof(meta_value) <> 'boolean' THEN
        RAISE EXCEPTION 'Invalid meta value.' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;

  IF p_room_id IS NOT NULL AND NOT public.is_approved_room_member(p_room_id, auth.uid()) THEN
    RAISE EXCEPTION 'Not a member of this room.' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.product_events (event, room_id, ref, meta)
  VALUES (p_event, p_room_id, p_ref, p_meta);
END;
$function$;

REVOKE ALL ON FUNCTION public.log_product_event(text, uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_product_event(text, uuid, text, jsonb) TO authenticated;

-- Asia/Kolkata has no DST, so the conversion never changes for a given
-- instant; IMMUTABLE lets later phases index on it.
CREATE FUNCTION public.night_date(ts timestamptz)
 RETURNS date
 LANGUAGE sql
 IMMUTABLE
 PARALLEL SAFE
 SET search_path TO ''
AS $function$
  SELECT ((ts AT TIME ZONE 'Asia/Kolkata') - interval '6 hours')::date;
$function$;

REVOKE ALL ON FUNCTION public.night_date(timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.night_date(timestamptz) TO authenticated, service_role;
