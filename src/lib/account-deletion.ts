export const ACCOUNT_DELETION_CONFIRMATION = 'DELETE MY ACCOUNT';

// Owner decision 2026-11-05 (Option A): deleting an account requires a recent
// sign-in, not only a live session. Google users have no password to re-enter,
// and a borrowed browser or stolen session must not be able to destroy an
// account permanently.
export const ACCOUNT_DELETION_REAUTH_WINDOW_SECONDS = 10 * 60;

// Tolerated clock difference between this server and Supabase Auth.
const CLOCK_SKEW_SECONDS = 60;

/**
 * When this session last proved the user's identity, in epoch seconds, read
 * from the verified access token's `amr` claim. The amr timestamp is fixed at
 * sign-in and is not advanced by token refresh (unlike `iat`), so it measures
 * the sign-in itself. Returns null when no timestamp is available.
 */
export function sessionAuthenticatedAt(amr: unknown): number | null {
  if (!Array.isArray(amr)) return null;
  let latest: number | null = null;
  for (const entry of amr) {
    const timestamp = entry && typeof entry === 'object' ? (entry as { timestamp?: unknown }).timestamp : undefined;
    if (typeof timestamp === 'number' && Number.isFinite(timestamp)) latest = Math.max(latest ?? timestamp, timestamp);
  }
  return latest;
}

/** Fails closed: a missing or implausible sign-in time is never "recent". */
export function isRecentAuthentication(
  authenticatedAt: number | null,
  nowMs: number,
  windowSeconds = ACCOUNT_DELETION_REAUTH_WINDOW_SECONDS,
) {
  if (authenticatedAt === null) return false;
  const ageSeconds = nowMs / 1000 - authenticatedAt;
  return ageSeconds >= -CLOCK_SKEW_SECONDS && ageSeconds <= windowSeconds;
}
