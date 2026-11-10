// Door key and nameplate rules (hostel roadmap phase 04). The database
// enforces the same rules; these keep the UI and server actions in step.

const NAMEPLATE_PATTERN = /^[A-Za-z0-9 -]{1,12}$/;
const DOOR_TOKEN_PATTERN = /^[a-f0-9]{48}$/;

export const NAMEPLATE_RULE = 'A nameplate is 1–12 letters, numbers, spaces or dashes.';

/** Collapses whitespace and trims; returns null when it isn't a valid nameplate. */
export function normalizeNameplate(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const nameplate = value.trim().replace(/\s+/g, ' ');
  return NAMEPLATE_PATTERN.test(nameplate) ? nameplate : null;
}

/** A door-key token as the database mints it: 24 random bytes, lowercase hex. */
export function isDoorToken(value: unknown): value is string {
  return typeof value === 'string' && DOOR_TOKEN_PATTERN.test(value);
}
