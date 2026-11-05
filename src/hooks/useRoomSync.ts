'use client';

import { unwrapAction } from '@/lib/action-result';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/utils/supabase/client';
import { isUuid } from '@/lib/message-limits';
import { isRoomBroadcastEventType, toRoomBroadcastPayload, type RoomBroadcastEventType } from '@/lib/room-broadcast-contract';
import { resolveRoomMedia, type ResolvedRoomMedia } from '@/actions/media';
import { getRoomRealtimeSnapshots, saveRoomRealtimeSnapshot } from '@/actions/room-controls';

type BrowserSupabaseClient = ReturnType<typeof createClient>;
type RoomChannel = ReturnType<BrowserSupabaseClient['channel']>;
type RoomChannelKind = 'general' | 'chat' | 'study' | 'watch' | 'control';
type RoomChannels = Record<RoomChannelKind, RoomChannel | null>;

// Chat messages are not Broadcast events. They arrive through RLS-checked
// Postgres Changes on public.messages (see the general channel below), so a
// member who loses chat access stops receiving them at once.
export type SyncEventType = RoomBroadcastEventType;

export type SyncEvent = {
  event_id: string;
  sender_id: string;
  timestamp: number;
  room_id: string;
  event_type: SyncEventType;
  payload: Record<string, unknown>;
  state_version: number;
};

export type RoomMediaState = {
  url: string;
  title: string;
  subtitleUrl: string | null;
  time: number;
  speed: number;
  playing: boolean;
  sourceType: 'url' | 'upload';
  castId: string;
  mediaId?: string;
  muted: boolean;
  volume: number;
  controllerId: string | null;
  eventId: string;
  eventTimestamp: number;
  source: 'local' | 'remote' | 'restored';
  updatedAt: number;
};

export type TimerState = {
  isRunning: boolean;
  endTime: number | null;
  remaining: number;
  duration: number;
  subject: string;
  sessionId: string | null;
  ownerId: string | null;
  startedAt: number | null;
  segmentStartedAt: number | null;
  elapsedSeconds: number;
  completed: boolean;
};

export type RoomSyncValue = {
  currentUserId: string | null;
  canControlMedia: boolean;
  connectionState: 'idle' | 'connecting' | 'connected' | 'error';
  typingUsers: Map<string, number>;
  mediaState: RoomMediaState | null;
  activeMediaUrl: string | null;
  activeSubtitleUrl: string | null;
  timerState: TimerState;
  syncRequestTrigger: number;
  roomMessageEvents: RoomMessageEvent[];
  roomControlEvents: RoomControlEvent[];
  roomControlVersion: number;
  // Action 13: bumps on every room_activity insert RLS lets this member see
  // (same private channel as control events); feeds re-read through the RPC.
  roomActivityVersion: number;
  // Increments each time Realtime confirms the room's Postgres Changes feed
  // (first join and every rejoin). Rows committed before that are never
  // replayed, so persistent views (chat) re-fetch through RLS when it changes.
  connectionGeneration: number;
  // Highest whiteboard version announced by another member. The board itself
  // is re-read through getRoomWhiteboard (see room-broadcast-contract.ts).
  whiteboardVersion: number;
  // Action 11: the active controller's last announced position (drift
  // correction) and revision counters for the shared queue and clips.
  mediaHeartbeat: MediaHeartbeat | null;
  queueVersion: number;
  clipsVersion: number;
  recordMediaTime: (time: number) => void;
  broadcastEvent: (eventType: SyncEventType, payload?: Record<string, unknown>) => void;
  // Action 12: ephemeral room events (hints, cursors, editing presence, PDF
  // follow, WebRTC signaling) go to subscribers instead of room state, so a
  // cursor stream never re-renders the room. Returns false when not sent.
  sendRoomEvent: (eventType: RoomEventType, payload?: Record<string, unknown>) => boolean;
  subscribeRoomEvents: (listener: RoomEventListener) => () => void;
};

export const ROOM_EVENT_TYPES = ['study_changed', 'collab_changed', 'cursor', 'note_editing', 'pdf_follow', 'rtc_signal'] as const;
export type RoomEventType = (typeof ROOM_EVENT_TYPES)[number];
export type RoomEvent = { type: RoomEventType; payload: Record<string, unknown>; senderId: string; local: boolean };
export type RoomEventListener = (event: RoomEvent) => void;
const ROOM_EVENT_TYPE_SET = new Set<string>(ROOM_EVENT_TYPES);
const isRoomEventType = (value: string): value is RoomEventType => ROOM_EVENT_TYPE_SET.has(value);

export type MediaHeartbeat = {
  mediaId: string;
  castId: string | null;
  time: number;
  speed: number;
  playing: boolean;
  senderId: string;
  receivedAt: number;
};

export type RoomMessageEvent = {
  kind: 'insert' | 'update';
  message: Record<string, unknown>;
};

