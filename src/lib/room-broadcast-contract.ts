// Room Broadcast wire contract (Action 07, audit finding D7).
//
// Supabase Realtime authorizes a private Broadcast topic when a client joins,
// and re-checks only when that client sends a new access token. A member who
// is removed but keeps an old connection open (and never refreshes) keeps
// receiving every Broadcast on the topic. So nothing sent over Broadcast may
// be protected room data: no chat text, media titles, URLs, storage paths,
// or signed URLs.
//
// Persistent protected data reaches clients only through RLS-checked Postgres
// Changes (chat) or authenticated fetches (Watch media via resolveRoomMedia,
// the whiteboard via getRoomWhiteboard).
// Broadcast carries only identifiers, playback/timer state and revision hints.
// Both the sender and the receiver pass every payload through
// toRoomBroadcastPayload, so a client that still sends extra fields cannot
// smuggle them past an updated receiver.
//
// This module deliberately has no imports. The authorization probe
// (scripts/security/authorization-probe.mjs) loads this exact file to send
// the same wire payloads the app sends.

export const ROOM_BROADCAST_EVENT_TYPES = [
  'typing',
  'play',
  'pause',
  'seek',
  'mute',
  'cast',
  'stop_cast',
  'force_sync',
  'request_sync',
  'timer_start',
  'timer_pause',
  'timer_reset',
  'subtitle_upload',
  'whiteboard_changed',
  // Action 11: the controller's position for drift correction, and revision
  // hints for the shared queue and clips (contents are re-read through RLS).
  'media_heartbeat',
  'queue_changed',
  'clips_changed',
  // Action 12: revision hints (contents are re-read through RLS/RPC), and
  // ephemeral presence: whiteboard cursors, who is editing a note, the PDF
  // page a presenter is on, and WebRTC signaling for voice/screen share.
  'study_changed',
  'collab_changed',
  'cursor',
  'note_editing',
  'pdf_follow',
  'rtc_signal',
] as const;

export type RoomBroadcastEventType = (typeof ROOM_BROADCAST_EVENT_TYPES)[number];

type FieldKind = 'uuid' | 'id' | 'number' | 'version' | 'boolean' | 'source' | 'subject'
  | 'study_kind' | 'collab_kind' | 'coord' | 'page' | 'rtc_kind' | 'sdp' | 'candidate' | 'index';

export const STUDY_CHANGE_KINDS = ['notes', 'tasks', 'resources', 'pdf'] as const;
export const COLLAB_CHANGE_KINDS = ['hands', 'polls', 'countdowns', 'events', 'voice', 'recordings'] as const;
// 'who' asks members who are sharing to announce it (sent once on connect, so
// people who just opened the room see a live tab without waiting for a heartbeat).
export const RTC_SIGNAL_KINDS = ['hello', 'bye', 'offer', 'answer', 'ice', 'who'] as const;
// Session descriptions and ICE candidates are WebRTC connection data (codecs,
// fingerprints, candidate addresses), never room content. They are bounded and
// shape-checked so the topic cannot carry arbitrary payloads.
const SDP_MAX_CHARS = 30_000;
const CANDIDATE_MAX_CHARS = 1_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// castId and timer sessionId are client-generated event ids (UUIDs, or a
// timestamp-random fallback in non-secure contexts). They must never be a URL.
const EVENT_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
// The Study timer input enforces the same limit (StudyStage).
export const ROOM_TIMER_SUBJECT_MAX_CHARS = 120;
const SUBJECT_MAX_CHARS = ROOM_TIMER_SUBJECT_MAX_CHARS;
const URL_LIKE_PATTERN = /(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|\/storage\/v1\/|token=|[a-z]:\\|\.(?:mp4|webm|ogg|ogv|mp3|wav|flac|vtt|srt|weba|m4v)\b)/i;

const PLAYBACK_FIELDS: Record<string, FieldKind> = {
  mediaId: 'uuid',
  castId: 'id',
  sourceType: 'source',
  time: 'number',
  speed: 'number',
  playing: 'boolean',
  muted: 'boolean',
  volume: 'number',
  controllerId: 'uuid',
};

const TIMER_FIELDS: Record<string, FieldKind> = {
  endTime: 'number',
  remaining: 'number',
  duration: 'number',
  subject: 'subject',
  sessionId: 'id',
  ownerId: 'uuid',
  startedAt: 'number',
  segmentStartedAt: 'number',
  elapsedSeconds: 'number',
  completed: 'boolean',
};

