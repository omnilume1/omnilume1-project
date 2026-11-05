export const DEFAULT_AUTH_REDIRECT = '/home';
export const PROFILE_SETUP_PATH = '/profile/setup';

const INTERNAL_REDIRECT_ORIGIN = 'https://omnilume.internal';

export type ProfileCompletionFlags = {
  profile_completed: boolean | null | undefined;
  profile_details_completed: boolean | null | undefined;
};

/**
 * Keep every auth entry point aligned with the complete profile gate.
 * An identity marker alone is not sufficient to enter authenticated areas.
 */
export function isProfileComplete(profile: ProfileCompletionFlags | null | undefined) {
  return profile?.profile_completed === true
    && profile.profile_details_completed === true;
}

/**
 * Accept only same-origin relative paths for post-auth navigation.
 * Backslashes are rejected because browsers may reinterpret them as URL separators.
 */
export function getSafeRedirectPath(
  candidate: string | null | undefined,
  fallback = DEFAULT_AUTH_REDIRECT,
) {
  if (
    !candidate ||
    candidate.length > 2048 ||
    !candidate.startsWith('/') ||
    candidate.startsWith('//') ||
    candidate.includes('\\') ||
    candidate.includes('\u0000')
  ) {
    return fallback;
  }

  try {
    const parsed = new URL(candidate, INTERNAL_REDIRECT_ORIGIN);
    if (parsed.origin !== INTERNAL_REDIRECT_ORIGIN) return fallback;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return fallback;
  }
}

export function getLoginPath(nextPath: string | null | undefined) {
  const safeNextPath = getSafeRedirectPath(nextPath);
  return `/login?next=${encodeURIComponent(safeNextPath)}`;
}

export function isAuthRequiredPath(pathname: string) {
  return (
    pathname === '/home' ||
    pathname === '/messages' ||
    pathname === '/create-room' ||
    pathname === '/room' ||
    pathname.startsWith('/room/') ||
    pathname === '/room-settings' ||
    pathname === '/profile' ||
    pathname.startsWith('/profile/') ||
    pathname === '/settings' ||
    pathname === '/admin' ||
    pathname.startsWith('/admin/') ||
    pathname === PROFILE_SETUP_PATH
  );
}
