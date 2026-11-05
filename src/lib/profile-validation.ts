export const PROFILE_GENDERS = [
  'female',
  'male',
  'non_binary',
  'prefer_not_to_say',
  'other',
] as const;

export type ProfileGender = (typeof PROFILE_GENDERS)[number];
export type PostVisibility = 'profile' | 'public' | 'followers';

export interface ProfileInput {
  displayName: string;
  username: string;
  dateOfBirth: string;
  gender: ProfileGender;
  avatarUrl?: string | null;
  bio?: string | null;
  isPrivate: boolean;
}

export interface NormalizedProfileInput {
  display_name: string;
  username: string;
  date_of_birth: string;
  gender: ProfileGender;
  avatar_url: string | null;
  bio: string | null;
  is_private: boolean;
}

// Owner decision (2026-11-05): OmniLume requires a minimum age of 13. The
// database enforces the same rule (profiles_enforce_minimum_age trigger,
// migration 20261105120000), so this check is for a clear form message.
export const MINIMUM_AGE_YEARS = 13;

// The latest date of birth (YYYY-MM-DD, UTC) that is at least
// MINIMUM_AGE_YEARS old on `now`. A 29 February birthday turns 13 on 1 March
// in non-leap years, matching Postgres date - interval arithmetic.
export function latestAllowedDateOfBirth(now: Date = new Date()) {
  const year = now.getUTCFullYear() - MINIMUM_AGE_YEARS;
  const month = now.getUTCMonth();
  const day = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const latest = new Date(Date.UTC(year, month, Math.min(day, daysInMonth)));
  return latest.toISOString().slice(0, 10);
}

export function normalizeUsername(value: string) {
  return value.trim().toLowerCase();
}

function isValidDateOnly(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isValidAvatarUrl(value: string) {
  return value.startsWith('/') || value.startsWith('https://');
}

export function validateProfileInput(input: ProfileInput):
  | { success: true; data: NormalizedProfileInput }
  | { success: false; error: string } {
  const displayName = input.displayName.trim();
  const username = normalizeUsername(input.username);
  const dateOfBirth = input.dateOfBirth.trim();
  const bio = input.bio?.trim() || null;
  const avatarUrl = input.avatarUrl?.trim() || null;

  if (displayName.length < 1 || displayName.length > 120) {
    return { success: false, error: 'Name must be between 1 and 120 characters.' };
  }
  if (!/^[a-z0-9][a-z0-9_.]{2,29}$/.test(username)) {
    return { success: false, error: 'Username must be 3-30 lowercase letters, numbers, underscores, or dots.' };
  }
  if (!isValidDateOnly(dateOfBirth) || dateOfBirth > new Date().toISOString().slice(0, 10)) {
    return { success: false, error: 'Enter a valid date of birth that is not in the future.' };
  }
  if (dateOfBirth > latestAllowedDateOfBirth()) {
    return { success: false, error: `You must be at least ${MINIMUM_AGE_YEARS} years old to use OmniLume.` };
  }
  if (!PROFILE_GENDERS.includes(input.gender)) {
    return { success: false, error: 'Select a valid gender option.' };
  }
  if (bio && bio.length > 500) {
    return { success: false, error: 'Bio must be 500 characters or fewer.' };
  }
  if (avatarUrl && (avatarUrl.length > 2048 || !isValidAvatarUrl(avatarUrl))) {
    return { success: false, error: 'Profile picture must use a secure URL or application path.' };
  }

  return {
    success: true,
    data: {
      display_name: displayName,
      username,
      date_of_birth: dateOfBirth,
      gender: input.gender,
      avatar_url: avatarUrl,
      bio,
      is_private: input.isPrivate,
    },
  };
}

export function assertUuid(value: string, label: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
}

export function assertPostVisibility(value: string): asserts value is PostVisibility {
  if (value !== 'profile' && value !== 'public' && value !== 'followers') {
    throw new Error('Invalid post visibility.');
  }
}
