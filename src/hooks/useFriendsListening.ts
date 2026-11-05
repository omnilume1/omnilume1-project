'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/utils/supabase/client';

export type FriendListening = {
  user_id: string; display_name: string | null; username: string | null; avatar_url: string | null;
  title: string; artist: string; updated_at: string;
};

/** Friends who are playing music now (audience, privacy and blocks are applied by the RPC). */
export function useFriendsListening() {
  const [friends, setFriends] = useState<FriendListening[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (document.visibilityState !== 'visible') return;
      const { data, error } = await createClient().rpc('list_friends_listening');
      if (!cancelled && !error) setFriends((data ?? []) as FriendListening[]);
    };
    void load();
    // shortcut: polls every 60 s while the tab is visible; move to a private per-user broadcast if friend lists grow large.
    const timer = window.setInterval(() => void load(), 60_000);
    const onVisible = () => void load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return friends;
}
