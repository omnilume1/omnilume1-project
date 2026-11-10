-- Phase 05 (hostel roadmap): public invite card.
--
-- get_public_invite_card(p_token, p_ref, p_log): what a link preview and the
-- /join/<token> page may show anyone holding a valid invite link, signed in
-- or not: the room name, nameplate, member count, the live spot counts and
-- door (zeros and 'open' unless a heartbeat arrived in the last 2 minutes),
-- whether the link is a visitor pass and until when, and when a running
-- focus timer ends. It never returns ids, user names, avatars, the timer
-- subject or a media title.
--
-- Only valid (unrevoked, unexpired, unexhausted) invites to a room that still
-- exists return a row; anything else returns no row.
--
-- Rate limit: 60 card reads per token per 10-minute bucket, counted in
-- invite_card_hits under a SHA-256 of the token (never the token itself).
-- Only valid tokens are counted, so junk tokens write nothing. Buckets older
-- than a day are deleted as it goes. The 61st read raises SQLSTATE PT429,
-- which PostgREST answers with HTTP 429.
--
-- join_viewed is logged only when p_log is true (the page's after-mount
-- browser call, roadmap §0.11), never for metadata or the OG image.

CREATE TABLE public.invite_card_hits (
  token_hash bytea NOT NULL,
  bucket timestamptz NOT NULL,
  hits integer NOT NULL DEFAULT 0,
  PRIMARY KEY (token_hash, bucket)
);

COMMENT ON TABLE public.invite_card_hits IS
  'Per-token rate-limit buckets for get_public_invite_card. SHA-256 of the token only. Written only by that function.';

CREATE INDEX invite_card_hits_bucket_idx ON public.invite_card_hits (bucket);

ALTER TABLE public.invite_card_hits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.invite_card_hits FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.get_public_invite_card(
  p_token text,
  p_ref text DEFAULT NULL,
  p_log boolean DEFAULT false
)
 RETURNS TABLE(
   room_name text,
   nameplate text,
   member_count integer,
   people integer,
   desk integer,
   screen integer,
   speaker integer,
   bed integer,
   door text,
   is_visitor_pass boolean,
   visitor_until timestamptz,
   focus_ends_at timestamptz
 )
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_token text := lower(btrim(COALESCE(p_token, '')));
  v_invite public.room_invites%ROWTYPE;
  v_room public.rooms%ROWTYPE;
  v_status public.room_live_status%ROWTYPE;
  v_hits integer;
  v_timer jsonb;
  v_end_ms numeric;
  v_focus timestamptz;
  v_members integer;
BEGIN
  IF v_token !~ '^[a-f0-9]{48}$' THEN
    RETURN;
  END IF;

  SELECT i.* INTO v_invite
  FROM public.room_invites i
  WHERE i.token = v_token
    AND i.revoked_at IS NULL
    AND (i.expires_at IS NULL OR i.expires_at > now())
    AND (i.max_uses IS NULL OR i.uses_count < i.max_uses);
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT r.* INTO v_room FROM public.rooms r WHERE r.id = v_invite.room_id;
  IF NOT FOUND OR public.room_lifecycle_state(v_room.id) IN ('destroyed', 'recovery-window') THEN
    RETURN;
  END IF;

  DELETE FROM public.invite_card_hits WHERE bucket < now() - interval '1 day';

  INSERT INTO public.invite_card_hits AS h (token_hash, bucket, hits)
  VALUES (
    sha256(convert_to(v_token, 'UTF8')),
    date_bin('10 minutes', now(), timestamptz '2000-01-01 00:00:00+00'),
    1
  )
  ON CONFLICT (token_hash, bucket) DO UPDATE SET hits = h.hits + 1
  RETURNING h.hits INTO v_hits;

  IF v_hits > 60 THEN
    RAISE EXCEPTION 'Too many looks at this link. Try again in a few minutes.' USING ERRCODE = 'PT429';
  END IF;

  SELECT count(*)::integer INTO v_members
  FROM public.room_members m
  WHERE m.room_id = v_room.id
    AND public.room_user_role(m.room_id, m.user_id) IS NOT NULL;

  SELECT s.* INTO v_status
  FROM public.room_live_status s
  WHERE s.room_id = v_room.id
    AND s.updated_at > now() - interval '2 minutes';

  -- The timer snapshot is {eventType, payload}; endTime is epoch ms. Only a
  -- running timer with a sane end in the next day counts. The subject is
  -- never read.
  SELECT s.payload INTO v_timer
  FROM public.room_realtime_snapshots s
  WHERE s.room_id = v_room.id AND s.snapshot_type = 'timer'
  ORDER BY s.updated_at DESC
  LIMIT 1;

  IF v_timer ->> 'eventType' = 'timer_start'
     AND jsonb_typeof(v_timer -> 'payload' -> 'endTime') = 'number' THEN
    v_end_ms := (v_timer -> 'payload' ->> 'endTime')::numeric;
    IF v_end_ms > extract(epoch FROM now()) * 1000
       AND v_end_ms < extract(epoch FROM now() + interval '1 day') * 1000 THEN
      v_focus := to_timestamp(v_end_ms / 1000);
    END IF;
  END IF;

  IF p_log THEN
    INSERT INTO public.product_events (event, room_id, ref)
    VALUES (
      'join_viewed',
      v_room.id,
      CASE WHEN p_ref ~ '^[a-z0-9-]{1,40}$' THEN p_ref END
    );
  END IF;

  RETURN QUERY SELECT
    v_room.name,
    v_room.nameplate,
    v_members,
    COALESCE(v_status.people, 0),
    COALESCE(v_status.desk, 0),
    COALESCE(v_status.screen, 0),
    COALESCE(v_status.speaker, 0),
    COALESCE(v_status.bed, 0),
    COALESCE(v_status.door, 'open'),
    v_invite.guest_lifetime_minutes IS NOT NULL,
    CASE
      WHEN v_invite.guest_lifetime_minutes IS NULL THEN NULL
      ELSE now() + make_interval(mins => v_invite.guest_lifetime_minutes)
    END,
    v_focus;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_public_invite_card(text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_invite_card(text, text, boolean) TO anon, authenticated;