const EVENT_FIELDS: Record<RoomBroadcastEventType, Record<string, FieldKind>> = {
  typing: {},
  request_sync: {},
  stop_cast: {},
  play: PLAYBACK_FIELDS,
  pause: PLAYBACK_FIELDS,
  seek: PLAYBACK_FIELDS,
  mute: PLAYBACK_FIELDS,
  cast: PLAYBACK_FIELDS,
  force_sync: PLAYBACK_FIELDS,
  subtitle_upload: { mediaId: 'uuid', castId: 'id' },
  timer_start: TIMER_FIELDS,
  timer_pause: TIMER_FIELDS,
  timer_reset: TIMER_FIELDS,
  // A revision hint only: members re-read the board through the protected
  // getRoomWhiteboard action; drawing content never travels over Broadcast.
  whiteboard_changed: { version: 'version' },
  media_heartbeat: { mediaId: 'uuid', castId: 'id', time: 'number', speed: 'number', playing: 'boolean' },
  queue_changed: { version: 'version' },
  clips_changed: { version: 'version' },
  study_changed: { version: 'version', kind: 'study_kind' },
  collab_changed: { version: 'version', kind: 'collab_kind' },
  // Whiteboard world coordinates (each member pans/zooms independently).
  cursor: { x: 'coord', y: 'coord' },
  note_editing: { noteId: 'uuid', editing: 'boolean' },
  pdf_follow: { fileId: 'uuid', page: 'page' },
  // `watching`: whether the member can see a shared screen right now (voice-mesh.ts sends a
  // hidden viewer a 2 fps trickle). Without it here, the flag was stripped and never arrived.
  rtc_signal: { to: 'uuid', kind: 'rtc_kind', sdp: 'sdp', candidate: 'candidate', sdpMid: 'id', sdpMLineIndex: 'index', screen: 'boolean', mic: 'boolean', watching: 'boolean' },
};

// Fields an event is useless without.
const REQUIRED_FIELDS: Partial<Record<RoomBroadcastEventType, string[]>> = {
  study_changed: ['version', 'kind'],
  collab_changed: ['version', 'kind'],
  cursor: ['x', 'y'],
  note_editing: ['noteId', 'editing'],
  pdf_follow: ['fileId', 'page'],
  rtc_signal: ['kind'],
};

// Media events are useless without a mediaId: receivers resolve the playable
// URL, title and subtitle from it through an authenticated fetch.
const MEDIA_ID_REQUIRED = new Set<RoomBroadcastEventType>(['play', 'pause', 'seek', 'mute', 'cast', 'force_sync', 'subtitle_upload', 'media_heartbeat']);
const VERSION_REQUIRED = new Set<RoomBroadcastEventType>(['whiteboard_changed', 'queue_changed', 'clips_changed']);
const EVENT_TYPES = new Set<string>(ROOM_BROADCAST_EVENT_TYPES);

export function isRoomBroadcastEventType(value: unknown): value is RoomBroadcastEventType {
  return typeof value === 'string' && EVENT_TYPES.has(value);
}

function isValidField(kind: FieldKind, value: unknown) {
  switch (kind) {
    case 'uuid':
      return typeof value === 'string' && UUID_PATTERN.test(value);
    case 'id':
      return typeof value === 'string' && EVENT_ID_PATTERN.test(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'version':
      return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
    case 'boolean':
      return typeof value === 'boolean';
    case 'source':
      return value === 'url' || value === 'upload';
    case 'subject':
      return typeof value === 'string' && value.length <= SUBJECT_MAX_CHARS && !URL_LIKE_PATTERN.test(value);
    case 'study_kind':
      return typeof value === 'string' && (STUDY_CHANGE_KINDS as readonly string[]).includes(value);
    case 'collab_kind':
      return typeof value === 'string' && (COLLAB_CHANGE_KINDS as readonly string[]).includes(value);
    case 'coord':
      return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
    case 'page':
      return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100_000;
    case 'index':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 64;
    case 'rtc_kind':
      return typeof value === 'string' && (RTC_SIGNAL_KINDS as readonly string[]).includes(value);
    case 'sdp':
      return typeof value === 'string' && value.length <= SDP_MAX_CHARS && value.startsWith('v=0');
    case 'candidate':
      return typeof value === 'string' && value.length <= CANDIDATE_MAX_CHARS && (value === '' || value.startsWith('candidate:'));
    default:
      return false;
  }
}

/**
 * Returns the only fields of `payload` that may travel over Broadcast for
 * `eventType`, or null when the event must not be sent or applied (an unknown
 * type, or a media event without a valid mediaId). Fields that fail
 * validation are dropped rather than coerced.
 */
export function toRoomBroadcastPayload(eventType: unknown, payload: unknown): Record<string, unknown> | null {
  if (!isRoomBroadcastEventType(eventType)) return null;
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const wire: Record<string, unknown> = {};
  for (const [key, kind] of Object.entries(EVENT_FIELDS[eventType])) {
    if (isValidField(kind, source[key])) wire[key] = source[key];
  }
  if (MEDIA_ID_REQUIRED.has(eventType) && typeof wire.mediaId !== 'string') return null;
  if (VERSION_REQUIRED.has(eventType) && typeof wire.version !== 'number') return null;
  if (REQUIRED_FIELDS[eventType]?.some((field) => !(field in wire))) return null;
  // Offers/answers need a description, ICE needs a candidate, and every
  // directed signal needs a recipient.
  if (eventType === 'rtc_signal') {
    const kind = wire.kind;
    if ((kind === 'offer' || kind === 'answer') && (typeof wire.sdp !== 'string' || typeof wire.to !== 'string')) return null;
    if (kind === 'ice' && (typeof wire.candidate !== 'string' || typeof wire.to !== 'string')) return null;
  }
  return wire;
}

export function roomBroadcastEventRequiresMediaId(eventType: RoomBroadcastEventType) {
  return MEDIA_ID_REQUIRED.has(eventType);
}
