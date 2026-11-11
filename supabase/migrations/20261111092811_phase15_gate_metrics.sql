-- Phase 15 (hostel roadmap): gate board metrics.
--
-- public.get_gate_metrics(p_since date) reads public.product_events for site
-- owners only (public.is_site_owner) and returns one jsonb object of counts
-- and ratios. It never returns a room id, and the table holds no user ids,
-- IPs, message text or titles (roadmap §0.7). The only strings returned are
-- `ref` tags, which the table's CHECK limits to ^[a-z0-9-]{1,40}$.
--
-- Window: every event whose night is on or after p_since. A night runs 06:00
-- to 06:00 Asia/Kolkata (public.night_date, §0.10).
--
-- Definitions (one definition each, used by every later phase):
--   activated night  = a (room, night) with 3 or more room_tick rows (§0.10).
--   activated group  = a room with at least one activated night.
--   hostel-proof     = an activated night with a drop_in or spot_joined in the
--                      same room on the same night.
--   G-D7             = rooms whose first activated night is followed by
--                      another within 7 days / rooms with an activated night.
--   G-W4             = rooms with an activated night 21 to 27 days after their
--                      first / rooms whose first activated night is 28 or more
--                      days old. Only rooms in the divisor are counted on top.
--   median minutes   = percentile_cont(0.5) of (ticks x 10) over activated
--                      nights (ticks are 10 minutes apart).
--   card shares      = recap_shared / activated nights.
--   spots per night  = the average, over activated nights, of how many of
--                      desk, screen, speaker and bed had anyone on any tick.
--   funnel by ref    = share_completed, join_viewed, joined, guest_joined and
--                      room_created grouped by coalesce(ref, 'none'); the 50
--                      busiest refs.
--   A/B              = room_created with ref lp-a vs lp-b, plus the joins
--                      (joined + guest_joined) in the rooms of each bucket.
--   K inputs:
--     i = (share_completed + call_in_shared) / activated nights
--     o = join_viewed / (share_completed + call_in_shared)
--     j = (joined + guest_joined) / join_viewed
--     h = room_created with ref invite, callin or visitor
--         / (joined + guest_joined). This approximates the roadmap's "created
--         a room within 14 days of joining": events carry no user id, so a
--         join cannot be paired with a later room.
--     r = recap_shared / activated nights
--     d = activated nights with a drop_in / activated nights
--
-- Every divisor goes through NULLIF: no data gives null, not 0. Events that
-- no shipped phase writes yet (spot_joined, drop_in, call_in_shared,
-- recap_shared) simply count 0.

