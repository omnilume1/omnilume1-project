-- Profile colour (section identity, 2026-11-08). With the "Section colours" app theme, a
-- profile page takes its owner's colour. One of six presets; NULL means the default (coral).
-- Owners already update their own row (profiles_update_own), so no new policy is needed.

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS profile_color text;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_profile_color_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_profile_color_check
  CHECK (profile_color IS NULL OR profile_color IN ('coral', 'amber', 'mint', 'ocean', 'orchid', 'violet'));

-- Visitors read profiles through public_profiles. CREATE OR REPLACE keeps the view's grants
-- and its owner-rights behaviour (intentional, see the security notes); it only appends the column.
CREATE OR REPLACE VIEW public.public_profiles AS
SELECT p.id, p.username, p.display_name, p.avatar_url, p.bio, p.is_private, p.created_at, p.updated_at, p.profile_color
FROM public.profiles p
WHERE public.can_view_profile(p.id);
