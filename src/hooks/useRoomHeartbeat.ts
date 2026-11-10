'use client';

import { useCallback, useEffect, useRef } from 'react';
import {
  HEARTBEAT_INTERVAL_MS,
  SPOT_CHANGE_DEBOUNCE_MS,
  heartbeatArgs,
  heartbeatLeader,
  heartbeatPaused,
  liveStatusKey,
  type LivePresenceUser,
} from '@/lib/room-live-status';
import { createClient } from '@/utils/supabase/client';

// Phase 03: the lowest user id on the public presence channel reports the
// room's live counts every 60 s, and 3 s (debounced) after any spot or door
// change. Ghosts are never on that channel, so they are never counted and
// never lead (§0.9). Paused once the tab has been hidden for 2+ minutes.
// Uses the browser client's rpc, not a server action (§0.8).
export function useRoomHeartbeat(roomId: string, selfId: string | null, publicUsers: LivePresenceUser[]) {
  const isLeader = Boolean(roomId && selfId && heartbeatLeader(publicUsers) === selfId);
  const statusKey = liveStatusKey(publicUsers);
  const usersRef = useRef(publicUsers);
  const hiddenSinceRef = useRef<number | null>(null);

  useEffect(() => {
    usersRef.current = publicUsers;
  }, [publicUsers]);

  useEffect(() => {
    const update = () => {
      hiddenSinceRef.current = document.hidden ? (hiddenSinceRef.current ?? Date.now()) : null;
    };
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  const send = useCallback(async () => {
    if (heartbeatPaused(hiddenSinceRef.current, Date.now())) return;
    try {
      await createClient().rpc('room_heartbeat', heartbeatArgs(roomId, usersRef.current));
    } catch {
      // Best effort: the next beat retries.
    }
  }, [roomId]);

  useEffect(() => {
    if (!isLeader) return;
    const interval = window.setInterval(() => void send(), HEARTBEAT_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [isLeader, send]);

  // Also covers becoming the leader: the first beat goes out 3 s later.
  useEffect(() => {
    if (!isLeader) return;
    const timeout = window.setTimeout(() => void send(), SPOT_CHANGE_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [isLeader, send, statusKey]);
}
