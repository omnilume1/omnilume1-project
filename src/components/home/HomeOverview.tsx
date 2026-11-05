'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  listMyBookmarks, listMyOpenTasks, listMyRoomOverview, listMyUpcomingEvents, setBookmark, setEventRsvp,
  type Bookmark, type OpenTask, type UpcomingEvent,
} from '@/lib/management-data';
import { organizeRooms, relativeTime, RSVP_LABELS, type OverviewRoom, type RsvpResponse } from '@/lib/room-management-model';

type Loaded<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; data: T };

function useLoaded<T>(load: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>) {
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

function Block({ kicker, title, children }: { kicker: string; title: string; children: React.ReactNode }) {
  return (
    <section className="glass-panel glass-card-ambient overview-block">
      <p className="section-kicker">{kicker}</p>
      <h2 className="section-title">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Fallback<T>({ value, retry, empty, children }: { value: Loaded<T>; retry: () => void; empty: string; children: (data: T) => React.ReactNode }) {
  if (value.state === 'loading') return <div className="room-dashboard-skeleton" aria-busy="true" />;
  if (value.state === 'error') return <p className="text-sm text-neutral-400" role="alert">{value.message} <button type="button" className="underline" onClick={retry}>Retry</button></p>;
  const data = value.data;
  if (Array.isArray(data) && data.length === 0) return <p className="text-sm text-neutral-500">{empty}</p>;
  return <>{children(data)}</>;
}

const loadOverview = () => listMyRoomOverview();
const loadEvents = () => listMyUpcomingEvents(8);
const loadTasks = () => listMyOpenTasks(8);
const loadSaved = () => listMyBookmarks(30);

// Cross-room personal dashboard (Action 13): every list comes from an RPC that
// returns only rooms and items this account may see right now.
export default function HomeOverview() {
  const [rooms, retryRooms] = useLoaded<OverviewRoom[]>(loadOverview);
  const [events, retryEvents, setEvents] = useLoaded<UpcomingEvent[]>(loadEvents);
  const [tasks, retryTasks] = useLoaded<OpenTask[]>(loadTasks);
  const [saved, retrySaved, setSaved] = useLoaded<Bookmark[]>(loadSaved);
  const [notice, setNotice] = useState<string | null>(null);

  const respond = async (event: UpcomingEvent, response: RsvpResponse) => {
    const next = event.my_response === response ? null : response;
    const result = await setEventRsvp(event.event_id, next);
    if (!result.ok) { setNotice(result.error); return; }
    setNotice(null);
    setEvents((current) => current.state === 'ready'
      ? { state: 'ready', data: current.data.map((item) => item.event_id === event.event_id ? { ...item, my_response: next } : item) }
      : current);
  };

  const unsave = async (bookmark: Bookmark) => {
    const result = await setBookmark(bookmark.room_id, bookmark.kind, bookmark.entity_id, false);
    if (!result.ok) { setNotice(result.error); return; }
    setNotice(null);
    setSaved((current) => current.state === 'ready' ? { state: 'ready', data: current.data.filter((item) => item.id !== bookmark.id) } : current);
  };

  return (
    <>
      <Block kicker="Your rooms" title="Organized for you">
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
      </Block>

      <Block kicker="Your calendar" title="Upcoming events">
        <Fallback value={events} retry={retryEvents} empty="No upcoming events in your rooms.">
          {(data) => (
            <ul className="overview-list">
              {data.map((event) => (
                <li key={event.event_id} className="overview-event">
                  <Link href={`/room/${event.room_id}`} className="overview-event-main">
                    <strong className="block truncate text-sm text-white">{event.title}</strong>
                    <small className="text-xs text-neutral-500">{event.room_name} · <time dateTime={event.starts_at}>{new Date(event.starts_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</time></small>
                  </Link>
                  <div className="rsvp-row" role="group" aria-label={`Your response to ${event.title}`}>
                    {(Object.keys(RSVP_LABELS) as RsvpResponse[]).map((response) => (
                      <button key={response} type="button" className={`rsvp-button ${event.my_response === response ? 'is-selected' : ''}`} aria-pressed={event.my_response === response} onClick={() => void respond(event, response)}>{RSVP_LABELS[response]}</button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Fallback>
      </Block>

      <Block kicker="To do" title="Assigned to you">
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
      </Block>

      <Block kicker="Saved" title="Saved rooms and content">
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
      </Block>
      {notice && <p role="alert" className="form-error">{notice}</p>}
    </>
  );
}
