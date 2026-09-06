'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getRoomControlState } from '@/actions/room-controls';
import { useRoomRealtime } from '@/components/room/RoomRealtimeProvider';

type Announcement = { id: string; body: string; is_pinned: boolean; created_at: string };

export default function RoomAnnouncementBanner({ roomId }: { roomId: string }) {
  const { roomControlEvents } = useRoomRealtime();
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const seenIds = useRef(new Set<string>());
  const loaded = useRef(false);

  const load = useCallback(async (announcementId?: string) => {
    const state = await getRoomControlState(roomId);
    const rows = (state.announcements ?? []) as Announcement[];
    if (!loaded.current) {
      rows.forEach((row) => seenIds.current.add(row.id));
      loaded.current = true;
      return;
    }
    const next = announcementId ? rows.find((row) => row.id === announcementId) : rows[0] ?? null;
    if (next && !seenIds.current.has(next.id)) {
      seenIds.current.add(next.id);
      setAnnouncement(next);
    }
  }, [roomId]);

  useEffect(() => { void load().catch(() => undefined); }, [load]);
  useEffect(() => {
    const created = [...roomControlEvents].reverse().find((event) => event.eventType === 'announcement_changed' && event.payload.state === 'created' && typeof event.payload.announcement_id === 'string');
    if (typeof created?.payload.announcement_id === 'string') void load(created.payload.announcement_id).catch(() => undefined);
  }, [load, roomControlEvents]);

  if (!announcement) return null;
  return <div className="border-b border-violet-300/20 bg-violet-500/10 px-4 py-3 text-violet-50 sm:px-6" role="status" aria-live="polite"><div className="mx-auto flex max-w-7xl items-start justify-between gap-4"><div><p className="text-[10px] font-bold uppercase tracking-[.16em] text-violet-200">New room announcement{announcement.is_pinned ? ' · pinned' : ''}</p><p className="mt-1 whitespace-pre-wrap text-sm leading-6">{announcement.body}</p></div><button type="button" onClick={() => setAnnouncement(null)} className="shrink-0 text-xs font-semibold text-violet-100 underline">Dismiss</button></div></div>;
}
