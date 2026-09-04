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