// Action 05 changes are persisted server-side. This event contract lets room
// surfaces refresh their own data from the existing shared channel without
// trusting a client broadcast as the source of truth.
export type RoomControlEvent = {
  id: number;
  roomId: string;
  eventType: 'membership_changed' | 'role_changed' | 'invite_changed' | 'restriction_changed' | 'ownership_changed' | 'settings_changed' | 'lock_changed' | 'announcement_changed' | 'guest_changed' | 'feature_changed' | 'group_converted';
  subjectUserId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

const DEFAULT_TIMER: TimerState = {
  isRunning: false,
  endTime: null,
  remaining: 25 * 60,
  duration: 25 * 60,
  subject: '',
  sessionId: null,
  ownerId: null,
  startedAt: null,
  segmentStartedAt: null,
  elapsedSeconds: 0,
  completed: false,
};

function normalizeTimerState(value: Partial<TimerState> | null | undefined): TimerState {
  const next = { ...DEFAULT_TIMER, ...(value ?? {}) };
  return {
    isRunning: Boolean(next.isRunning),
    endTime: typeof next.endTime === 'number' && Number.isFinite(next.endTime) ? next.endTime : null,
    remaining: Math.max(0, Number.isFinite(next.remaining) ? next.remaining : DEFAULT_TIMER.remaining),
    duration: Math.max(0, Number.isFinite(next.duration) ? next.duration : DEFAULT_TIMER.duration),
    subject: typeof next.subject === 'string' ? next.subject : '',
    sessionId: typeof next.sessionId === 'string' && next.sessionId ? next.sessionId : null,
    ownerId: typeof next.ownerId === 'string' && next.ownerId ? next.ownerId : null,
    startedAt: typeof next.startedAt === 'number' && Number.isFinite(next.startedAt) ? next.startedAt : null,
    segmentStartedAt: typeof next.segmentStartedAt === 'number' && Number.isFinite(next.segmentStartedAt) ? next.segmentStartedAt : null,
    elapsedSeconds: Math.max(0, Number.isFinite(next.elapsedSeconds) ? next.elapsedSeconds : 0),
    completed: Boolean(next.completed),
  };
}

function readSessionValue<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;

  try {
    const saved = window.sessionStorage.getItem(key);
    return saved ? (JSON.parse(saved) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeSessionValue(key: string, value: unknown) {
  if (typeof window === 'undefined') return;

  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Session storage can be unavailable in private browsing or when full.
  }
}

function removeSessionValue(key: string) {
  if (typeof window === 'undefined') return;

  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Ignore storage cleanup failures; realtime state still remains usable.
  }
}

function mediaStorageKey(roomId: string) {
  return `room-media-state:${roomId}`;
}

function timerStorageKey(roomId: string) {
  return `timer:${roomId}`;
}

// Called when the current user loses access to a room. Session storage is the
// only place room media state (including signed URLs) outlives the page.
export function clearRoomRealtimeCache(roomId: string) {
  if (!roomId) return;
  removeSessionValue(mediaStorageKey(roomId));
  removeSessionValue(timerStorageKey(roomId));
}

const MEDIA_RESOLUTION_TTL_MS = 45 * 60 * 1000;
// Room message columns relayed from the RLS-checked Postgres Changes feed
// (edits, pins and reaction summaries are UPDATEs of the same row).
const ROOM_MESSAGE_FIELDS = ['id', 'sender_id', 'content', 'is_deleted', 'created_at', 'edited_at', 'reply_to_id', 'pinned_at', 'pinned_by', 'reaction_summary'] as const;

function asFiniteNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

type MediaEventMeta = {
  eventId: string;
  timestamp: number;
  senderId?: string;
  source: 'local' | 'remote' | 'restored';
};

const MAX_SYNC_EVENT_JSON_CHARS = 64_000;

function isSyncEventPayload(value: unknown, roomId: string): value is SyncEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Partial<SyncEvent>;
  if (typeof event.event_id !== 'string' || event.event_id.length === 0 || event.event_id.length > 128) return false;
  if (!isUuid(event.sender_id) || event.room_id !== roomId) return false;
  if (typeof event.timestamp !== 'number' || !Number.isFinite(event.timestamp)) return false;
  if (typeof event.state_version !== 'number' || !Number.isSafeInteger(event.state_version) || event.state_version < 1) return false;
  if (!isRoomBroadcastEventType(event.event_type)) return false;
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) return false;
  try {
    return JSON.stringify(event).length <= MAX_SYNC_EVENT_JSON_CHARS;
  } catch {
    return false;
  }
}

type MediaRevision = Pick<MediaEventMeta, 'eventId' | 'timestamp'>;
type RealtimeSnapshot = {
  snapshot_type: 'media' | 'timer' | 'settings';
  state_version: number | string;
  payload: unknown;
  updated_at: string;
};

function isMediaEvent(eventType: SyncEventType) {
  return eventType === 'cast'
    || eventType === 'stop_cast'
    || eventType === 'subtitle_upload'
    || eventType === 'force_sync'
    || eventType === 'play'
    || eventType === 'pause'
    || eventType === 'seek'
    || eventType === 'mute';
}

function channelKindForEvent(eventType: SyncEventType): RoomChannelKind {
  if (eventType === 'typing') return 'chat';
  // Voice/screen signaling and room-wide collaboration hints need chat;
  // Study surfaces (notes, cursors, PDFs, tasks, resources) need study.
  if (eventType === 'collab_changed' || eventType === 'rtc_signal') return 'chat';
  if (eventType === 'study_changed' || eventType === 'cursor' || eventType === 'note_editing' || eventType === 'pdf_follow') return 'study';
  // Only Watch controllers may publish on sync-control (realtime policy).
  if (eventType === 'media_heartbeat') return 'control';
  if (eventType === 'queue_changed' || eventType === 'clips_changed') return 'watch';
  if (eventType === 'timer_start' || eventType === 'timer_pause' || eventType === 'timer_reset' || eventType === 'whiteboard_changed') return 'study';
  if (eventType === 'request_sync') return 'watch';
  return isMediaEvent(eventType) ? 'control' : 'general';
}

function snapshotTypeForEvent(eventType: SyncEventType): 'media' | 'timer' | null {
  if (isMediaEvent(eventType)) return 'media';
  if (eventType === 'timer_start' || eventType === 'timer_pause' || eventType === 'timer_reset') return 'timer';
  return null;
}

