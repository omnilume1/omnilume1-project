'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getMyNotificationPreferences, getMyNotifications, markNotificationsRead, setNotificationPreference } from '@/actions/notification-center';
import {
  activeDoNotDisturb,
  adjustUnread,
  isRoomMuted,
  markItemsRead,
  mergeNotifications,
  type NotificationItem,
  type NotificationPreference,
} from '@/lib/notification-center-model';
import { getSignedInUserIdForNotifications, subscribeToRoomNotificationChanges } from '@/hooks/usePersonalMessageNotifications';

function toItem(row: Record<string, unknown>): NotificationItem | null {
  if (typeof row.id !== 'string' || typeof row.room_id !== 'string' || typeof row.created_at !== 'string' || typeof row.message !== 'string') return null;
  return {
    id: row.id,
    room_id: row.room_id,
    notification_type: typeof row.notification_type === 'string' ? row.notification_type : 'notification',
    message: row.message,
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata as Record<string, unknown> : null,
    actor_id: typeof row.actor_id === 'string' ? row.actor_id : null,
    entity_id: typeof row.entity_id === 'string' ? row.entity_id : null,
    created_at: row.created_at,
    read_at: typeof row.read_at === 'string' ? row.read_at : null,
  };
}

export function useNotificationCenter() {
  const [userId, setUserId] = useState<string | null>(null);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<NotificationPreference[]>([]);
  // Ids seen so far and ids known to be unread, so live INSERT/UPDATE events
  // adjust the server's unread count exactly once.
  const knownIds = useRef(new Set<string>());
  const unreadIds = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    void getSignedInUserIdForNotifications().then((id) => { if (!cancelled) setUserId(id); });
    return () => { cancelled = true; };
  }, []);

  const load = useCallback(async () => {
    setStatus((current) => (current === 'ready' ? current : 'loading'));
    const [result, prefs] = await Promise.all([getMyNotifications(30), getMyNotificationPreferences()]);
    if (!result.success) {
      setError(result.error);
      setStatus('error');
      return;
    }
    knownIds.current = new Set(result.items.map((item) => item.id));
    unreadIds.current = new Set(result.items.filter((item) => !item.read_at).map((item) => item.id));
    setItems(result.items);
    setUnreadCount(result.unreadCount);
    if (prefs.success) setPreferences(prefs.preferences);
    setError(null);
    setStatus('ready');
  }, []);

  useEffect(() => {
    if (!userId) return;
    const initial = window.setTimeout(() => { void load(); }, 0);
    const unsubscribe = subscribeToRoomNotificationChanges(userId, ({ eventType, row }) => {
      const item = toItem(row);
      if (!item) return;
      if (eventType === 'INSERT') {
        if (knownIds.current.has(item.id)) return;
        knownIds.current.add(item.id);
        if (!item.read_at) {
          unreadIds.current.add(item.id);
          setUnreadCount((count) => adjustUnread(count, 1));
        }
      } else if (item.read_at && unreadIds.current.delete(item.id)) {
        // Marked read in another tab: keep the count honest.
        setUnreadCount((count) => adjustUnread(count, -1));
      }
      setItems((current) => mergeNotifications(current, [item]));
    });
    return () => { window.clearTimeout(initial); unsubscribe(); };
  }, [load, userId]);

  const markRead = useCallback(async (ids: string[] | null) => {
    const targetIds = items.filter((item) => !item.read_at && (!ids || ids.includes(item.id))).map((item) => item.id);
    if (targetIds.length === 0 && ids !== null) return true;
    const previousItems = items;
    const previousCount = unreadCount;
    const previousUnreadIds = unreadIds.current;
    unreadIds.current = ids === null ? new Set() : new Set([...unreadIds.current].filter((id) => !ids.includes(id)));
    setItems((current) => markItemsRead(current, ids, new Date().toISOString()));
    setUnreadCount((count) => (ids === null ? 0 : adjustUnread(count, -targetIds.length)));
    const result = await markNotificationsRead(ids);
    if (!result.success) {
      setItems(previousItems);
      setUnreadCount(previousCount);
      unreadIds.current = previousUnreadIds;
      setError(result.error);
      return false;
    }
    if (ids === null) setUnreadCount(0);
    return true;
  }, [items, unreadCount]);

  const setDoNotDisturb = useCallback(async (enabled: boolean, hours: number | null) => {
    const until = enabled && hours ? new Date(Date.now() + hours * 3_600_000).toISOString() : null;
    const result = await setNotificationPreference(null, enabled, until);
    if (!result.success) { setError(result.error); return false; }
    const prefs = await getMyNotificationPreferences();
    if (prefs.success) setPreferences(prefs.preferences);
    return true;
  }, []);

  // Per-room mute (the server checks membership and applies it when
  // notifications are written; access and security notices still arrive).
  const setRoomMuted = useCallback(async (roomId: string, muted: boolean) => {
    const result = await setNotificationPreference(roomId, muted, null);
    if (!result.success) { setError(result.error); return false; }
    const prefs = await getMyNotificationPreferences();
    if (prefs.success) setPreferences(prefs.preferences);
    return true;
  }, []);

  return {
    userId,
    items,
    unreadCount,
    status,
    error,
    reload: load,
    markRead,
    doNotDisturb: activeDoNotDisturb(preferences),
    setDoNotDisturb,
    isRoomMuted: (roomId: string) => isRoomMuted(preferences, roomId),
    setRoomMuted,
  };
}
