// Phase 03: live room status from the public presence channel. Pure helpers
// for leader election, spot counting and door strictness; no imports so unit
// tests load this module directly. Every count reads the public channel's
// users only, never the ghost-audit list (roadmap §0.9).

export const ROOM_SPOTS = ['desk', 'screen', 'speaker', 'bed'] as const;
export type RoomSpot = typeof ROOM_SPOTS[number];
export const DEFAULT_SPOT: RoomSpot = 'bed';

// Strictest last: dnd > knock > open.
export const ROOM_DOORS = ['open', 'knock', 'dnd'] as const;
export type RoomDoor = typeof ROOM_DOORS[number];
export const DEFAULT_DOOR: RoomDoor = 'open';

export const HEARTBEAT_INTERVAL_MS = 60_000;
export const SPOT_CHANGE_DEBOUNCE_MS = 3_000;
export const HIDDEN_PAUSE_MS = 2 * 60_000;

export type LivePresenceUser = { user_id: string; spot?: unknown; door?: unknown };

export function normalizeSpot(value: unknown): RoomSpot {
  return (ROOM_SPOTS as readonly unknown[]).includes(value) ? value as RoomSpot : DEFAULT_SPOT;
}

export function normalizeDoor(value: unknown): RoomDoor {
  return (ROOM_DOORS as readonly unknown[]).includes(value) ? value as RoomDoor : DEFAULT_DOOR;
}

// One browser per room sends the heartbeat: the lowest user id present.
export function heartbeatLeader(users: readonly LivePresenceUser[]): string | null {
  let leader: string | null = null;
  for (const user of users) {
    if (user?.user_id && (leader === null || user.user_id < leader)) leader = user.user_id;
  }
  return leader;
}

export type SpotCounts = Record<RoomSpot, number>;

// Each person counts once, even with several tabs open.
function uniqueById(users: readonly LivePresenceUser[]) {
  const byId = new Map<string, LivePresenceUser>();
  for (const user of users) if (user?.user_id) byId.set(user.user_id, user);
  return [...byId.values()];
}

export function countSpots(users: readonly LivePresenceUser[]): { people: number; spots: SpotCounts } {
  const unique = uniqueById(users);
  const spots: SpotCounts = { desk: 0, screen: 0, speaker: 0, bed: 0 };
  for (const user of unique) spots[normalizeSpot(user.spot)] += 1;
  return { people: unique.length, spots };
}

// A ghost's own public presence can linger in a stale Realtime sync; never count it locally.
export function publicUsersForViewer<T extends LivePresenceUser>(
  users: T[],
  selfId: string | null,
  isGhostMode: boolean,
): T[] {
  if (!isGhostMode || !selfId) return users;
  return users.filter((user) => user.user_id !== selfId);
}

export function strictestDoor(users: readonly LivePresenceUser[]): RoomDoor {
  let rank = 0;
  for (const user of users) rank = Math.max(rank, ROOM_DOORS.indexOf(normalizeDoor(user?.door)));
  return ROOM_DOORS[rank];
}

export function heartbeatArgs(roomId: string, users: readonly LivePresenceUser[]) {
  const { people, spots } = countSpots(users);
  return { p_room_id: roomId, p_people: people, p_spots: spots, p_door: strictestDoor(users) };
}

// A stable key for "the counts or the door changed".
export function liveStatusKey(users: readonly LivePresenceUser[]) {
  const { people, spots } = countSpots(users);
  return `${people}|${ROOM_SPOTS.map((spot) => spots[spot]).join(',')}|${strictestDoor(users)}`;
}

// Heartbeats pause once the tab has been hidden for more than 2 minutes.
export function heartbeatPaused(hiddenSince: number | null, now: number) {
  return hiddenSince !== null && now - hiddenSince > HIDDEN_PAUSE_MS;
}
