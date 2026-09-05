-- ============================================================
-- OmniLume Action 04 — friendship acceptance fix (010)
--
-- Live-database drift: the deployed respond_to_friend_request marks
-- friend requests accepted and creates the mutual follow edges, but
-- silently skips the friendships row (verified 2026-09-05: accepted
-- request with both follow edges present, zero friendships rows,
-- UI shows "Friends 0").
--
-- 1. Re-assert the canonical function from
--    007_profiles_social_foundation.sql (no exception swallowing).
-- 2. Backfill friendships for requests that were already accepted.
-- 3. Re-grant execution to match 008/009 hardening.
-- ============================================================

CREATE OR REPLACE FUNCTION public.respond_to_friend_request(p_request_id uuid, p_decision text)
RETURNS public.friend_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  request_row public.friend_requests;
  low_user uuid;
  high_user uuid;
BEGIN
  IF auth.uid() IS NULL OR p_decision NOT IN ('accepted', 'rejected') THEN
    RAISE EXCEPTION 'Invalid friend decision.';
  END IF;

  SELECT * INTO request_row FROM public.friend_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR request_row.recipient_id <> auth.uid() OR request_row.status <> 'pending' THEN
    RAISE EXCEPTION 'Friend request is not available.';
  END IF;

  UPDATE public.friend_requests
  SET status = p_decision, responded_at = now(), responded_by = auth.uid()
  WHERE id = p_request_id
  RETURNING * INTO request_row;

  IF p_decision = 'accepted' THEN
    low_user := LEAST(request_row.requester_id, request_row.recipient_id);
    high_user := GREATEST(request_row.requester_id, request_row.recipient_id);
    INSERT INTO public.friendships (user_one, user_two)
    VALUES (low_user, high_user)
    ON CONFLICT (user_one, user_two) DO NOTHING;

    INSERT INTO public.follows (follower_id, following_id, status, responded_at, accepted_at)
    VALUES
      (request_row.requester_id, request_row.recipient_id, 'accepted', now(), now()),
      (request_row.recipient_id, request_row.requester_id, 'accepted', now(), now())
    ON CONFLICT (follower_id, following_id) DO UPDATE
      SET status = 'accepted', responded_at = now(), accepted_at = COALESCE(public.follows.accepted_at, now());
  END IF;
  RETURN request_row;
END;
$$;

-- Backfill: any accepted request missing its friendship row.
INSERT INTO public.friendships (user_one, user_two)
SELECT LEAST(requester_id, recipient_id), GREATEST(requester_id, recipient_id)
FROM public.friend_requests
WHERE status = 'accepted'
ON CONFLICT (user_one, user_two) DO NOTHING;

REVOKE ALL ON FUNCTION public.respond_to_friend_request(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.respond_to_friend_request(uuid, text) TO authenticated, service_role;
