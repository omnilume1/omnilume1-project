'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { FriendListening } from '@/hooks/useFriendsListening';
import { useMusicPlayer } from '@/hooks/useMusicPlayer';
import { listMyUpcomingEvents, setEventRsvp, type UpcomingEvent } from '@/lib/management-data';
import { relativeTime, RSVP_LABELS, type OverviewRoom, type RsvpResponse } from '@/lib/room-management-model';
import { MusicIcon } from '@/components/music/MusicIcon';
import { OmniIcon } from '@/components/ui/OmniIcon';
import RoomArt, { roomArtFor } from '@/components/ui/RoomArt';
import styles from '@/components/home/home.module.css';
import { Fallback, Tile, useLoaded, type Loaded } from '@/components/home/HomeOverview';

export interface Friend { user_id: string; display_name: string | null; username: string | null; avatar_url: string | null }
export interface PublicRoom { id: string; name: string; username: string | null; room_members: Array<{ count: number }> }

function initials(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return (parts.slice(0, 2).map((part) => part[0]).join('') || 'O').toUpperCase();
}

export function Avatar({ name, src, size = 34 }: { name: string; src?: string | null; size?: number }) {
  return (
    <span className={styles.avatar} style={{ width: size, height: size }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- signed avatar URL */}
      {src ? <img src={src} alt="" /> : initials(name)}
    </span>
  );
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** The room to go back to: the one with the newest activity. */
export function lastRoom(rooms: OverviewRoom[]) {
  return rooms.slice().sort((left, right) => (right.last_activity_at ?? '').localeCompare(left.last_activity_at ?? ''))[0] ?? null;
}

export function ContinueTile({ rooms }: { rooms: Loaded<OverviewRoom[]> }) {
  const room = rooms.state === 'ready' ? lastRoom(rooms.data) : null;
  const loading = rooms.state === 'loading';
  return (
    <section className={`glass-card ${styles.tile} ${styles.tileContinue}`} style={{ ['--i' as string]: 0 }} aria-label="Continue where you left off">
      <div className={styles.continueText}>
        <p className={styles.kicker}>{room ? 'Continue where you left off' : 'Start something'}</p>
        <h3>{loading ? ' ' : room ? room.name : 'Your first room'}</h3>
        {room ? (
          <p className={styles.meta}>
            <span className={styles.dot} aria-hidden="true" />{plural(room.member_count, 'member')}
            {room.unread_count > 0 && <><span className={styles.bar} aria-hidden="true" /><span>{room.unread_count >= 100 ? '99+' : room.unread_count} unread</span></>}
            {room.last_activity_at && <><span className={styles.bar} aria-hidden="true" /><span className={styles.metaItem}><OmniIcon name="clock" size={15} /><span className="mono">active {relativeTime(room.last_activity_at)}</span></span></>}
          </p>
        ) : !loading && <p className={styles.meta}>Watch, study or listen together. Make a room or find one to join.</p>}
        <div className={styles.continueActions}>
          {room
            ? <Link href={`/room/${room.room_id}`} className="omni-button omni-button-primary">Rejoin room <OmniIcon name="arrow" size={16} /></Link>
            : <><Link href="/create-room" className="omni-button omni-button-primary"><OmniIcon name="plus" size={16} /> Create room</Link><Link href="/explore" className="omni-button omni-button-ghost">Find a room</Link></>}
        </div>
      </div>
      <div className={styles.mini} aria-hidden="true">
        <div className={`${styles.mw} ${styles.mwArt}`}><RoomArt kind={roomArtFor(room?.room_id ?? 'omnilume')} /></div>
        <div className={`${styles.mw} ${styles.mwSide}`}><i /><i className={styles.s} /><i className={styles.a} /><i /><i className={styles.a} /><i className={styles.s} /></div>
        <div className={`${styles.mw} ${styles.mwBar}`}>
          <span className="mono">{room ? plural(room.member_count, 'member') : 'New room'}</span>
          <small>{room?.next_event_at ? `Event ${relativeTime(room.next_event_at)}` : room?.open_tasks ? plural(room.open_tasks, 'open task') : 'Watch · Study · Listen'}</small>
        </div>
      </div>
    </section>
  );
}

export function FriendsTile({ friends, listening, loading }: { friends: Friend[]; listening: FriendListening[]; loading: boolean }) {
  const songs = new Map(listening.map((item) => [item.user_id, item]));
  const rows = friends.slice().sort((left, right) => Number(songs.has(right.user_id)) - Number(songs.has(left.user_id))).slice(0, 5);
  return (
    <Tile title="Friends" className={styles.tileFriends} index={1} aside={<small className="mono">{loading ? '' : listening.length ? `${listening.length} of ${friends.length} listening` : friends.length}</small>}>
      {loading ? <div className="room-dashboard-skeleton" aria-busy="true" /> : rows.length === 0 ? <p className={styles.empty}>No friends yet. Connect from a profile when you are ready.</p> : (
        <div className={styles.rows}>
          {rows.map((friend) => {
            const name = friend.display_name || friend.username || 'OmniLume member';
            const song = songs.get(friend.user_id);
            return (
              <Link key={friend.user_id} href={`/profile/${friend.user_id}`} className={styles.row}>
                <Avatar name={name} src={friend.avatar_url} />
                <span className={styles.rowText}><strong>{name}</strong><small>{song ? `Listening to ${song.title}` : friend.username ? `@${friend.username}` : 'Friend'}</small></span>
                {song && <span className={styles.dot} aria-label="Listening now" />}
              </Link>
            );
          })}
        </div>
      )}
    </Tile>
  );
}

const loadEvents = () => listMyUpcomingEvents(8);

function eventTime(iso: string) {
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : date.toLocaleDateString([], { weekday: 'short', day: 'numeric' });
}

export function ComingUpTile() {
  const [events, retry, setEvents] = useLoaded<UpcomingEvent[]>(loadEvents);
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
  return (
    <Tile title="Coming up" className={styles.tileEvents} index={2} aside={<Link href="/explore">Rooms</Link>}>
      <Fallback value={events} retry={retry} empty="No upcoming events in your rooms.">
        {(data) => (
          <ol className={styles.timeline}>
            {data.slice(0, 4).map((event) => (
              <li key={event.event_id}>
                <time className="mono" dateTime={event.starts_at}>{eventTime(event.starts_at)}</time>
                <div className="min-w-0">
                  <Link href={`/room/${event.room_id}`} className={styles.eventTitle}>{event.title}</Link>
                  <small>{event.room_name} · {relativeTime(event.starts_at)}</small>
                  <div className={styles.rsvp} role="group" aria-label={`Your response to ${event.title}`}>
                    {(Object.keys(RSVP_LABELS) as RsvpResponse[]).map((response) => (
                      <button key={response} type="button" className={`rsvp-button ${event.my_response === response ? 'is-selected' : ''}`} aria-pressed={event.my_response === response} onClick={() => void respond(event, response)}>{RSVP_LABELS[response]}</button>
                    ))}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Fallback>
      {notice && <p role="alert" className="form-error">{notice}</p>}
    </Tile>
  );
}

const clock = (ms: number) => { const seconds = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };

export function NowPlayingTile({ listening }: { listening: FriendListening[] }) {
  const player = useMusicPlayer();
  const track = player.queue.current;
  const friend = listening[0];
  const duration = player.durationMs || track?.durationMs || 0;
  const percent = duration ? Math.min(100, (player.positionMs / duration) * 100) : 0;
  return (
    <Tile title="Now playing" className={styles.tileMusic} index={3} aside={track ? <small>{player.isPlaying ? 'Playing' : 'Paused'}</small> : friend ? <small>with {friend.display_name || friend.username || 'a friend'}</small> : <Link href="/music">Music</Link>}>
      {track ? (
        <>
          <div className={styles.np}>
            {/* eslint-disable-next-line @next/next/no-img-element -- blob/signed artwork URL */}
            <span className={styles.cover} style={{ ['--hue' as string]: track.hue }}>{track.artwork ? <img src={track.artwork} alt="" /> : <OmniIcon name="music" size={28} />}</span>
            <div className="min-w-0">
              <b>{track.title}</b><small>{track.artist}</small>
              <button type="button" className={styles.chip} onClick={player.toggle} aria-label={player.isPlaying ? 'Pause' : 'Play'}><MusicIcon name={player.isPlaying ? 'pause' : 'play'} size={14} />{player.isPlaying ? 'Pause' : 'Play'}</button>
            </div>
          </div>
          <div className={styles.progress} aria-hidden="true"><i style={{ width: `${percent}%` }} /></div>
          <div className={`${styles.times} mono`}><span>{clock(player.positionMs)}</span><span>{clock(duration)}</span></div>
        </>
      ) : friend ? (
        <div className={styles.np}>
          <span className={styles.cover}><OmniIcon name="headphones" size={28} /></span>
          <div className="min-w-0">
            <b>{friend.title}</b><small>{friend.artist}</small>
            <Link href="/music" className={styles.chip}><OmniIcon name="headphones" size={14} />Open Music</Link>
          </div>
        </div>
      ) : (
        <div className={styles.np}>
          <span className={styles.cover}><OmniIcon name="music" size={28} /></span>
          <div className="min-w-0">
            <b>Nothing playing</b><small>Your music keeps playing across every page.</small>
            <Link href="/music" className={styles.chip}><MusicIcon name="play" size={14} />Open Music</Link>
          </div>
        </div>
      )}
    </Tile>
  );
}

export function ExploreTile({ rooms, loading }: { rooms: PublicRoom[]; loading: boolean }) {
  return (
    <Tile title="Rooms to explore" className={styles.tileExplore} index={4} aside={<Link href="/explore">View all</Link>}>
      {loading ? <div className="room-dashboard-skeleton" aria-busy="true" /> : rooms.length === 0 ? <p className={styles.empty}>There are no public rooms to show right now.</p> : (
        <div className={styles.rows}>
          {rooms.slice(0, 3).map((room) => (
            <Link key={room.id} href="/explore" className={styles.row}>
              <span className={styles.thumb} aria-hidden="true"><RoomArt kind={roomArtFor(room.id)} /></span>
              <span className={styles.rowText}><strong>{room.name}</strong><small className="mono">{plural(room.room_members[0]?.count ?? 0, 'member')}</small></span>
              <OmniIcon name="chevronRight" size={16} className={styles.chev} />
            </Link>
          ))}
        </div>
      )}
    </Tile>
  );
}
