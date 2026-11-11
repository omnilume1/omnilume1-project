// Phase 06 (hostel roadmap): the /join/<token> page, its link preview and its
// OG image. Pure helpers only; no imports, so the unit tests load this module
// directly. Everything here works on what get_public_invite_card returns,
// which never includes ids, user names, avatars, the timer subject or titles.

export type JoinCard = {
  roomName: string;
  nameplate: string | null;
  people: number;
  desk: number;
  screen: number;
  speaker: number;
  bed: number;
  focusEndsAt: string | null;
};

// Card times (focus ends) when the viewer's zone is unknown: link previews and
// the OG image are fetched by crawlers whose location means nothing.
export const DEFAULT_TIME_ZONE = 'Asia/Kolkata';

function count(value: unknown) {
  const number = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** One get_public_invite_card row, or null when it isn't one. */
export function parseJoinCard(row: unknown): JoinCard | null {
  if (!row || typeof row !== 'object') return null;
  const value = row as Record<string, unknown>;
  const roomName = text(value.room_name);
  if (!roomName) return null;
  return {
    roomName,
    nameplate: text(value.nameplate),
    people: count(value.people),
    desk: count(value.desk),
    screen: count(value.screen),
    speaker: count(value.speaker),
    bed: count(value.bed),
    focusEndsAt: text(value.focus_ends_at),
  };
}

/** "Room B-204", or the room's name when it has no nameplate. */
export function roomLabel(card: Pick<JoinCard, 'nameplate' | 'roomName'>) {
  return card.nameplate ? `Room ${card.nameplate}` : card.roomName;
}

// Ties keep this order.
const SPOT_PHRASES = [
  ['desk', 'at the desk'],
  ['screen', 'at the screen'],
  ['speaker', 'by the speaker'],
  ['bed', 'on the bed'],
] as const;

/**
 * "Room B-204 · lights on · 2 at the screen · 1 at the desk" while someone is
 * in (busiest spot first), "Room B-204 · lights off" when nobody is.
 */
export function liveLine(card: JoinCard) {
  const label = roomLabel(card);
  if (card.people === 0) return `${label} · lights off`;
  const spots = SPOT_PHRASES
    .map(([spot, phrase], order) => ({ n: card[spot], phrase, order }))
    .filter((spot) => spot.n > 0)
    .sort((a, b) => b.n - a.n || a.order - b.order)
    .map((spot) => `${spot.n} ${spot.phrase}`);
  return [label, 'lights on', ...spots].join(' · ');
}

/** A valid IANA time zone, or the fallback. */
export function safeTimeZone(value: unknown, fallback = DEFAULT_TIME_ZONE) {
  if (typeof value !== 'string' || !value || value.length > 64) return fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return fallback;
  }
}

/** "9:40 pm" in the given zone. */
export function clockTime(at: Date, timeZone: string) {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: safeTimeZone(timeZone) })
    .format(at)
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** "focus ends 9:40 pm", or null when no focus timer is running. */
export function focusLine(focusEndsAt: string | null | undefined, timeZone: string, now = Date.now()) {
  if (!focusEndsAt) return null;
  const at = new Date(focusEndsAt);
  if (!Number.isFinite(at.getTime()) || at.getTime() <= now) return null;
  return `focus ends ${clockTime(at, timeZone)}`;
}

export type JoinFrom = 'invite' | 'callin' | 'visitor';

/** The /room ?from= for a join: a guest is a visitor, else the link's ref decides. */
export function joinFrom(role: unknown, ref: string | null | undefined): JoinFrom {
  if (role === 'guest') return 'visitor';
  return ref === 'callin' ? 'callin' : 'invite';
}

/** /join/<token>, keeping an already-cleaned ref. */
export function joinPath(token: string, ref: string | null | undefined) {
  return ref ? `/join/${token}?ref=${encodeURIComponent(ref)}` : `/join/${token}`;
}

// Why Come in sent someone back to the page (?door=).
export const DOOR_NOTICES = ['changed', 'closed', 'retry'] as const;
export type DoorNotice = typeof DOOR_NOTICES[number];

/** Maps a join_room_with_invite error message to a notice. */
export function doorNoticeFor(message: string): DoorNotice {
  if (/invalid or expired|invalid invite token/i.test(message)) return 'changed';
  if (/room is unavailable/i.test(message)) return 'closed';
  return 'retry';
}

export function parseDoorNotice(value: unknown): DoorNotice | null {
  return (DOOR_NOTICES as readonly unknown[]).includes(value) ? value as DoorNotice : null;
}
