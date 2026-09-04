-- Add the explicit first-run identity completion marker used by the auth gate.
-- This is additive and does not delete or rewrite application data.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS profile_completed boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.profile_completed IS
  'Whether the account has completed the current first-run identity gate; full profile fields are added by the Profiles action.';
