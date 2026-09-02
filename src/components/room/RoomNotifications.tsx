'use client';

import { useCallback, useEffect, useState } from 'react';
import { getRoomNotifications, markRoomNotificationRead, type RoomNotification as RoomNotificationRecord } from '@/actions/notifications';

interface RoomNotificationsProps {
  roomId: string;
}

export default function RoomNotifications({ roomId }: RoomNotificationsProps) {
  const [notifications, setNotifications] = useState<RoomNotificationRecord[]>([]);

  const loadNotifications = useCallback(async () => {
    const result = await getRoomNotifications(roomId);
    if (result.success) setNotifications(result.notifications);
  }, [roomId]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadNotifications(), 0);
    const interval = window.setInterval(() => void loadNotifications(), 30_000);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(interval);
    };
  }, [loadNotifications]);

  if (notifications.length === 0) return null;

  return (
    <div className="border-b border-indigo-900/40 bg-indigo-950/20 px-6 py-2 text-xs text-indigo-100" aria-label="Room notifications">
      {notifications.map((notification) => (
        <div key={notification.id} className="flex items-start justify-between gap-3 py-1">
          <span>{notification.message}</span>
          {!notification.read_at && <button type="button" onClick={() => { void markRoomNotificationRead(notification.id); setNotifications((current) => current.map((item) => item.id === notification.id ? { ...item, read_at: new Date().toISOString() } : item)); }} className="shrink-0 text-[10px] font-bold text-indigo-300 underline">Mark read</button>}
        </div>
      ))}
    </div>
  );
}
