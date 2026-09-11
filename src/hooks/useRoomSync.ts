'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/utils/supabase/client';

type BrowserSupabaseClient = ReturnType<typeof createClient>;
type RoomChannel = ReturnType<BrowserSupabaseClient['channel']>;

export type SyncEventType =
  | 'typing'
  | 'room_message'
  | 'room_message_update'
  | 'play'
  | 'pause'
  | 'seek'
  | 'mute'
  | 'cast'
  | 'stop_cast'
  | 'force_sync'
  | 'request_sync'
  | 'timer_start'
  | 'timer_pause'
  | 'timer_reset'
  | 'subtitle_upload';

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
  recordMediaTime: (time: number) => void;
  broadcastEvent: (eventType: SyncEventType, payload?: Record<string, unknown>) => void;
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
  eventType: 'membership_changed' | 'role_changed' | 'invite_changed' | 'restriction_changed' | 'ownership_changed' | 'settings_changed' | 'lock_changed' | 'announcement_changed' | 'guest_changed' | 'feature_changed';
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

type MediaRevision = Pick<MediaEventMeta, 'eventId' | 'timestamp'>;

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
  const channelRef = useRef<RoomChannel | null>(null);
  const pendingEventsRef = useRef<Array<{ eventType: SyncEventType; payload: Record<string, unknown>; meta: MediaEventMeta }>>([]);

  const [typingUsers, setTypingUsers] = useState<Map<string, number>>(new Map());
  const [mediaState, setMediaState] = useState<RoomMediaState | null>(() =>
    normalizeMediaState(readSessionValue<Partial<RoomMediaState> | null>(mediaStorageKey(roomId), null)),
  );
  const mediaStateRef = useRef<RoomMediaState | null>(mediaState);
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

  const handleIncomingEvent = useCallback((incoming: { payload?: Partial<SyncEvent> }) => {
    const event = incoming.payload;
    if (!event || event.room_id !== roomId || !event.event_type) return;
    if (event.sender_id && event.sender_id === currentUserIdRef.current) return;

    if (event.event_type === 'typing') {
      if (event.sender_id) {
        setTypingUsers((current) => {
          const next = new Map(current);
          next.set(event.sender_id as string, Date.now());
          return next;
        });
      }
      return;
    }

    if (event.event_type === 'room_message' || event.event_type === 'room_message_update') {
      const message = (event.payload ?? {}).message;
      if (message && typeof message === 'object' && !Array.isArray(message)) {
        setRoomMessageEvents((current) => [
          ...current.slice(-99),
          {
            kind: event.event_type === 'room_message' ? 'insert' : 'update',
            message: message as Record<string, unknown>,
          },
        ]);
      }
      return;
    }

    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (event.event_type === 'request_sync') {
      setSyncRequestTrigger((current) => current + 1);
      return;
    }

    // A playing state continues advancing while the force_sync packet is in
    // flight. Compensate for that small network delay on the receiving side.
    const adjustedPayload = event.event_type === 'force_sync'
      && payload.playing === true
      && typeof payload.time === 'number'
      && typeof event.timestamp === 'number'
      ? { ...payload, time: payload.time + Math.max(0, (Date.now() - event.timestamp) / 1_000) }
      : payload;

    applyMediaEvent(event.event_type, adjustedPayload, {
      eventId: typeof event.event_id === 'string' && event.event_id
        ? event.event_id
        : `${event.sender_id ?? 'unknown'}:${event.timestamp ?? 0}:${event.event_type}`,
      timestamp: typeof event.timestamp === 'number' && Number.isFinite(event.timestamp) ? event.timestamp : 0,
      senderId: event.sender_id,
      source: 'remote',
    });
    applyTimerEvent(event.event_type, adjustedPayload);
  }, [applyMediaEvent, applyTimerEvent, roomId]);

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

  const sendEvent = useCallback((eventType: SyncEventType, payload: Record<string, unknown>, meta?: Partial<MediaEventMeta>) => {
    const channel = channelRef.current;
    const senderId = currentUserIdRef.current;
    if (!channel || !senderId || connectionStateRef.current !== 'connected') return false;

    const event: SyncEvent = {
      event_id: meta?.eventId ?? createEventId(),
      sender_id: senderId,
      timestamp: meta?.timestamp ?? Date.now(),
      room_id: roomId,
      event_type: eventType,
      payload,
      state_version: 1,
    };

    void channel.send({ type: 'broadcast', event: 'room_action', payload: event }).catch((error: unknown) => {
      console.error('Room sync broadcast failed:', error);
    });
    return true;
  }, [roomId]);

  const flushPendingEvents = useCallback(() => {
    if (!channelRef.current || !currentUserIdRef.current || connectionStateRef.current !== 'connected') return;
    const queuedEvents = pendingEventsRef.current.splice(0);
    queuedEvents.forEach(({ eventType, payload, meta }) => sendEvent(eventType, payload, meta));
  }, [sendEvent]);

  const broadcastEvent = useCallback((eventType: SyncEventType, payload: Record<string, unknown> = {}) => {
    const eventPayload = eventType === 'cast'
      ? { ...payload, castId: asString(payload.castId, createEventId()) }
      : payload;
    const meta: MediaEventMeta = {
      eventId: createEventId(),
      timestamp: Date.now(),
      senderId: currentUserIdRef.current ?? undefined,
      source: 'local',
    };

    // Update the local room state immediately. This keeps the cast responsive
    // even if the Realtime handshake is still finishing.
    applyMediaEvent(eventType, eventPayload, meta);
    applyTimerEvent(eventType, eventPayload);

    if (!roomId) return;
    if (!sendEvent(eventType, eventPayload, meta)) {
      pendingEventsRef.current.push({ eventType, payload: eventPayload, meta });
    }
  }, [applyMediaEvent, applyTimerEvent, roomId, sendEvent]);

  // Keep late joiners in sync even while the host has temporarily switched to
  // Study or another room tool and the player component is unmounted.
  useEffect(() => {
    if (syncRequestTrigger === 0) return;
    const current = mediaStateRef.current;
    // A restored snapshot is not allowed to answer a join request. Any
    // connected client with a live room snapshot may relay it, which lets an
    // owner rejoin without having their stale browser state win the race.
    if (!current || current.source === 'restored' || !currentUserIdRef.current) return;
    if (current.source === 'local' && !canControlMedia) return;

    sendEvent('force_sync', {
      url: current.url,
      subtitleUrl: current.subtitleUrl,
      title: current.title,
      time: current.time,
      speed: current.speed,
      playing: current.playing,
      sourceType: current.sourceType,
      castId: current.castId,
      mediaId: current.mediaId,
      muted: current.muted,
      controllerId: current.controllerId,
    });
  }, [canControlMedia, sendEvent, syncRequestTrigger]);

  useEffect(() => {
    let isActive = true;
    const restoredMedia = normalizeMediaState(readSessionValue<Partial<RoomMediaState> | null>(mediaStorageKey(roomId), null));
    mediaStateRef.current = restoredMedia;
    lastMediaRevisionRef.current = null;
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
    }, 0);

    return () => {
      isActive = false;
      window.clearTimeout(restoreTimer);
    };
  }, [roomId]);

  useEffect(() => {
    let isMounted = true;
    const previousChannel = channelRef.current;
    if (previousChannel) {
      void previousChannel.unsubscribe();
      void supabase.removeChannel(previousChannel);
      channelRef.current = null;
    }

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
    const syncChannel = supabase.channel(`sync:${roomId}`);
    channelRef.current = syncChannel;

    syncChannel
      .on('broadcast', { event: 'room_action' }, handleIncomingEvent)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_control_events', filter: `room_id=eq.${roomId}` }, handleRoomControlEvent)
      .subscribe((status: string) => {
        if (!isMounted) return;
        if (status === 'SUBSCRIBED') {
          connectionStateRef.current = 'connected';
          setConnectionState('connected');
          flushPendingEvents();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          connectionStateRef.current = 'error';
          setConnectionState('error');
        }
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
      if (channelRef.current === syncChannel) channelRef.current = null;
      connectionStateRef.current = 'idle';
      void syncChannel.unsubscribe();
      void supabase.removeChannel(syncChannel);
    };
  }, [flushPendingEvents, handleIncomingEvent, handleRoomControlEvent, roomId, supabase]);

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
    currentUserId,
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
    recordMediaTime,
    broadcastEvent,
  };
}
