'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getRoomControlState } from '@/actions/room-controls';
import { useRoomRealtime } from '@/components/room/RoomRealtimeProvider';

type Announcement = { id: string; body: string; is_pinned: boolean; created_at: string };

export default function RoomAnnouncementBanner({ roomId }: { roomId: string }) {
  const { roomControlVersion } = useRoomRealtime();
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const seenIds = useRef(new Set<string>());
  const loaded = useRef(false);

  const load = useCallback(async () => {
    const state = await getRoomControlState(roomId);
    const rows = (state.announcements ?? []) as Announcement[];
    const newest = rows[0] ?? null;
    const isNew = newest && !seenIds.current.has(newest.id);
    rows.forEach((row) => seenIds.current.add(row.id));
    if (loaded.current && isNew) setAnnouncement(newest);
    loaded.current = true;
  }, [roomId]);

  useEffect(() => { void load().catch(() => undefined); }, [load, roomControlVersion]);

  if (!announcement) return null;
  return <div className="border-b border-violet-300/20 bg-violet-500/10 px-4 py-3 text-violet-50 sm:px-6" role="status" aria-live="polite"><div className="mx-auto flex max-w-7xl items-start justify-between gap-4"><div><p className="text-[10px] font-bold uppercase tracking-[.16em] text-violet-200">New room announcement{announcement.is_pinned ? ' · pinned' : ''}</p><p className="mt-1 whitespace-pre-wrap text-sm leading-6">{announcement.body}</p></div><button type="button" onClick={() => setAnnouncement(null)} className="shrink-0 text-xs font-semibold text-violet-100 underline">Dismiss</button></div></div>;
}
