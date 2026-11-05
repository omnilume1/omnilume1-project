'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRoomRealtime } from '@/components/room/RoomRealtimeProvider';
import { listRoomActivity } from '@/lib/management-data';
import { describeActivity, groupActivityByDay, mergeActivity, type ActivityRow } from '@/lib/room-management-model';

const PAGE = 20;

// Room history (Action 13): privacy-minimized rows from list_room_activity,
// grouped by day. New rows arrive through the room's existing private channel
// (roomActivityVersion) and are merged without duplicates.
export default function RoomActivityFeed({ roomId }: { roomId: string }) {
  const { roomActivityVersion, connectionGeneration } = useRoomRealtime();
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reload, setReload] = useState(0);
  const loadedOnce = useRef(false);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void listRoomActivity(roomId, null, PAGE).then((result) => {
        if (!active) return;
        if (!result.ok) { setStatus('error'); return; }
        setRows((current) => mergeActivity(current, result.data));
        if (!loadedOnce.current) setHasMore(result.data.length === PAGE);
        loadedOnce.current = true;
        setStatus('ready');
      });
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [roomId, roomActivityVersion, connectionGeneration, reload]);

  const loadMore = useCallback(async () => {
    const oldest = rows[rows.length - 1];
    if (!oldest || loadingMore) return;
    setLoadingMore(true);
    const result = await listRoomActivity(roomId, oldest.created_at, PAGE);
    setLoadingMore(false);
    if (!result.ok) { setStatus('error'); return; }
    setRows((current) => mergeActivity(current, result.data));
    setHasMore(result.data.length === PAGE);
  }, [loadingMore, roomId, rows]);

  return (
    <div className="room-dashboard-card" aria-labelledby="room-activity-heading">
      <h3 id="room-activity-heading" className="room-dashboard-heading">Recent activity</h3>
      {status === 'loading' ? <div className="room-dashboard-skeleton" aria-busy="true" /> : status === 'error' ? (
        <div role="alert">
          <p className="room-dashboard-muted">Room activity could not be loaded.</p>
          <button type="button" className="omni-button omni-button-ghost mt-3" onClick={() => { setStatus('loading'); setReload((value) => value + 1); }}>Retry</button>
        </div>
      ) : rows.length === 0 ? (
        <p className="room-dashboard-muted">Nothing has happened here yet. Joins, files, polls, tasks and events will show up as they happen.</p>
      ) : (
        <>
          {groupActivityByDay(rows).map((group) => (
            <section key={group.label} aria-label={group.label}>
              <p className="activity-day">{group.label}</p>
              <ul className="activity-list">
                {group.items.map((row) => (
                  <li key={row.id} className="activity-row">
                    <span className="activity-text">{describeActivity(row)}</span>
                    <time className="activity-time" dateTime={row.created_at}>{new Date(row.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {hasMore && <button type="button" className="omni-button omni-button-ghost mt-3" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? 'Loading…' : 'Show older'}</button>}
        </>
      )}
    </div>
  );
}
