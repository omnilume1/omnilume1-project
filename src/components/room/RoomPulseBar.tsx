'use client';

import { useEffect, useState } from 'react';
import { useRoomRealtime } from '@/components/room/RoomRealtimeProvider';
import { getRoomPulse } from '@/lib/management-data';
import { pulseChips, type RoomPulse } from '@/lib/room-management-model';

// Live activity bar (Action 13): who is here and what just happened. Counts
// only - the numbers come from get_room_pulse (capability-scoped) and refresh
// when the room's activity feed reports a new row (same private channel).
export default function RoomPulseBar({ roomId }: { roomId: string }) {
  const { onlineUserIds, roomActivityVersion, connectionGeneration } = useRoomRealtime();
  const [pulse, setPulse] = useState<RoomPulse | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void getRoomPulse(roomId).then((result) => {
        if (!active) return;
        if (result.ok) { setPulse(result.data); setFailed(false); } else setFailed(true);
      });
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [roomId, roomActivityVersion, connectionGeneration, now]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  const chips = pulseChips(pulse, onlineUserIds.length, now);
  return (
    <div className="room-pulse-bar" role="status" aria-live="polite" aria-label="Room pulse">
      <span className="room-pulse-dot" aria-hidden="true" />
      <ul className="room-pulse-list">
        {chips.map((chip) => <li key={chip} className="room-pulse-chip">{chip}</li>)}
        {failed && <li className="room-pulse-chip is-muted">Live details unavailable</li>}
      </ul>
    </div>
  );
}