CREATE FUNCTION public.get_gate_metrics(p_since date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_start timestamptz;
  v_tonight date := public.night_date(now());
  v_result jsonb;
BEGIN
  IF NOT public.is_site_owner(auth.uid()) THEN
    RAISE EXCEPTION 'Only a site owner can read gate metrics.' USING ERRCODE = '42501';
  END IF;

  IF p_since IS NULL THEN
    RAISE EXCEPTION 'A start date is required.' USING ERRCODE = '22023';
  END IF;

  -- Same rows as night_date(created_at) >= p_since: a night starts at 06:00
  -- Asia/Kolkata. Written as a range on created_at so its indexes are usable.
  v_start := (p_since::timestamp + interval '6 hours') AT TIME ZONE 'Asia/Kolkata';

  WITH ev AS (
    SELECT e.event, e.room_id, e.ref, e.meta, public.night_date(e.created_at) AS night
    FROM public.product_events e
    WHERE e.created_at >= v_start
  ),
  tick_night AS (
    SELECT t.room_id, t.night, count(*) AS ticks
    FROM ev t
    WHERE t.event = 'room_tick' AND t.room_id IS NOT NULL
    GROUP BY t.room_id, t.night
  ),
  -- Spots with anyone on them on any tick of the night. The CASE guards the
  -- cast: only numbers are compared.
  spot_night AS (
    SELECT t.room_id, t.night, count(DISTINCT s.key) AS spots
    FROM ev t
    CROSS JOIN LATERAL jsonb_each(
      CASE WHEN jsonb_typeof(t.meta) = 'object' THEN t.meta ELSE '{}'::jsonb END
    ) AS s(key, value)
    WHERE t.event = 'room_tick'
      AND t.room_id IS NOT NULL
      AND s.key IN ('desk', 'screen', 'speaker', 'bed')
      AND CASE WHEN jsonb_typeof(s.value) = 'number' THEN (s.value #>> '{}')::numeric > 0 ELSE false END
    GROUP BY t.room_id, t.night
  ),
  activated AS (
    SELECT n.room_id, n.night, n.ticks,
           COALESCE(s.spots, 0) AS spots,
           EXISTS (
             SELECT 1 FROM ev p
             WHERE p.room_id = n.room_id AND p.night = n.night
               AND p.event IN ('drop_in', 'spot_joined')
           ) AS hostel_proof,
           EXISTS (
             SELECT 1 FROM ev p
             WHERE p.room_id = n.room_id AND p.night = n.night
               AND p.event = 'drop_in'
           ) AS has_drop_in
    FROM tick_night n
    LEFT JOIN spot_night s ON s.room_id = n.room_id AND s.night = n.night
    WHERE n.ticks >= 3
  ),
  night_totals AS (
    SELECT count(*) AS activated_nights,
           count(*) FILTER (WHERE a.hostel_proof) AS hostel_proof_nights,
           count(*) FILTER (WHERE a.has_drop_in) AS drop_in_nights,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY a.ticks * 10) AS median_minutes,
           avg(a.spots) AS spots_per_night
    FROM activated a
  ),
  room_first AS (
    SELECT a.room_id, min(a.night) AS first_night
    FROM activated a
    GROUP BY a.room_id
  ),
  room_return AS (
    SELECT f.first_night,
           EXISTS (
             SELECT 1 FROM activated a
             WHERE a.room_id = f.room_id
               AND a.night > f.first_night AND a.night <= f.first_night + 7
           ) AS back_d7,
           EXISTS (
             SELECT 1 FROM activated a
             WHERE a.room_id = f.room_id
               AND a.night BETWEEN f.first_night + 21 AND f.first_night + 27
           ) AS back_w4
    FROM room_first f
  ),
  group_totals AS (
    SELECT count(*) AS activated_groups,
           count(*) FILTER (WHERE r.back_d7) AS d7_groups,
           count(*) FILTER (WHERE r.first_night <= v_tonight - 28) AS w4_eligible,
           count(*) FILTER (WHERE r.first_night <= v_tonight - 28 AND r.back_w4) AS w4_groups
    FROM room_return r
  ),
  event_totals AS (
    SELECT count(*) FILTER (WHERE e.event = 'share_completed') AS share_completed,
           count(*) FILTER (WHERE e.event = 'call_in_shared') AS call_in_shared,
           count(*) FILTER (WHERE e.event = 'join_viewed') AS join_viewed,
           count(*) FILTER (WHERE e.event = 'joined') AS joined,
           count(*) FILTER (WHERE e.event = 'guest_joined') AS guest_joined,
           count(*) FILTER (WHERE e.event = 'recap_shared') AS recap_shared,
           count(*) FILTER (
             WHERE e.event = 'room_created' AND e.ref IN ('invite', 'callin', 'visitor')
           ) AS invited_rooms,
           count(*) FILTER (WHERE e.event = 'room_created' AND e.ref = 'lp-a') AS lp_a_rooms,
           count(*) FILTER (WHERE e.event = 'room_created' AND e.ref = 'lp-b') AS lp_b_rooms
    FROM ev e
  ),
  ab_room AS (
    SELECT DISTINCT e.ref, e.room_id
    FROM ev e
    WHERE e.event = 'room_created' AND e.ref IN ('lp-a', 'lp-b') AND e.room_id IS NOT NULL
  ),
  ab_joins AS (
    SELECT count(*) FILTER (WHERE b.ref = 'lp-a') AS lp_a_joins,
           count(*) FILTER (WHERE b.ref = 'lp-b') AS lp_b_joins
    FROM ev e
    JOIN ab_room b ON b.room_id = e.room_id
    WHERE e.event IN ('joined', 'guest_joined')
  ),
  funnel AS (
    SELECT COALESCE(e.ref, 'none') AS ref_tag,
           count(*) FILTER (WHERE e.event = 'share_completed') AS share_completed,
           count(*) FILTER (WHERE e.event = 'join_viewed') AS join_viewed,
           count(*) FILTER (WHERE e.event = 'joined') AS joined,
           count(*) FILTER (WHERE e.event = 'guest_joined') AS guest_joined,
           count(*) FILTER (WHERE e.event = 'room_created') AS room_created,
           count(*) AS total
    FROM ev e
    WHERE e.event IN ('share_completed', 'join_viewed', 'joined', 'guest_joined', 'room_created')
    GROUP BY COALESCE(e.ref, 'none')
    ORDER BY count(*) DESC, COALESCE(e.ref, 'none')
    LIMIT 50
  )
  SELECT jsonb_build_object(
    'since', p_since,
    'activated_nights', n.activated_nights,
    'activated_groups', g.activated_groups,
    'hostel_proof_nights', n.hostel_proof_nights,
    'hostel_proof_rate', round(n.hostel_proof_nights::numeric / NULLIF(n.activated_nights, 0), 4),
    'g_d7', round(g.d7_groups::numeric / NULLIF(g.activated_groups, 0), 4),
    'g_w4', round(g.w4_groups::numeric / NULLIF(g.w4_eligible, 0), 4),
    'g_w4_eligible', g.w4_eligible,
    'median_minutes', n.median_minutes,
    'card_shares_per_night', round(t.recap_shared::numeric / NULLIF(n.activated_nights, 0), 4),
    'spots_per_night', round(n.spots_per_night, 4),
    'funnel', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'ref', f.ref_tag,
        'share_completed', f.share_completed,
        'join_viewed', f.join_viewed,
        'joined', f.joined,
        'guest_joined', f.guest_joined,
        'room_created', f.room_created
      ) ORDER BY f.total DESC, f.ref_tag)
      FROM funnel f
    ), '[]'::jsonb),
    'ab', jsonb_build_object(
      'lp_a', jsonb_build_object('rooms', t.lp_a_rooms, 'joins', j.lp_a_joins),
      'lp_b', jsonb_build_object('rooms', t.lp_b_rooms, 'joins', j.lp_b_joins)
    ),
    'k', jsonb_build_object(
      'i', round((t.share_completed + t.call_in_shared)::numeric / NULLIF(n.activated_nights, 0), 4),
      'o', round(t.join_viewed::numeric / NULLIF(t.share_completed + t.call_in_shared, 0), 4),
      'j', round((t.joined + t.guest_joined)::numeric / NULLIF(t.join_viewed, 0), 4),
      'h', round(t.invited_rooms::numeric / NULLIF(t.joined + t.guest_joined, 0), 4),
      'r', round(t.recap_shared::numeric / NULLIF(n.activated_nights, 0), 4),
      'd', round(n.drop_in_nights::numeric / NULLIF(n.activated_nights, 0), 4)
    )
  )
  INTO v_result
  FROM night_totals n
  CROSS JOIN group_totals g
  CROSS JOIN event_totals t
  CROSS JOIN ab_joins j;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_gate_metrics(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_gate_metrics(date) TO authenticated;
