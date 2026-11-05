'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRoomRealtime } from '@/components/room/RoomRealtimeProvider';
import { useMemberNames } from '@/lib/collab-hooks';
import { createThrottle } from '@/lib/collab-model';

const CURSOR_SEND_MS = 80;
const CURSOR_TTL_MS = 4_000;
const COLORS = ['#f472b6', '#38bdf8', '#34d399', '#fbbf24', '#a78bfa', '#fb7185', '#2dd4bf', '#f97316'];

function colorFor(userId: string) {
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return COLORS[hash % COLORS.length];
}

type Viewport = { zoom: number; x: number; y: number };

// Live whiteboard cursors (Action 12): ephemeral, throttled world-coordinate
// pointer positions on the study topic, labelled with room display names.
// Nothing is persisted and the board contents never travel this way.
export function useWhiteboardCursors(roomId: string, viewport: Viewport) {
  const { sendRoomEvent, subscribeRoomEvents, currentUserId } = useRoomRealtime();
  const names = useMemberNames(roomId);
  const [cursors, setCursors] = useState<Map<string, { x: number; y: number; at: number }>>(() => new Map());
  const [now, setNow] = useState(() => Date.now());
  const throttleRef = useRef<ReturnType<typeof createThrottle<{ x: number; y: number }>> | null>(null);

  useEffect(() => {
    const throttle = createThrottle<{ x: number; y: number }>((point) => { sendRoomEvent('cursor', point); }, CURSOR_SEND_MS);
    throttleRef.current = throttle;
    return () => throttle.cancel();
  }, [sendRoomEvent]);

  useEffect(() => subscribeRoomEvents((event) => {
    if (event.type !== 'cursor' || event.senderId === currentUserId) return;
    const x = Number(event.payload.x);
    const y = Number(event.payload.y);
    setCursors((current) => new Map(current).set(event.senderId, { x, y, at: Date.now() }));
  }), [currentUserId, subscribeRoomEvents]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);

  // Screen position inside the canvas → world coordinates for the wire.
  const trackPointer = useCallback((screenX: number, screenY: number) => {
    const x = Math.round(((screenX - viewport.x) / viewport.zoom) * 10) / 10;
    const y = Math.round(((screenY - viewport.y) / viewport.zoom) * 10) / 10;
    throttleRef.current?.push({ x, y });
  }, [viewport.x, viewport.y, viewport.zoom]);

  const overlay = (
    <div className="wb-cursors" aria-hidden="true">
      {[...cursors.entries()].filter(([, cursor]) => now - cursor.at < CURSOR_TTL_MS).map(([userId, cursor]) => {
        const left = cursor.x * viewport.zoom + viewport.x;
        const top = cursor.y * viewport.zoom + viewport.y;
        const color = colorFor(userId);
        return (
          <div key={userId} className="wb-cursor" style={{ transform: `translate(${left}px, ${top}px)` }}>
            <svg width="16" height="16" viewBox="0 0 16 16"><path d="M1 1l5.5 13 2-5.5 5.5-2z" fill={color} stroke="#000" strokeWidth="1" /></svg>
            <span className="wb-cursor-name" style={{ background: color }}>{names.get(userId) ?? 'Member'}</span>
          </div>
        );
      })}
    </div>
  );

  const activeCount = [...cursors.values()].filter((cursor) => now - cursor.at < CURSOR_TTL_MS).length;
  return { trackPointer, overlay, activeCount };
}
