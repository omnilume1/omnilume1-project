-- Action 04 follow-up: remove non-data privileges inherited by the existing
-- Supabase default grants on the public profile projection and posts.

REVOKE REFERENCES, TRIGGER, TRUNCATE ON TABLE public.posts FROM authenticated;
REVOKE ALL ON TABLE public.public_profiles FROM authenticated;
GRANT SELECT ON TABLE public.public_profiles TO authenticated;
