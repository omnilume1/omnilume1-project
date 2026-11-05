// Listen Together rules (Action 16 Stage 3). Pure and import-free so the
// unit-test build compiles it on its own. The server owns seq, the anchor and
// the queue (music_listen_control); clients only apply and ask.

export type ListenTargetKind = 'room' | 'group';
export type ListenTarget = { kind: ListenTargetKind; id: string; name: string };

export type ListenSession = {
  targetKind: ListenTargetKind;
  targetId: string;
  hostId: string | null;
  hostName: string;
  hostOnly: boolean;
  uploadId: string | null;
  positionMs: number;
  isPlaying: boolean;
  /** Server time of the last change, ms since epoch. */
  anchorMs: number;
  queue: string[];
  seq: number;
  ended: boolean;
  /** Server clock minus this client's clock when the state arrived (ms). */
  clockOffsetMs: number;
};

export type ListenAction = 'start' | 'play' | 'pause' | 'seek' | 'load' | 'enqueue' | 'remove' | 'next' | 'host_only' | 'end';

// Re-seek a follower whose audio is further than this from the shared playhead.
export const LISTEN_DRIFT_MS = 1_500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function listenTopic(kind: ListenTargetKind, id: string) {
  return `music_listen_${kind}_${id}`;
}

/** Validates the RPC / realtime payload; anything malformed is dropped (null). */
export function parseListenSession(raw: unknown, clientNowMs: number): ListenSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const kind = value.target_kind;
  const anchorMs = Date.parse(String(value.anchor_at));
  const serverNowMs = Date.parse(String(value.server_now));
  const seq = Number(value.seq);
  const position = Number(value.position_ms);
  if ((kind !== 'room' && kind !== 'group') || typeof value.target_id !== 'string' || !UUID.test(value.target_id)) return null;
  if (!Number.isFinite(anchorMs) || !Number.isFinite(seq) || !Number.isFinite(position)) return null;
  const uploadId = typeof value.upload_id === 'string' && UUID.test(value.upload_id) ? value.upload_id : null;
  const queue = Array.isArray(value.queue) ? value.queue.filter((id): id is string => typeof id === 'string' && UUID.test(id)).slice(0, 100) : [];
  return {
    targetKind: kind,
    targetId: value.target_id,
    hostId: typeof value.host_id === 'string' ? value.host_id : null,
    hostName: typeof value.host_name === 'string' ? value.host_name.slice(0, 100) : 'A member',
    hostOnly: value.host_only === true,
    uploadId,
    positionMs: Math.max(0, position),
    isPlaying: value.is_playing === true,
    anchorMs,
    queue,
    seq,
    ended: value.ended === true,
    clockOffsetMs: Number.isFinite(serverNowMs) ? serverNowMs - clientNowMs : 0,
  };
}

/** Newer state wins; equal or older seq (late or duplicate delivery) is ignored. */
export function acceptListenState(current: ListenSession | null, incoming: ListenSession | null) {
  if (!incoming) return current;
  if (!current || current.targetKind !== incoming.targetKind || current.targetId !== incoming.targetId) return incoming;
  return incoming.seq > current.seq ? incoming : current;
}

/** Where the shared playhead is now, on this client's clock. */
export function listenPositionMs(session: ListenSession, clientNowMs: number, durationMs = 0) {
  const elapsed = session.isPlaying ? Math.max(0, clientNowMs + session.clockOffsetMs - session.anchorMs) : 0;
  const position = session.positionMs + elapsed;
  return durationMs > 0 ? Math.min(position, durationMs) : position;
}

export function canControlListen(session: ListenSession | null, userId: string | null) {
  return Boolean(session && !session.ended && userId && (!session.hostOnly || session.hostId === userId));
}
