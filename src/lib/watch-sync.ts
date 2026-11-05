// Watch synchronization rules (Action 11). Pure and import-free so the
// unit-test build compiles it on its own.

export type PlaybackSnapshot = {
  time: number;
  playing: boolean;
  speed: number;
  // When this client received/recorded the state (its own clock).
  updatedAt: number;
  // Sender or server time of the event (used for restored snapshots).
  eventTimestamp: number;
  source: 'local' | 'remote' | 'restored';
};

// Seek the player when it is this far from the room position (seconds).
export const DRIFT_SEEK_THRESHOLD_SECONDS = 1;
// A native seek closer than this to the room position is the echo of an
// applied remote seek, not a user action.
export const SEEK_ECHO_TOLERANCE_SECONDS = 1;
// The active controller announces its position this often while playing.
export const HEARTBEAT_INTERVAL_MS = 5_000;
// Rapid seeks (dragging the scrubber) coalesce into one broadcast.
export const SEEK_COALESCE_MS = 300;
const MAX_EXTRAPOLATION_MS = 6 * 60 * 60 * 1000;

/**
 * Where the room's playback is now. A playing state advances by the time
 * since it was received (remote/local) or since the server stored it
 * (restored snapshot), scaled by speed.
 */
export function expectedPosition(state: PlaybackSnapshot, now: number) {
  const base = Math.max(0, Number.isFinite(state.time) ? state.time : 0);
  if (!state.playing) return base;
  const anchor = state.source === 'restored' ? state.eventTimestamp : state.updatedAt;
  if (!Number.isFinite(anchor) || anchor <= 0) return base;
  const elapsed = Math.min(Math.max(0, now - anchor), MAX_EXTRAPOLATION_MS);
  const speed = Number.isFinite(state.speed) && state.speed > 0 ? state.speed : 1;
  return base + (elapsed / 1000) * speed;
}

export function needsDriftSeek(actual: number, expected: number) {
  return Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) > DRIFT_SEEK_THRESHOLD_SECONDS;
}

/**
 * Idempotence: a native player event becomes a room broadcast only when it
 * changes room state. Applying remote state fires the same native events,
 * and those must never be re-broadcast.
 */
export function shouldBroadcastNative(
  kind: 'play' | 'pause' | 'seek',
  room: PlaybackSnapshot | null,
  localTime: number,
  now: number,
) {
  if (!room) return kind !== 'seek';
  if (kind === 'play') return !room.playing;
  if (kind === 'pause') return room.playing;
  return Math.abs(localTime - expectedPosition(room, now)) > SEEK_ECHO_TOLERANCE_SECONDS;
}

/** Trailing coalescer: only the last call within `waitMs` runs. */
export function createCoalescer<T>(run: (value: T) => void, waitMs: number, timers: {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
} = { set: (fn, ms) => setTimeout(fn, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) }) {
  let handle: unknown = null;
  let pending: { value: T } | null = null;
  return {
    push(value: T) {
      pending = { value };
      if (handle !== null) timers.clear(handle);
      handle = timers.set(() => {
        handle = null;
        const next = pending;
        pending = null;
        if (next) run(next.value);
      }, waitMs);
    },
    cancel() {
      if (handle !== null) timers.clear(handle);
      handle = null;
      pending = null;
    },
  };
}

export type QueueItem = { id: string; position: number };

/** New order after moving one item to `toIndex` (clamped). */
export function reorderQueue<T extends QueueItem>(items: T[], itemId: string, toIndex: number): T[] {
  const ordered = [...items].sort((left, right) => left.position - right.position);
  const from = ordered.findIndex((item) => item.id === itemId);
  if (from === -1) return ordered;
  const [moved] = ordered.splice(from, 1);
  const target = Math.max(0, Math.min(ordered.length, Math.trunc(toIndex)));
  ordered.splice(target, 0, moved);
  return ordered.map((item, index) => ({ ...item, position: index }));
}

export function formatPlaybackTime(seconds: number) {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  return `${hours > 0 ? `${hours}:` : ''}${mm}:${String(secs).padStart(2, '0')}`;
}