function isNewerMediaRevision(next: MediaRevision, current: MediaRevision | null) {
  if (!current) return true;
  if (next.timestamp !== current.timestamp) return next.timestamp > current.timestamp;
  return next.eventId > current.eventId;
}

function normalizeMediaState(value: Partial<RoomMediaState> | null | undefined): RoomMediaState | null {
  if (!value || typeof value.url !== 'string' || !value.url) return null;
  return {
    url: value.url,
    title: typeof value.title === 'string' && value.title ? value.title : 'External Stream',
    subtitleUrl: typeof value.subtitleUrl === 'string' ? value.subtitleUrl : null,
    time: Math.max(0, typeof value.time === 'number' && Number.isFinite(value.time) ? value.time : 0),
    speed: Math.min(4, Math.max(0.25, typeof value.speed === 'number' && Number.isFinite(value.speed) ? value.speed : 1)),
    playing: Boolean(value.playing),
    sourceType: value.sourceType === 'upload' ? 'upload' : 'url',
    castId: typeof value.castId === 'string' && value.castId ? value.castId : createEventId(),
    mediaId: typeof value.mediaId === 'string' && value.mediaId ? value.mediaId : undefined,
    muted: Boolean(value.muted),
    volume: Math.min(1, Math.max(0, typeof value.volume === 'number' && Number.isFinite(value.volume) ? value.volume : 1)),
    controllerId: typeof value.controllerId === 'string' && value.controllerId ? value.controllerId : null,
    eventId: typeof value.eventId === 'string' && value.eventId ? value.eventId : createEventId(),
    eventTimestamp: typeof value.eventTimestamp === 'number' && Number.isFinite(value.eventTimestamp)
      ? value.eventTimestamp
      : (typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0),
    source: value.source === 'local' || value.source === 'remote' ? value.source : 'restored',
    updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now(),
  };
}

function createMediaState(
  payload: Record<string, unknown>,
  previous: RoomMediaState | null,
  playing: boolean,
  resetSubtitle = false,
  meta?: MediaEventMeta,
): RoomMediaState | null {
  const url = asString(payload.url, previous?.url ?? '');
  if (!url) return null;

  const speed = Math.min(4, Math.max(0.25, asFiniteNumber(payload.speed, previous?.speed ?? 1)));
  const time = Math.max(0, asFiniteNumber(payload.time, previous?.time ?? 0));
  const sourceType = payload.sourceType === 'upload'
    ? 'upload'
    : payload.sourceType === 'url'
      ? 'url'
      : (previous?.sourceType ?? 'url');
  const subtitleUrl = resetSubtitle
    ? null
    : typeof payload.subtitleUrl === 'string'
      ? payload.subtitleUrl
      : (payload.subtitleUrl === null ? null : (previous?.subtitleUrl ?? null));
  const eventTimestamp = meta?.timestamp ?? Date.now();

  return {
    url,
    title: asString(payload.title, previous?.title ?? 'External Stream'),
    subtitleUrl,
    time,
    speed,
    playing,
    sourceType,
    castId: asString(payload.castId, previous?.castId ?? createEventId()),
    mediaId: asString(payload.mediaId, previous?.mediaId ?? '') || undefined,
    muted: typeof payload.muted === 'boolean' ? payload.muted : (previous?.muted ?? false),
    volume: typeof payload.volume === 'number' && Number.isFinite(payload.volume)
      ? Math.min(1, Math.max(0, payload.volume))
      : (previous?.volume ?? 1),
    controllerId: asString(payload.controllerId, meta?.senderId ?? previous?.controllerId ?? '') || null,
    eventId: meta?.eventId ?? previous?.eventId ?? createEventId(),
    eventTimestamp,
    source: meta?.source ?? previous?.source ?? 'local',
    updatedAt: Date.now(),
  };
}

