-- Action 04 follow-up: explicitly remove pre-existing Supabase role grants.
-- RLS remains the row-level boundary; these grants provide least privilege at
-- the table/function boundary as well. No application data is changed.

REVOKE ALL PRIVILEGES ON TABLE public.profiles, public.follows, public.friend_requests, public.friendships, public.posts FROM anon;
REVOKE REFERENCES, TRIGGER, TRUNCATE, DELETE ON TABLE public.profiles FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE ON TABLE public.follows, public.friend_requests, public.friendships FROM authenticated;
REVOKE REFERENCES, TRIGGER, TRUNCATE ON TABLE public.posts FROM authenticated;

GRANT SELECT, INSERT, UPDATE ON TABLE public.profiles TO authenticated;
GRANT SELECT ON TABLE public.follows, public.friend_requests, public.friendships TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.posts TO authenticated;

REVOKE ALL ON TABLE public.public_profiles FROM anon;
REVOKE ALL ON TABLE public.public_profiles FROM authenticated;
GRANT SELECT ON TABLE public.public_profiles TO authenticated;

REVOKE ALL ON FUNCTION public.can_view_profile(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_view_post(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_current_friend(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_accepted_follower(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.request_follow(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.respond_to_follow_request(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_follow_request(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.unfollow_user(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.remove_follower(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.request_friend(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.respond_to_friend_request(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_friend_request(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.remove_friend(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.prepare_account_deletion(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_profile_followers(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_profile_following(uuid) FROM PUBLIC, anon;
