'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { listMyBookmarks, listMyOpenTasks, setBookmark, type Bookmark, type OpenTask } from '@/lib/management-data';
import styles from '@/components/home/home.module.css';
import { organizeRooms, relativeTime, type OverviewRoom } from '@/lib/room-management-model';

export type Loaded<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; data: T };

export function useLoaded<T>(load: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>) {
  const [value, setValue] = useState<Loaded<T>>({ state: 'loading' });
  const run = useCallback(() => {
    void load().then((result) => setValue(result.ok ? { state: 'ready', data: result.data } : { state: 'error', message: result.error }));
  }, [load]);
  useEffect(() => {
    const timer = window.setTimeout(run, 0);
    return () => window.clearTimeout(timer);
  }, [run]);
  const retry = () => { setValue({ state: 'loading' }); run(); };
  return [value, retry, setValue] as const;
}

export function Tile({ title, aside, className, index, label, children }: { title: string; aside?: React.ReactNode; className: string; index: number; label?: string; children: React.ReactNode }) {
  return (
    <section className={`glass-card ${styles.tile} ${className}`} style={{ ['--i' as string]: index }} aria-label={label ?? title}>
      <div className={styles.tileHead}><h2>{title}</h2>{aside}</div>
      {children}
    </section>
  );
}

export function Fallback<T>({ value, retry, empty, children }: { value: Loaded<T>; retry: () => void; empty: React.ReactNode; children: (data: T) => React.ReactNode }) {
  if (value.state === 'loading') return <div className="room-dashboard-skeleton" aria-busy="true" />;
  if (value.state === 'error') return <p className={styles.empty} role="alert">{value.message} <button type="button" className="underline" onClick={retry}>Retry</button></p>;
  const data = value.data;
  if (Array.isArray(data) && data.length === 0) return <p className={styles.empty}>{empty}</p>;
  return <>{children(data)}</>;
}

const loadTasks = () => listMyOpenTasks(8);
const loadSaved = () => listMyBookmarks(30);

// Cross-room personal lists (Action 13): every list comes from an RPC that
// returns only rooms and items this account may see right now.
export default function HomeOverview({ rooms, retryRooms }: { rooms: Loaded<OverviewRoom[]>; retryRooms: () => void }) {
  const [tasks, retryTasks] = useLoaded<OpenTask[]>(loadTasks);
  const [saved, retrySaved, setSaved] = useLoaded<Bookmark[]>(loadSaved);
  const [notice, setNotice] = useState<string | null>(null);

  const unsave = async (bookmark: Bookmark) => {
    const result = await setBookmark(bookmark.room_id, bookmark.kind, bookmark.entity_id, false);
    if (!result.ok) { setNotice(result.error); return; }
    setNotice(null);
    setSaved((current) => current.state === 'ready' ? { state: 'ready', data: current.data.filter((item) => item.id !== bookmark.id) } : current);
  };

  return (
    <>
      <Tile title="Your rooms" className={styles.tileRooms} index={5} aside={rooms.state === 'ready' ? <small className="mono">{rooms.data.length}</small> : null}>
        <Fallback value={rooms} retry={retryRooms} empty="You have not joined any rooms yet. Find one in Explore.">
          {(data) => (
            <div className="overview-buckets">
              {organizeRooms(data).map((group) => (
                <section key={group.bucket} aria-label={group.label}>
                  <h3 className="overview-bucket-title">{group.label} <span>{group.rooms.length}</span></h3>
                  <ul className="overview-list">
                    {group.rooms.map((room) => (
                      <li key={room.room_id}>
                        <Link href={`/room/${room.room_id}`} className="overview-row">
                          <span className="min-w-0"><strong className="block truncate text-sm text-white">{room.name}</strong>
                            <small className="text-xs text-neutral-500">{room.member_count} member{room.member_count === 1 ? '' : 's'}{room.expiration_type !== 'permanent' && room.expires_at ? ` · ends ${relativeTime(room.expires_at)}` : ''}{room.next_event_at ? ` · event ${relativeTime(room.next_event_at)}` : ''}</small></span>
                          <span className="overview-badges">
                            {room.unread_count > 0 && <span className="overview-badge" aria-label={`${room.unread_count} unread`}>{room.unread_count >= 100 ? '99+' : room.unread_count}</span>}
                            {room.open_tasks > 0 && <span className="overview-badge is-task" aria-label={`${room.open_tasks} open tasks`}>{room.open_tasks} task{room.open_tasks === 1 ? '' : 's'}</span>}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </Fallback>
      </Tile>

      <Tile title="Assigned to you" className={styles.tileTasks} index={6}>
        <Fallback value={tasks} retry={retryTasks} empty="Nothing assigned to you right now.">
          {(data) => (
            <ul className="overview-list">
              {data.map((task) => (
                <li key={task.task_id}><Link href={`/room/${task.room_id}`} className="overview-row">
                  <span className="min-w-0"><strong className="block truncate text-sm text-white">{task.title}</strong><small className="text-xs text-neutral-500">{task.room_name}{task.due_at ? ` · due ${relativeTime(task.due_at)}` : ''}</small></span>
                </Link></li>
              ))}
            </ul>
          )}
        </Fallback>
      </Tile>

      <Tile title="Saved" className={styles.tileSaved} index={7}>
        <Fallback value={saved} retry={retrySaved} empty="Save rooms, messages and files to find them here.">
          {(data) => (
            <ul className="overview-list">
              {data.map((item) => (
                <li key={item.id} className="overview-event">
                  <Link href={item.kind === 'message' ? `/room/${item.room_id}#message-${item.entity_id}` : `/room/${item.room_id}`} className="overview-event-main">
                    <strong className="block truncate text-sm text-white">{item.label}</strong>
                    <small className="text-xs capitalize text-neutral-500">{item.kind}{item.kind === 'room' ? '' : ` · ${item.room_name}`}</small>
                  </Link>
                  <button type="button" className="rsvp-button" onClick={() => void unsave(item)} aria-label={`Remove ${item.label} from saved`}>Remove</button>
                </li>
              ))}
            </ul>
          )}
        </Fallback>
        {notice && <p role="alert" className="form-error">{notice}</p>}
      </Tile>
    </>
  );
}
