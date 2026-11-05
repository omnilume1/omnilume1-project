'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/utils/supabase/client';
import { useRoomRealtime } from '@/components/room/RoomRealtimeProvider';
import { loadMemberNames } from '@/lib/watch-queue-data';
import { STUDY_CHANGE_KINDS, type COLLAB_CHANGE_KINDS } from '@/lib/room-broadcast-contract';

export type StudyChangeKind = (typeof STUDY_CHANGE_KINDS)[number];
export type CollabChangeKind = (typeof COLLAB_CHANGE_KINDS)[number];
export type ChangeKind = StudyChangeKind | CollabChangeKind;

// Runs `load` on mount, whenever a member announces a change of one of
// `kinds`, and after every Realtime rejoin (hints sent while offline are not
// replayed). Contents are always re-read through RLS/RPC, never taken from
// the hint.
export function useHintedLoad(kinds: readonly ChangeKind[], load: () => void) {
  const { subscribeRoomEvents, connectionGeneration } = useRoomRealtime();
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; });
  const key = kinds.join(',');
  useEffect(() => {
    const wanted = new Set(key.split(','));
    return subscribeRoomEvents((event) => {
      if ((event.type === 'study_changed' || event.type === 'collab_changed') && wanted.has(String(event.payload.kind))) loadRef.current();
    });
  }, [key, subscribeRoomEvents]);
  useEffect(() => {
    const timeout = window.setTimeout(() => loadRef.current(), 0);
    return () => window.clearTimeout(timeout);
  }, [connectionGeneration]);
}

// Tells every member (and this client's other surfaces) to re-read `kind`.
export function useAnnounce() {
  const { sendRoomEvent } = useRoomRealtime();
  return useCallback((kind: ChangeKind) => {
    const type = (STUDY_CHANGE_KINDS as readonly string[]).includes(kind) ? 'study_changed' : 'collab_changed';
    sendRoomEvent(type, { version: Date.now(), kind });
  }, [sendRoomEvent]);
}

export type RoomCapabilities = {
  loaded: boolean;
  chat: boolean;
  study: boolean;
  watch: boolean;
  manageMembers: boolean;
  manageAnnouncements: boolean;
};

const NO_CAPABILITIES: RoomCapabilities = { loaded: false, chat: false, study: false, watch: false, manageMembers: false, manageAnnouncements: false };

// The caller's own capabilities, for showing/hiding controls only. Every RPC
// re-checks them server-side, so hiding a control is never the security.
export function useRoomCapabilities(roomId: string): RoomCapabilities {
  const { currentUserId, roomControlVersion } = useRoomRealtime();
  const [capabilities, setCapabilities] = useState<RoomCapabilities>(NO_CAPABILITIES);
  useEffect(() => {
    if (!currentUserId) return;
    let active = true;
    const supabase = createClient();
    const check = async (capability: string) => {
      const { data } = await supabase.rpc('room_has_capability', { p_room_id: roomId, p_user_id: currentUserId, p_capability: capability });
      return data === true;
    };
    void Promise.all(['chat', 'study', 'watch', 'manage_members', 'manage_announcements'].map(check)).then(([chat, study, watch, manageMembers, manageAnnouncements]) => {
      if (active) setCapabilities({ loaded: true, chat, study, watch, manageMembers, manageAnnouncements });
    });
    return () => { active = false; };
  }, [currentUserId, roomControlVersion, roomId]);
  return capabilities;
}

export function useMemberNames(roomId: string) {
  const { roomControlVersion } = useRoomRealtime();
  const [names, setNames] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    let active = true;
    void loadMemberNames(roomId).then((next) => { if (active) setNames(next); });
    return () => { active = false; };
  }, [roomControlVersion, roomId]);
  return names;
}

export function formatDuration(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
