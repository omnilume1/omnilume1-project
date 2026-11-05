'use client';

import { unwrapAction } from '@/lib/action-result';
import { useEffect, useState } from 'react';
import { getMyRoomPresenceMode } from '@/actions/room-controls';
import { createClient } from '@/utils/supabase/client';

export type RoomPresenceUser = { user_id: string; online_at: string };

export type RoomPresenceValue = {
  onlineUsers: RoomPresenceUser[];
  onlineUserIds: string[];
  isGhostMode: boolean;
  canViewGhostPresence: boolean;
};

function uniqueUsers(users: RoomPresenceUser[]) {
  const byId = new Map<string, RoomPresenceUser>();
  users.forEach((user) => {
    if (user?.user_id) byId.set(user.user_id, user);
  });
  return [...byId.values()];
}

export function useRoomPresence(roomId: string, refreshKey = 0): RoomPresenceValue {
  const supabase = createClient();
  const [onlineUsers, setOnlineUsers] = useState<RoomPresenceUser[]>([]);
  const [isGhostMode, setIsGhostMode] = useState(false);
  const [canViewGhostPresence, setCanViewGhostPresence] = useState(false);

  useEffect(() => {
    let isMounted = true;
    const channels: Array<ReturnType<typeof supabase.channel>> = [];

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
      setOnlineUsers([]);

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
        const users = channels.flatMap((channel) => Object.values(channel.presenceState()).flat() as RoomPresenceUser[]);
        setOnlineUsers(uniqueUsers(users));
      };

      channels.forEach((channel) => {
        channel.on('presence', { event: 'sync' }, refresh);
        channel.subscribe(async (status: string) => {
          if (status !== 'SUBSCRIBED' || !isMounted) return;
          const isPrivateScope = channel === privilegedChannel;
          if ((ghostMode && isPrivateScope) || (!ghostMode && !isPrivateScope)) {
            await channel.track({ user_id: user.id, online_at: new Date().toISOString() }).catch(() => undefined);
          }
        });
      });
    };

    void connect().catch(() => undefined);

    return () => {
      isMounted = false;
      channels.forEach((channel) => {
        void channel.unsubscribe();
        void supabase.removeChannel(channel);
      });
    };
  }, [refreshKey, roomId, supabase]);

  return {
    onlineUsers: roomId ? onlineUsers : [],
    onlineUserIds: roomId ? onlineUsers.map((user) => user.user_id) : [],
    isGhostMode: roomId ? isGhostMode : false,
    canViewGhostPresence: roomId ? canViewGhostPresence : false,
  };
}
