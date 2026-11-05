'use client';

import { useCallback, useEffect, useState } from 'react';
import { getActiveTemporaryMedia, resolveRoomMedia } from '@/actions/media';
import { useRoomRealtime } from '@/components/room/RoomRealtimeProvider';
import { listStudySessions } from '@/lib/collab-data';
import { studyStats, type StudyStats } from '@/lib/collab-model';
import { addToQueue, listQueue, type QueueEntry } from '@/lib/watch-queue-data';
import { expectedPosition, formatPlaybackTime } from '@/lib/watch-sync';

function minutesLabel(minutes: number) {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

// Study history statistics (Action 12): the member's own sessions in this
// room (RLS: own rows only), summarised locally.
export function StudyHistoryStats({ roomId, refreshKey }: { roomId: string; refreshKey: number }) {
  const { currentUserId } = useRoomRealtime();
  const [stats, setStats] = useState<StudyStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!currentUserId) return;
    let active = true;
    void listStudySessions(roomId, currentUserId).then((result) => {
      if (!active) return;
      if (!result.ok) { setError(result.error); return; }
      setStats(studyStats(result.data)); setError(null);
    });
    return () => { active = false; };
  }, [currentUserId, refreshKey, roomId]);
  if (error) return <p role="alert" className="collab-error">{error}</p>;
  if (!stats) return <div className="collab-skeleton" aria-label="Loading study statistics" />;
  const tiles = [
    { label: 'Current streak', value: `${stats.currentStreakDays} day${stats.currentStreakDays === 1 ? '' : 's'}` },
    { label: 'Best streak', value: `${stats.bestStreakDays} day${stats.bestStreakDays === 1 ? '' : 's'}` },
    { label: 'Today', value: minutesLabel(stats.todayMinutes) },
    { label: 'Last 7 days', value: minutesLabel(stats.weekMinutes) },
    { label: 'Total', value: minutesLabel(stats.totalMinutes) },
    { label: 'Longest session', value: minutesLabel(stats.longestMinutes) },
  ];
  return (
    <div className="study-stats" aria-label="Your study statistics">
      <dl className="study-stat-grid">
        {tiles.map((tile) => <div key={tile.label} className="study-stat"><dt>{tile.label}</dt><dd>{tile.value}</dd></div>)}
      </dl>
      {stats.bySubject.length > 0 && (
        <ul className="study-subject-bars" aria-label="Time per subject">
          {stats.bySubject.slice(0, 6).map((row) => (
            <li key={row.subject}>
              <span className="study-subject-name">{row.subject}</span>
              <span className="study-subject-bar" aria-hidden="true"><span style={{ width: `${Math.max(4, row.share * 100)}%` }} /></span>
              <span className="study-subject-value">{minutesLabel(row.minutes)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type AudioItem = { id: string; label: string };

// Study music (Action 12): background audio for the room, played through the
// shared Watch stage and queue so everyone hears the same track. Controllers
// (watch_control) start/pause; anyone with Watch can queue.
export function StudyMusicCard({ roomId, onOpenWatch }: { roomId: string; onOpenWatch?: () => void }) {
  const { mediaState, canControlMedia, broadcastEvent, queueVersion } = useRoomRealtime();
  const [audio, setAudio] = useState<AudioItem[]>([]);
  const [next, setNext] = useState<QueueEntry | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const loadAudio = useCallback(async () => {
    const result = await getActiveTemporaryMedia(roomId);
    if (!result.success || !result.media) return;
    setAudio((result.media as Array<{ id: string; media_type: string; file_name: string; title: string | null; mime_type: string | null }>)
      .filter((item) => item.media_type === 'audio' || item.mime_type?.startsWith('audio/'))
      .map((item) => ({ id: item.id, label: item.title || item.file_name })));
  }, [roomId]);
  useEffect(() => {
    const timeout = window.setTimeout(() => { void loadAudio(); }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadAudio]);
  useEffect(() => {
    let active = true;
    void listQueue(roomId).then((result) => { if (active) setNext(result.ok ? result.data[0] ?? null : null); });
    return () => { active = false; };
  }, [queueVersion, roomId]);
  useEffect(() => {
    if (!mediaState?.playing) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [mediaState?.playing]);

  const play = async (item: AudioItem) => {
    const resolved = await resolveRoomMedia(roomId, item.id);
    if (!resolved.success || !resolved.media) { setStatus(resolved.error ?? 'Unable to play this track.'); return; }
    broadcastEvent('cast', { url: resolved.media.url, title: resolved.media.title, subtitleUrl: resolved.media.subtitleUrl, sourceType: resolved.media.sourceType, mediaId: item.id, speed: 1, playing: true });
    setStatus(`Playing ${item.label} for the room.`);
  };
  const queue = async (item: AudioItem) => {
    const result = await addToQueue(roomId, item.id);
    if (!result.ok) { setStatus(result.error); return; }
    broadcastEvent('queue_changed', { version: Date.now() });
    setStatus(`Queued ${item.label}.`);
  };
  const toggle = () => {
    if (!mediaState) return;
    broadcastEvent(mediaState.playing ? 'pause' : 'play', {
      url: mediaState.url, title: mediaState.title, time: expectedPosition(mediaState, Date.now()), speed: mediaState.speed,
      playing: !mediaState.playing, sourceType: mediaState.sourceType, castId: mediaState.castId, mediaId: mediaState.mediaId,
      muted: mediaState.muted, volume: mediaState.volume,
    });
  };

  return (
    <section className="study-music" aria-label="Study music">
      <div className="study-music-head">
        <h3 className="collab-card-title">Study music</h3>
        {onOpenWatch && <button type="button" className="collab-link" onClick={onOpenWatch}>Open Watch</button>}
      </div>
      {mediaState ? (
        <div className="study-music-now">
          <div className="min-w-0">
            <p className="study-music-title">{mediaState.title}</p>
            <p className="collab-meta">{mediaState.playing ? 'Playing' : 'Paused'} · {formatPlaybackTime(expectedPosition(mediaState, now))}{next?.media ? ` · Next: ${next.media.title || next.media.file_name}` : ''}</p>
          </div>
          {canControlMedia && <button type="button" className="omni-button omni-button-ghost" onClick={toggle} aria-label={mediaState.playing ? 'Pause music for the room' : 'Play music for the room'}>{mediaState.playing ? 'Pause' : 'Play'}</button>}
        </div>
      ) : <p className="collab-meta">Nothing is playing. Pick a track from this room&apos;s audio.</p>}
      {audio.length === 0 ? <p className="collab-meta">Upload audio in Watch to use it as study music.</p> : (
        <ul className="study-music-list">
          {audio.slice(0, 8).map((item) => (
            <li key={item.id}>
              <span className="study-music-track">{item.label}</span>
              {canControlMedia && <button type="button" className="collab-link" onClick={() => void play(item)}>Play</button>}
              <button type="button" className="collab-link" onClick={() => void queue(item)}>Queue</button>
            </li>
          ))}
        </ul>
      )}
      {status && <p role="status" className="collab-meta">{status}</p>}
    </section>
  );
}
