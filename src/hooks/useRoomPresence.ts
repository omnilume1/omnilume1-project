'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/utils/supabase/client';

export function useRoomPresence(roomId: string) {
  const supabase = createClient();
  const [onlineUsers, setOnlineUsers] = useState<Array<{ user_id: string; online_at: string }>>([]);
  // FIX: Added onlineUserIds to prevent the MembersTab .length crash
  const [onlineUserIds, setOnlineUserIds] = useState<string[]>([]);

  useEffect(() => {
    let isMounted = true;
    const presenceChannel = supabase.channel(`presence:${roomId}`, {
      config: { presence: { key: roomId } },
    });

    presenceChannel
      .on('presence', { event: 'sync' }, () => {
        if (!isMounted) return;
        const state = presenceChannel.presenceState();
        const users = Object.values(state).flat() as Array<{ user_id: string; online_at: string }>;
        setOnlineUsers(users);
        setOnlineUserIds(users.map((u) => u.user_id));
      })
      .on('presence', { event: 'join' }, () => {})
      .on('presence', { event: 'leave' }, () => {});

    presenceChannel.subscribe(async (status: string) => {
      if (status === 'SUBSCRIBED') {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          await presenceChannel.track({
            user_id: user.id,
            online_at: new Date().toISOString(),
          });
        }
      }
    });

    return () => {
      isMounted = false;
      presenceChannel.unsubscribe();
    };
  }, [roomId, supabase]);

  return { onlineUsers, onlineUserIds };
}