function createEventId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useRoomSync(roomId: string, canControlMedia = false): RoomSyncValue {
  const supabase = createClient();
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const currentUserIdRef = useRef<string | null>(null);

  const [connectionState, setConnectionState] = useState<RoomSyncValue['connectionState']>('idle');
  const connectionStateRef = useRef<RoomSyncValue['connectionState']>('idle');
  const channelRefs = useRef<RoomChannels>({ general: null, chat: null, study: null, watch: null, control: null });
  const pendingEventsRef = useRef<Array<{ eventType: SyncEventType; payload: Record<string, unknown>; meta: MediaEventMeta }>>([]);

  const [typingUsers, setTypingUsers] = useState<Map<string, number>>(new Map());
  const [mediaState, setMediaState] = useState<RoomMediaState | null>(() =>
    normalizeMediaState(readSessionValue<Partial<RoomMediaState> | null>(mediaStorageKey(roomId), null)),
  );
  const mediaStateRef = useRef<RoomMediaState | null>(mediaState);
  const roomEventListenersRef = useRef(new Set<RoomEventListener>());
  // A restored browser snapshot is only a bootstrap value. It must not be
  // allowed to reject the first authoritative event from the active room.
  const lastMediaRevisionRef = useRef<MediaRevision | null>(null);
  const [timerState, setTimerState] = useState<TimerState>(() =>
    normalizeTimerState(readSessionValue<Partial<TimerState>>(timerStorageKey(roomId), DEFAULT_TIMER)),
  );
  const timerStateRef = useRef<TimerState>(timerState);
  const [syncRequestTrigger, setSyncRequestTrigger] = useState(0);
  const [roomMessageEvents, setRoomMessageEvents] = useState<RoomMessageEvent[]>([]);
  const [roomControlEvents, setRoomControlEvents] = useState<RoomControlEvent[]>([]);
  const [roomControlVersion, setRoomControlVersion] = useState(0);
  const [roomActivityVersion, setRoomActivityVersion] = useState(0);
  const [connectionGeneration, setConnectionGeneration] = useState(0);
  const [whiteboardVersion, setWhiteboardVersion] = useState(0);
  const [mediaHeartbeat, setMediaHeartbeat] = useState<MediaHeartbeat | null>(null);
  const [queueVersion, setQueueVersion] = useState(0);
  const [clipsVersion, setClipsVersion] = useState(0);
  // Server-allocated versions of the persisted media/timer snapshots. Older
  // Broadcasts and snapshots are ignored.
  const stateVersionsRef = useRef<Record<'media' | 'timer', number>>({ media: 0, timer: 0 });
  // Late async work (media resolution) must not apply to a room the user has
  // since left or been removed from.
  const roomIdRef = useRef(roomId);
  const mediaResolutionRef = useRef(new Map<string, { promise: Promise<ResolvedRoomMedia | null>; resolvedAt: number }>());

  // One authenticated fetch per media item, shared by every event that names
  // it. Events for the same media chain on the same promise, so they still
  // apply in arrival order; the revision check orders different media.
  const resolveMedia = useCallback((mediaId: string, refresh = false) => {
    const cache = mediaResolutionRef.current;
    const cached = cache.get(mediaId);
    if (!refresh && cached && Date.now() - cached.resolvedAt < MEDIA_RESOLUTION_TTL_MS) return cached.promise;
    const promise = resolveRoomMedia(roomId, mediaId)
      .then((result) => (result.success && result.media ? result.media : null))
      .catch(() => null);
    const entry = { promise, resolvedAt: Date.now() };
    cache.set(mediaId, entry);
    void promise.then((media) => {
      if (!media && cache.get(mediaId) === entry) cache.delete(mediaId);
    });
    return promise;
  }, [roomId]);

  const updateTimerState = useCallback((nextState: TimerState) => {
    const normalized = normalizeTimerState(nextState);
    timerStateRef.current = normalized;
    setTimerState(normalized);
    if (roomId) writeSessionValue(timerStorageKey(roomId), normalized);
  }, [roomId]);

  const updateMediaState = useCallback((updater: (current: RoomMediaState | null) => RoomMediaState | null) => {
    setMediaState((current) => {
      const next = updater(current);
      mediaStateRef.current = next;
      if (roomId) {
        if (next) writeSessionValue(mediaStorageKey(roomId), next);
        else removeSessionValue(mediaStorageKey(roomId));
      }
      return next;
    });
  }, [roomId]);

  // Keep the host's current playback clock available to a later sync request
  // without rerendering the whole room on every native timeupdate event.
  const recordMediaTime = useCallback((time: number) => {
    if (!Number.isFinite(time) || !mediaStateRef.current) return;

    const next = {
      ...mediaStateRef.current,
      time: Math.max(0, time),
      updatedAt: Date.now(),
    };
    mediaStateRef.current = next;
    writeSessionValue(mediaStorageKey(roomId), next);
  }, [roomId]);

  const applyMediaEvent = useCallback((eventType: SyncEventType, payload: Record<string, unknown>, meta: MediaEventMeta) => {
    if (isMediaEvent(eventType)) {
      const revision = { eventId: meta.eventId, timestamp: meta.timestamp };
      if (meta.source === 'remote' && !isNewerMediaRevision(revision, lastMediaRevisionRef.current)) return;
      lastMediaRevisionRef.current = revision;
    }

    if (eventType === 'cast') {
      updateMediaState(() => createMediaState(payload, null, payload.playing !== false, true, meta));
      return;
    }

    if (eventType === 'stop_cast') {
      updateMediaState(() => null);
      return;
    }

    if (eventType === 'subtitle_upload') {
      updateMediaState((current) => current ? {
        ...current,
        subtitleUrl: asString(payload.subtitleUrl, current.subtitleUrl ?? '') || null,
        controllerId: meta.senderId ?? current.controllerId,
        eventId: meta.eventId,
        eventTimestamp: meta.timestamp,
        source: meta.source,
        updatedAt: Date.now(),
      } : current);
      return;
    }

    if (eventType === 'force_sync') {
      updateMediaState((current) => createMediaState(
        payload,
        current,
        payload.playing === true,
        false,
        meta,
      ));
      return;
    }

    if (eventType === 'play' || eventType === 'pause' || eventType === 'seek' || eventType === 'mute') {
      updateMediaState((current) => {
        const nextPlaying = eventType === 'play'
          ? (typeof payload.playing === 'boolean' ? payload.playing : true)
          : eventType === 'pause'
            ? false
            : (current?.playing ?? false);
        return createMediaState(payload, current, nextPlaying, false, meta);
      });
    }
  }, [updateMediaState]);

  const applyTimerEvent = useCallback((eventType: SyncEventType, payload: Record<string, unknown>) => {
    if (eventType === 'timer_start') {
      const current = timerStateRef.current;
      const sessionId = asString(payload.sessionId, current.sessionId ?? '') || createEventId();
      updateTimerState({
        isRunning: true,
        endTime: asFiniteNumber(payload.endTime, Date.now()),
        remaining: Math.max(0, asFiniteNumber(payload.remaining, DEFAULT_TIMER.remaining)),
        duration: Math.max(0, asFiniteNumber(payload.duration, DEFAULT_TIMER.duration)),
        subject: asString(payload.subject, current.subject),
        sessionId,
        ownerId: asString(payload.ownerId, current.ownerId ?? '') || null,
        startedAt: asFiniteNumber(payload.startedAt, current.startedAt ?? Date.now()),
        segmentStartedAt: asFiniteNumber(payload.segmentStartedAt, Date.now()),
        elapsedSeconds: Math.max(0, asFiniteNumber(payload.elapsedSeconds, current.elapsedSeconds)),
        completed: false,
      });
    }
    if (eventType === 'timer_pause') {
      const current = timerStateRef.current;
      const completed = payload.completed === true;
      updateTimerState({
        isRunning: false,
        endTime: null,
        remaining: Math.max(0, asFiniteNumber(payload.remaining, 0)),
        duration: Math.max(0, asFiniteNumber(payload.duration, DEFAULT_TIMER.duration)),
        subject: asString(payload.subject, current.subject),
        sessionId: completed ? null : (asString(payload.sessionId, current.sessionId ?? '') || null),
        ownerId: completed ? null : (asString(payload.ownerId, current.ownerId ?? '') || null),
        startedAt: completed ? null : (asFiniteNumber(payload.startedAt, current.startedAt ?? 0) || null),
        segmentStartedAt: null,
        elapsedSeconds: Math.max(0, asFiniteNumber(payload.elapsedSeconds, current.elapsedSeconds)),
        completed,
      });
    }
    if (eventType === 'timer_reset') {
      const duration = Math.max(0, asFiniteNumber(payload.duration, DEFAULT_TIMER.duration));
      updateTimerState({
        ...DEFAULT_TIMER,
        isRunning: false,
        endTime: null,
        remaining: duration,
        duration,
        subject: typeof payload.subject === 'string' ? payload.subject.trim() : timerStateRef.current.subject,
        completed: false,
      });
    }
  }, [updateTimerState]);

  // The playable URL, title and subtitle are fetched under the receiver's
  // own authorization. A removed member's fetch fails, so nothing is applied.
  const applyResolvedMediaEvent = useCallback((
    eventType: SyncEventType,
    payload: Record<string, unknown>,
    meta: MediaEventMeta,
    compensateClock: boolean,
  ) => {
    const mediaId = payload.mediaId;
    if (typeof mediaId !== 'string') return;
    const eventRoomId = roomId;
    void resolveMedia(mediaId, eventType === 'subtitle_upload').then((media) => {
      if (!media || roomIdRef.current !== eventRoomId) return;
      // A playing state keeps advancing while the packet and the resolution
      // are in flight. Compensate on the receiving side.
      const time = compensateClock && payload.playing === true && typeof payload.time === 'number'
        ? payload.time + Math.max(0, (Date.now() - meta.timestamp) / 1_000)
        : payload.time;
      applyMediaEvent(eventType, {
        ...payload,
        ...(time === undefined ? {} : { time }),
        url: media.url,
        title: media.title,
        subtitleUrl: media.subtitleUrl,
        sourceType: media.sourceType,
      }, meta);
    });
  }, [applyMediaEvent, resolveMedia, roomId]);

  const handleIncomingEvent = useCallback((incoming: { payload?: unknown }) => {
    const event = incoming.payload;
    if (!isSyncEventPayload(event, roomId)) return;
    if (event.sender_id && event.sender_id === currentUserIdRef.current) return;
    // Apply only the wire contract. Extra fields (for example a URL from a
    // client that has not been updated yet) are ignored, never trusted.
    const payload = toRoomBroadcastPayload(event.event_type, event.payload);
    if (!payload) return;

    const snapshotType = snapshotTypeForEvent(event.event_type);
    if (snapshotType) {
      if (event.state_version <= stateVersionsRef.current[snapshotType]) return;
      stateVersionsRef.current[snapshotType] = event.state_version;
    }

    if (isRoomEventType(event.event_type)) {
      const roomEvent: RoomEvent = { type: event.event_type, payload, senderId: event.sender_id, local: false };
      roomEventListenersRef.current.forEach((listener) => listener(roomEvent));
      return;
    }

    if (event.event_type === 'typing') {
      setTypingUsers((current) => {
        const next = new Map(current);
        next.set(event.sender_id, Date.now());
        return next;
      });
      return;
    }

    if (event.event_type === 'request_sync') {
      setSyncRequestTrigger((current) => current + 1);
      return;
    }

    if (event.event_type === 'whiteboard_changed') {
      const version = payload.version as number;
      setWhiteboardVersion((current) => Math.max(current, version));
      return;
    }

    if (event.event_type === 'queue_changed') {
      setQueueVersion((current) => current + 1);
      return;
    }

    if (event.event_type === 'clips_changed') {
      setClipsVersion((current) => current + 1);
      return;
    }

    // Only the current controller's heartbeat counts; it never changes room
    // state, it only lets viewers correct drift locally.
    if (event.event_type === 'media_heartbeat') {
      const current = mediaStateRef.current;
      if (!current || (current.controllerId && current.controllerId !== event.sender_id)) return;
      if (payload.mediaId !== current.mediaId) return;
      setMediaHeartbeat({
        mediaId: payload.mediaId as string,
        castId: typeof payload.castId === 'string' ? payload.castId : null,
        time: payload.time as number,
        speed: typeof payload.speed === 'number' ? payload.speed : 1,
        playing: payload.playing === true,
        senderId: event.sender_id,
        receivedAt: Date.now(),
      });
      return;
    }

    if (event.event_type === 'timer_start' || event.event_type === 'timer_pause' || event.event_type === 'timer_reset') {
      applyTimerEvent(event.event_type, payload);
      return;
    }

    const meta: MediaEventMeta = {
      eventId: event.event_id,
      timestamp: event.timestamp,
      senderId: event.sender_id,
      source: 'remote',
    };

    if (event.event_type === 'stop_cast') {
      applyMediaEvent(event.event_type, payload, meta);
      return;
    }

    applyResolvedMediaEvent(event.event_type, payload, meta, event.event_type === 'force_sync');
  }, [applyMediaEvent, applyResolvedMediaEvent, applyTimerEvent, roomId]);

  // Persistent chat rows arrive through Postgres Changes. Realtime evaluates
  // the messages SELECT policy (room_has_capability 'chat') for each event and
  // each subscriber, so revocation takes effect on the next row. Room chat
  // uses soft-delete (UPDATE). DELETE events are never subscribed: Postgres
  // Changes does not RLS-filter them.
  const handleRoomMessageChange = useCallback((change: { eventType?: string; new?: Record<string, unknown> }) => {
    const row = change.new;
    if (!row || row.room_id !== roomId) return;
    if (change.eventType !== 'INSERT' && change.eventType !== 'UPDATE') return;
    const message: Record<string, unknown> = {};
    for (const field of ROOM_MESSAGE_FIELDS) {
      if (field in row) message[field] = row[field];
    }
    setRoomMessageEvents((current) => [
      ...current.slice(-99),
      { kind: change.eventType === 'INSERT' ? 'insert' : 'update', message },
    ]);
  }, [roomId]);

  const handleRoomControlEvent = useCallback((payload: { new?: Record<string, unknown> }) => {
    const event = payload.new;
    if (!event || event.room_id !== roomId || typeof event.id !== 'number' || typeof event.event_type !== 'string' || typeof event.created_at !== 'string') return;

    const controlEvent: RoomControlEvent = {
      id: event.id,
      roomId,
      eventType: event.event_type as RoomControlEvent['eventType'],
      subjectUserId: typeof event.subject_user_id === 'string' ? event.subject_user_id : null,
      payload: event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {},
      createdAt: event.created_at,
    };
    setRoomControlEvents((current) => current.some((item) => item.id === controlEvent.id)
      ? current
      : [...current.slice(-99), controlEvent]);
    setRoomControlVersion((current) => current + 1);
  }, [roomId]);

  const sendEvent = useCallback((eventType: SyncEventType, payload: Record<string, unknown>, meta?: Partial<MediaEventMeta>, stateVersion = 1) => {
    const channel = channelRefs.current[channelKindForEvent(eventType)];
    const senderId = currentUserIdRef.current;
    if (!channel || !senderId || connectionStateRef.current !== 'connected') return false;

    const event: SyncEvent = {
      event_id: meta?.eventId ?? createEventId(),
      sender_id: senderId,
      timestamp: meta?.timestamp ?? Date.now(),
      room_id: roomId,
      event_type: eventType,
      payload,
      state_version: stateVersion,
    };

    void channel.send({ type: 'broadcast', event: 'room_action', payload: event }).catch((error: unknown) => {
      console.error('Room sync broadcast failed:', error);
    });
    return true;
  }, [roomId]);

  const subscribeRoomEvents = useCallback((listener: RoomEventListener) => {
    roomEventListenersRef.current.add(listener);
    return () => { roomEventListenersRef.current.delete(listener); };
  }, []);

  // Only the wire contract is sent. Revision hints are also delivered to this
  // client's own listeners, so every local surface showing that data refreshes.
  const sendRoomEvent = useCallback((eventType: RoomEventType, payload: Record<string, unknown> = {}) => {
    const wirePayload = toRoomBroadcastPayload(eventType, payload);
    if (!wirePayload) return false;
    if ((eventType === 'study_changed' || eventType === 'collab_changed') && currentUserIdRef.current) {
      const localEvent: RoomEvent = { type: eventType, payload: wirePayload, senderId: currentUserIdRef.current, local: true };
      roomEventListenersRef.current.forEach((listener) => listener(localEvent));
    }
    return sendEvent(eventType, wirePayload);
  }, [sendEvent]);

  const flushPendingEvents = useCallback(() => {
    if (!currentUserIdRef.current || connectionStateRef.current !== 'connected') return;
    const queuedEvents = pendingEventsRef.current.splice(0);
    queuedEvents.forEach(({ eventType, payload, meta }) => sendEvent(eventType, payload, meta));
  }, [sendEvent]);

  const broadcastEvent = useCallback((eventType: SyncEventType, payload: Record<string, unknown> = {}) => {
    const eventPayload = eventType === 'cast'
      ? { ...payload, castId: asString(payload.castId, createEventId()) }
      : payload;
    if (isMediaEvent(eventType) && !canControlMedia) return;
    if (eventType === 'media_heartbeat' && !canControlMedia) return;
    if (eventType === 'queue_changed') setQueueVersion((current) => current + 1);
    if (eventType === 'clips_changed') setClipsVersion((current) => current + 1);
    const meta: MediaEventMeta = {
      eventId: createEventId(),
      timestamp: Date.now(),
      senderId: currentUserIdRef.current ?? undefined,
      source: 'local',
    };
    const snapshotType = snapshotTypeForEvent(eventType);

    // Update the local room state immediately with the full payload (this
    // client already holds the URL). This keeps the cast responsive even if
    // the Realtime handshake is still finishing.
    applyMediaEvent(eventType, eventPayload, meta);
    applyTimerEvent(eventType, eventPayload);
    if (eventType === 'subtitle_upload' && typeof eventPayload.mediaId === 'string') {
      mediaResolutionRef.current.delete(eventPayload.mediaId);
    }

    if (!roomId) return;
    // Only the wire contract leaves this client, over Broadcast or in the
    // persisted snapshot: never chat text, titles, URLs or storage paths
    // (src/lib/room-broadcast-contract.ts).
    const wirePayload = toRoomBroadcastPayload(eventType, eventPayload);
    if (!wirePayload) {
      console.warn(`Room ${eventType} was not shared: media events need a registered mediaId.`);
      return;
    }
    const emit = (stateVersion: number) => {
      if (!sendEvent(eventType, wirePayload, meta, stateVersion)) {
        // Only sync requests are safe to replay. Persistent state is saved via
        // the authorized snapshot RPC and must never be retried as stale input.
        if (eventType === 'request_sync') pendingEventsRef.current.push({ eventType, payload: wirePayload, meta });
      }
    };

    if (snapshotType) {
      // The server allocates the version while serializing the snapshot row.
      // Broadcast only after that authoritative version is known.
      void saveRoomRealtimeSnapshot(roomId, snapshotType, 1, { eventType, payload: wirePayload }).then(unwrapAction)
        .then((result) => {
          const authoritativeVersion = result?.state_version;
          if (!authoritativeVersion || !Number.isSafeInteger(authoritativeVersion)) return;
          stateVersionsRef.current[snapshotType] = Math.max(
            stateVersionsRef.current[snapshotType],
            authoritativeVersion,
          );
          emit(authoritativeVersion);
        })
        .catch((error: unknown) => {
          console.error('Room snapshot write failed:', error);
        });
      return;
    }

    emit(1);
  }, [applyMediaEvent, applyTimerEvent, canControlMedia, roomId, sendEvent]);

  // Keep late joiners in sync even while the host has temporarily switched to
  // Study or another room tool and the player component is unmounted.
  useEffect(() => {
    if (syncRequestTrigger === 0) return;
    const current = mediaStateRef.current;
    // A restored snapshot is not allowed to answer a join request. Only the
    // active controller may relay the live snapshot; allowing another client
    // to rebroadcast its older remote copy could turn stale state into a new
    // revision and overwrite the room timeline.
    if (!current || current.source === 'restored' || !currentUserIdRef.current) return;
    if (current.controllerId && current.controllerId !== currentUserIdRef.current) return;
    if (current.source === 'local' && !canControlMedia) return;

    // Late joiners receive only the media id and playback state, then resolve
    // the URL themselves. Media cast without a registered id is not relayed.
    const wirePayload = toRoomBroadcastPayload('force_sync', {
      time: current.time,
      speed: current.speed,
      playing: current.playing,
      sourceType: current.sourceType,
      castId: current.castId,
      mediaId: current.mediaId,
      muted: current.muted,
      volume: current.volume,
      controllerId: current.controllerId,
    });
    if (wirePayload) sendEvent('force_sync', wirePayload);
  }, [canControlMedia, sendEvent, syncRequestTrigger]);

  useEffect(() => {
    let isActive = true;
    roomIdRef.current = roomId;
    mediaResolutionRef.current = new Map();
    const stored = normalizeMediaState(readSessionValue<Partial<RoomMediaState> | null>(mediaStorageKey(roomId), null));
    // A stored state without a registered media id cannot be re-authorized,
    // so it is dropped rather than replaying a cached URL.
    const restoredMedia = stored?.mediaId ? stored : null;
    if (stored && !restoredMedia) removeSessionValue(mediaStorageKey(roomId));
    mediaStateRef.current = restoredMedia;
    lastMediaRevisionRef.current = null;
    stateVersionsRef.current = { media: 0, timer: 0 };
    pendingEventsRef.current = [];

    const restoreTimer = window.setTimeout(() => {
      if (!isActive) return;
      setMediaState(restoredMedia);
      const restoredTimer = normalizeTimerState(readSessionValue<Partial<TimerState>>(timerStorageKey(roomId), DEFAULT_TIMER));
      timerStateRef.current = restoredTimer;
      setTimerState(restoredTimer);
      setTypingUsers(new Map());
      setRoomMessageEvents([]);
      setRoomControlEvents([]);
      setRoomControlVersion(0);
      setRoomActivityVersion(0);
      setConnectionGeneration(0);
      setWhiteboardVersion(0);
      setMediaHeartbeat(null);
      setQueueVersion(0);
      setClipsVersion(0);
    }, 0);

    // Refresh the restored URL under current authorization: signed URLs
    // expire, and a user who lost access must not keep playing from cache.
    const restoredMediaId = restoredMedia?.mediaId;
    if (roomId && restoredMediaId) {
      void resolveMedia(restoredMediaId, true).then((media) => {
        if (!isActive) return;
        updateMediaState((current) => {
          if (!current || current.source !== 'restored' || current.mediaId !== restoredMediaId) return current;
          return media ? { ...current, url: media.url, title: media.title, subtitleUrl: media.subtitleUrl, sourceType: media.sourceType } : null;
        });
      });
    }

    return () => {
      isActive = false;
      window.clearTimeout(restoreTimer);
    };
  }, [resolveMedia, roomId, updateMediaState]);

  useEffect(() => {
    let cancelled = false;
    if (!roomId) return () => { cancelled = true; };

    void getRoomRealtimeSnapshots(roomId).then(unwrapAction).then((snapshots) => {
      if (cancelled) return;
      (snapshots as RealtimeSnapshot[]).forEach((snapshot) => {
        const snapshotType = snapshot.snapshot_type === 'media' || snapshot.snapshot_type === 'timer'
          ? snapshot.snapshot_type
          : null;
        if (!snapshotType) return;
        const snapshotVersion = Number(snapshot.state_version);
        if (!Number.isSafeInteger(snapshotVersion) || snapshotVersion <= stateVersionsRef.current[snapshotType]) return;
        const value = snapshot.payload;
        if (!value || typeof value !== 'object' || Array.isArray(value)) return;
        const record = value as Record<string, unknown>;
        const eventType = record.eventType;
        const payload = record.payload;
        if (!isRoomBroadcastEventType(eventType)) return;
        // Snapshots written by older clients may hold URLs or titles; only the
        // wire contract is applied, exactly as for a live Broadcast.
        const wirePayload = toRoomBroadcastPayload(eventType, payload);
        if (!wirePayload) return;
        stateVersionsRef.current[snapshotType] = snapshotVersion;
        if (snapshotType === 'timer') {
          applyTimerEvent(eventType, wirePayload);
          return;
        }
        const meta: MediaEventMeta = {
          eventId: `snapshot:${snapshotType}:${snapshotVersion}`,
          timestamp: new Date(snapshot.updated_at).getTime(),
          source: 'restored',
        };
        if (eventType === 'stop_cast') applyMediaEvent(eventType, wirePayload, meta);
        else applyResolvedMediaEvent(eventType, wirePayload, meta, false);
      });
    }).catch(() => undefined);

    return () => { cancelled = true; };
  }, [applyMediaEvent, applyResolvedMediaEvent, applyTimerEvent, roomId]);

  useEffect(() => {
    let isMounted = true;
    const readyChannels = new Set<RoomChannelKind>();
    const previousChannels = Object.values(channelRefs.current);
    previousChannels.forEach((channel) => {
      if (channel) {
        void channel.unsubscribe();
        void supabase.removeChannel(channel);
      }
    });
    channelRefs.current = { general: null, chat: null, study: null, watch: null, control: null };

    currentUserIdRef.current = null;
    pendingEventsRef.current = [];

    if (!roomId) {
      connectionStateRef.current = 'idle';
      const idleTimer = window.setTimeout(() => {
        if (isMounted) setConnectionState('idle');
      }, 0);
      return () => {
        isMounted = false;
        window.clearTimeout(idleTimer);
      };
    }

    connectionStateRef.current = 'connecting';
    const connectingTimer = window.setTimeout(() => {
      if (isMounted) setConnectionState('connecting');
    }, 0);
    const channels: Array<{ kind: RoomChannelKind; channel: RoomChannel }> = [
      {
        kind: 'general',
        channel: supabase.channel(`sync:${roomId}`, { config: { private: true } }),
      },
      {
        kind: 'chat',
        channel: supabase.channel(`sync-chat:${roomId}`, { config: { private: true } }),
      },
      {
        kind: 'study',
        channel: supabase.channel(`sync-study:${roomId}`, { config: { private: true } }),
      },
      {
        kind: 'watch',
        channel: supabase.channel(`sync-watch:${roomId}`, { config: { private: true } }),
      },
      {
        kind: 'control',
        channel: supabase.channel(`sync-control:${roomId}`, { config: { private: true } }),
      },
    ];

    channels.forEach(({ kind, channel }) => {
      channelRefs.current[kind] = channel;
      channel.on('broadcast', { event: 'room_action' }, handleIncomingEvent);
      if (kind === 'general') {
        channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_control_events', filter: `room_id=eq.${roomId}` }, handleRoomControlEvent);
        channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_activity', filter: `room_id=eq.${roomId}` }, () => {
          if (isMounted) setRoomActivityVersion((current) => current + 1);
        });
        channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `room_id=eq.${roomId}` }, handleRoomMessageChange);
        channel.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `room_id=eq.${roomId}` }, handleRoomMessageChange);
        // Postgres Changes starts delivering only after this system message,
        // which arrives some time after SUBSCRIBED (and again after every
        // rejoin). Rows committed before it are never replayed, so chat
        // re-reads the newest page through RLS each time the feed is ready.
        channel.on('system', {}, (message: { extension?: string; status?: string }) => {
          if (isMounted && message?.extension === 'postgres_changes' && message.status === 'ok') {
            setConnectionGeneration((current) => current + 1);
          }
        });
      }
      channel.subscribe((status: string) => {
        if (!isMounted) return;
        if (status === 'SUBSCRIBED') {
          readyChannels.add(kind);
          if (readyChannels.size === channels.length) {
            connectionStateRef.current = 'connected';
            setConnectionState('connected');
            flushPendingEvents();
          }
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          connectionStateRef.current = 'error';
          setConnectionState('error');
        }
      });
    });

    void (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!isMounted) return;
      currentUserIdRef.current = user?.id ?? null;
      setCurrentUserId(user?.id ?? null);
      flushPendingEvents();
    })();

    return () => {
      isMounted = false;
      window.clearTimeout(connectingTimer);
      readyChannels.clear();
      channelRefs.current = { general: null, chat: null, study: null, watch: null, control: null };
      connectionStateRef.current = 'idle';
      channels.forEach(({ channel }) => {
        void channel.unsubscribe();
        void supabase.removeChannel(channel);
      });
    };
  }, [flushPendingEvents, handleIncomingEvent, handleRoomControlEvent, handleRoomMessageChange, roomId, supabase]);

  useEffect(() => {
    const typingInterval = window.setInterval(() => {
      setTypingUsers((current) => {
        const next = new Map(current);
        let changed = false;
        next.forEach((timestamp, id) => {
          if (Date.now() - timestamp > 3_000) {
            next.delete(id);
            changed = true;
          }
        });
        return changed ? next : current;
      });
    }, 1_000);

    return () => window.clearInterval(typingInterval);
  }, []);

  return {
    sendRoomEvent,
    subscribeRoomEvents,
    currentUserId,
    canControlMedia,
    connectionState,
    typingUsers,
    mediaState,
    activeMediaUrl: mediaState?.url ?? null,
    activeSubtitleUrl: mediaState?.subtitleUrl ?? null,
    timerState,
    syncRequestTrigger,
    roomMessageEvents,
    roomControlEvents,
    roomControlVersion,
    roomActivityVersion,
    connectionGeneration,
    whiteboardVersion,
    mediaHeartbeat,
    queueVersion,
    clipsVersion,
    recordMediaTime,
    broadcastEvent,
  };
}
