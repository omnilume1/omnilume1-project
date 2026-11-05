'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/utils/supabase/client';
import { useRoomRealtime } from '@/components/room/RoomRealtimeProvider';
import { OmniIcon } from '@/components/ui/OmniIcon';
import { expectedPosition, formatPlaybackTime } from '@/lib/watch-sync';
import { listQueue, type QueueEntry } from '@/lib/watch-queue-data';

// Now Playing / shared state bar (Action 11): what the room is watching or
// listening to, shown while the member is elsewhere in the room. Controllers
// can play/pause from here; the hidden (still mounted) Watch stage applies it.
export default function NowPlayingBar({ roomId, onOpen }: { roomId: string; onOpen: () => void }) {
  const { mediaState, broadcastEvent, canControlMedia, queueVersion } = useRoomRealtime();
  const supabase = useMemo(() => createClient(), []);
  const [details, setDetails] = useState<{ mediaId: string; title: string | null; artist: string | null } | null>(null);
  const [next, setNext] = useState<QueueEntry | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const mediaId = mediaState?.mediaId ?? null;

  useEffect(() => {
    if (!mediaId) return;
    let active = true;
    void (async () => {
      const { data } = await supabase
        .from('temporary_media')
        .select('id, title:metadata->>title, artist:metadata->>artist')
        .eq('id', mediaId)
        .maybeSingle();
      if (active && data) setDetails({ mediaId, title: (data as { title: string | null }).title, artist: (data as { artist: string | null }).artist });
    })();
    return () => { active = false; };
  }, [mediaId, supabase]);

  useEffect(() => {
    let active = true;
    void listQueue(roomId).then((result) => { if (active) setNext(result.ok ? result.data[0] ?? null : null); });
    return () => { active = false; };
  }, [queueVersion, roomId]);

  useEffect(() => {
    if (!mediaState?.playing) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [mediaState?.playing]);

  if (!mediaState) return null;
  const current = details?.mediaId === mediaId ? details : null;
  const title = current?.title || mediaState.title;
  const position = expectedPosition(mediaState, now);

  const togglePlayback = () => {
    const eventType = mediaState.playing ? 'pause' : 'play';
    broadcastEvent(eventType, {
      url: mediaState.url,
      title: mediaState.title,
      time: expectedPosition(mediaState, Date.now()),
      speed: mediaState.speed,
      playing: !mediaState.playing,
      sourceType: mediaState.sourceType,
      castId: mediaState.castId,
      mediaId: mediaState.mediaId,
      muted: mediaState.muted,
      volume: mediaState.volume,
    });
  };

  return (
    <section className="now-playing-bar" aria-label="Now playing in this room">
      <span className={`now-playing-pulse ${mediaState.playing ? 'is-playing' : ''}`} aria-hidden="true" />
      <button type="button" className="now-playing-main" onClick={onOpen} aria-label={`Open Watch: ${title}`}>
        <span className="now-playing-title">{title}</span>
        <span className="now-playing-meta">
          {[current?.artist, `${mediaState.playing ? 'Playing' : 'Paused'} · ${formatPlaybackTime(position)}`, next?.media ? `Next: ${next.media.title || next.media.file_name}` : null].filter(Boolean).join(' · ')}
        </span>
      </button>
      {canControlMedia && (
        <button type="button" className="now-playing-toggle" onClick={togglePlayback} aria-label={mediaState.playing ? 'Pause for the room' : 'Play for the room'}>
          <OmniIcon name={mediaState.playing ? 'pause' : 'play'} size={14} />
          <span className="sr-only">{mediaState.playing ? 'Pause' : 'Play'}</span>
        </button>
      )}
    </section>
  );
}
