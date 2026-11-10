'use client';

import { unwrapAction } from '@/lib/action-result';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getMyRoomPresenceMode } from '@/actions/room-controls';
import { useRoomHeartbeat } from '@/hooks/useRoomHeartbeat';
import { DEFAULT_DOOR, DEFAULT_SPOT, normalizeDoor, normalizeSpot, type RoomDoor, type RoomSpot } from '@/lib/room-live-status';
import { createClient } from '@/utils/supabase/client';

export type RoomPresenceUser = { user_id: string; online_at: string; spot?: RoomSpot; door?: RoomDoor };

export type RoomPresenceValue = {
  // Merged list: ghost auditors also see ghosts here.
  onlineUsers: RoomPresenceUser[];
  onlineUserIds: string[];
  // The public channel only. Every count, light, spot, name, card and
  // drop-in reads this list, never onlineUsers (roadmap §0.9).
  publicUsers: RoomPresenceUser[];
  mySpot: RoomSpot;
  myDoor: RoomDoor;
  setSpot: (spot: RoomSpot) => void;
  setDoor: (door: RoomDoor) => void;
  isGhostMode: boolean;
  canViewGhostPresence: boolean;
};

type PresenceChannel = ReturnType<ReturnType<typeof createClient>['channel']>;

function uniqueUsers(users: RoomPresenceUser[]) {
  const byId = new Map<string, RoomPresenceUser>();
  users.forEach((user) => {
    if (user?.user_id) byId.set(user.user_id, user);
  });
  return [...byId.values()];
}

function channelUsers(channel: PresenceChannel) {
  return Object.values(channel.presenceState()).flat() as unknown as RoomPresenceUser[];
}

export function useRoomPresence(roomId: string, refreshKey = 0): RoomPresenceValue {
  const supabase = createClient();
  const [onlineUsers, setOnlineUsers] = useState<RoomPresenceUser[]>([]);
  const [publicUsers, setPublicUsers] = useState<RoomPresenceUser[]>([]);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [mySpot, setMySpot] = useState<RoomSpot>(DEFAULT_SPOT);
  const [myDoor, setMyDoor] = useState<RoomDoor>(DEFAULT_DOOR);
  const [isGhostMode, setIsGhostMode] = useState(false);
  const [canViewGhostPresence, setCanViewGhostPresence] = useState(false);
  // What this browser tracks, and on which channel (public, or the
  // privileged one for ghosts), so setSpot/setDoor can re-track.
  const trackedRef = useRef<{ channel: PresenceChannel; userId: string; onlineAt: string } | null>(null);
  const spotRef = useRef<RoomSpot>(DEFAULT_SPOT);
  const doorRef = useRef<RoomDoor>(DEFAULT_DOOR);

  const retrack = useCallback(() => {
    const tracked = trackedRef.current;
    if (!tracked) return;
    void tracked.channel.track({ user_id: tracked.userId, online_at: tracked.onlineAt, spot: spotRef.current, door: doorRef.current }).catch(() => undefined);
  }, []);

  const setSpot = useCallback((spot: RoomSpot) => {
    spotRef.current = normalizeSpot(spot);
    setMySpot(spotRef.current);
    retrack();
  }, [retrack]);

  const setDoor = useCallback((door: RoomDoor) => {
    doorRef.current = normalizeDoor(door);
    setMyDoor(doorRef.current);
    retrack();
  }, [retrack]);

  useEffect(() => {
    let isMounted = true;
    const channels: PresenceChannel[] = [];

    if (!roomId) return () => { isMounted = false; };

    const connect = async () => {
      const [{ data: { user } }, mode] = await Promise.all([
        supabase.auth.getUser(),
        getMyRoomPresenceMode(roomId).then(unwrapAction),
      ]);
      if (!isMounted || !user) return;

      const ghostMode = mode.is_ghost_mode === true;
      const canAuditGhostPresence = mode.can_view_ghost_presence === true;
      setIsGhostMode(ghostMode);
      setCanViewGhostPresence(canAuditGhostPresence);
      setSelfId(user.id);
      setOnlineUsers([]);
      setPublicUsers([]);

      const publicChannel = supabase.channel(`presence:${roomId}`, {
        config: { private: true, presence: { key: user.id } },
      });
      channels.push(publicChannel);

      const privilegedChannel = canAuditGhostPresence
        ? supabase.channel(`presence-privileged:${roomId}`, {
          config: { private: true, presence: { key: user.id } },
        })
        : null;
      if (privilegedChannel) channels.push(privilegedChannel);

      const refresh = () => {
        if (!isMounted) return;
        setOnlineUsers(uniqueUsers(channels.flatMap(channelUsers)));
        setPublicUsers(uniqueUsers(channelUsers(publicChannel)));
      };

      channels.forEach((channel) => {
        channel.on('presence', { event: 'sync' }, refresh);
        channel.subscribe(async (status: string) => {
          if (status !== 'SUBSCRIBED' || !isMounted) return;
          const isPrivateScope = channel === privilegedChannel;
          // Ghosts track only on the privileged channel, never the public one.
          if ((ghostMode && isPrivateScope) || (!ghostMode && !isPrivateScope)) {
            trackedRef.current = { channel, userId: user.id, onlineAt: new Date().toISOString() };
            await channel.track({
              user_id: user.id,
              online_at: trackedRef.current.onlineAt,
              spot: spotRef.current,
              door: doorRef.current,
            }).catch(() => undefined);
          }
        });
      });
    };

    void connect().catch(() => undefined);

    return () => {
      isMounted = false;
      trackedRef.current = null;
      channels.forEach((channel) => {
        void channel.unsubscribe();
        void supabase.removeChannel(channel);
      });
    };
  }, [refreshKey, roomId, supabase]);

  const visiblePublicUsers = roomId ? publicUsers : [];
  useRoomHeartbeat(roomId, selfId, visiblePublicUsers);

  return {
    onlineUsers: roomId ? onlineUsers : [],
    onlineUserIds: roomId ? onlineUsers.map((user) => user.user_id) : [],
    publicUsers: visiblePublicUsers,
    mySpot,
    myDoor,
    setSpot,
    setDoor,
    isGhostMode: roomId ? isGhostMode : false,
    canViewGhostPresence: roomId ? canViewGhostPresence : false,
  };
}
