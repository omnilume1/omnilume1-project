'use client';

import { useEffect, useRef, useState } from 'react';
import type { RoomControlEvent } from '@/hooks/useRoomSync';

export default function RoomRoleChangeNotification({
  events,
  currentUserId,
}: {
  events: RoomControlEvent[];
  currentUserId: string | null;
}) {
  const [visibleEvent, setVisibleEvent] = useState<RoomControlEvent | null>(null);
  const seenIds = useRef<Set<number>>(new Set());

  useEffect(() => {
    const event = [...events].reverse().find((candidate) =>
      candidate.eventType === 'role_changed' &&
      candidate.subjectUserId === currentUserId &&
      !seenIds.current.has(candidate.id),
    );
    if (!event) return;

    seenIds.current.add(event.id);
    setVisibleEvent(event);
    const timer = window.setTimeout(() => setVisibleEvent((current) => current?.id === event.id ? null : current), 7_000);
    return () => window.clearTimeout(timer);
  }, [currentUserId, events]);

  if (!visibleEvent) return null;
  const role = typeof visibleEvent.payload.role === 'string' ? visibleEvent.payload.role : 'updated';

  return (
    <div className="room-role-toast" role="status" aria-live="polite">
      <span className="status-dot" aria-hidden="true" />
      <span>Your room role was changed to <strong>{role}</strong>.</span>
      <button type="button" onClick={() => setVisibleEvent(null)} aria-label="Dismiss role change notification">Dismiss</button>
    </div>
  );
}
