'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createAudioEngine } from '@/lib/music-audio-engine';
import { MUSIC_PREFS_KEY, type MusicEngine, type MusicTrack, type RepeatMode } from '@/lib/music-model';
import * as Q from '@/lib/music-queue';
import { LISTEN_DRIFT_MS } from '@/lib/music-together';
import { createClient } from '@/utils/supabase/client';

type MusicActions = {
  playList: (tracks: MusicTrack[], index: number, source: string) => void;
  toggle: () => void;
  play: () => void;
  pause: () => void;
  next: () => void;
  previous: () => void;
  seek: (ms: number) => void;
  setVolume: (volume: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  playNext: (track: MusicTrack) => void;
  addToQueue: (track: MusicTrack) => void;
  jumpTo: (tier: Q.UpNextTier, i: number) => void;
  remove: (tier: Q.UpNextTier, i: number) => void;
  move: (tier: Q.UpNextTier, from: number, to: number) => void;
  clearUpcoming: () => void;
  stop: () => void;
  /** Listen Together: while set, playback controls are sent here instead of played locally. */
  setRemote: (remote: MusicRemote | null) => void;
  /** Listen Together: make local audio follow the shared state (never echoed back). */
  applyRemote: (state: { track: MusicTrack | null; positionMs: number; playing: boolean }) => void;
};

export type MusicRemote = {
  play: (positionMs: number) => void;
  pause: (positionMs: number) => void;
  seek: (positionMs: number) => void;
  /** Advance past `fromUploadId` (the server ignores a stale advance). */
  next: (fromUploadId: string | null) => void;
  load: (track: MusicTrack) => void;
  enqueue: (track: MusicTrack) => void;
  leave: () => void;
};

export type MusicPlayer = MusicActions & {
  queue: Q.MusicQueue;
  isPlaying: boolean;
  positionMs: number;
  durationMs: number;
  volume: number;
  muted: boolean;
  /** Set when the current song cannot be played (expired, revoked, unreadable). */
  error: string | null;
};

const MusicPlayerContext = createContext<MusicPlayer | null>(null);
const REPEAT_MODES: RepeatMode[] = ['off', 'all', 'one'];

function readPrefs() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(MUSIC_PREFS_KEY) ?? '{}') as Record<string, unknown>;
    return {
      shuffle: raw.shuffle === true,
      repeat: REPEAT_MODES.includes(raw.repeat as RepeatMode) ? (raw.repeat as RepeatMode) : 'off',
      volume: typeof raw.volume === 'number' && raw.volume >= 0 && raw.volume <= 1 ? raw.volume : 1,
      muted: raw.muted === true,
    };
  } catch {
    return null;
  }
}

export function MusicPlayerProvider({ children }: { children: ReactNode }) {
  const engineRef = useRef<MusicEngine | null>(null);
  const queueRef = useRef(Q.emptyQueue);
  const playingRef = useRef(false);
  const volumeRef = useRef({ volume: 1, muted: false });
  const prefsReady = useRef(false);
  const remoteRef = useRef<MusicRemote | null>(null);
  const [queue, setQueue] = useState(Q.emptyQueue);
  const [isPlaying, setIsPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [volume, setVolumeState] = useState(1);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const actions = useMemo<MusicActions>(() => {
    const engine = () => (engineRef.current ??= createAudioEngine());
    const commit = (next: Q.MusicQueue) => {
      queueRef.current = next;
      setQueue(next);
    };
    const loadAndPlay = (next: Q.MusicQueue) => {
      commit(next);
      setError(null);
      if (!next.current) return;
      engine().load(next.current);
      engine().play();
    };
    const setVolume = (value: number) => {
      const clamped = Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
      volumeRef.current = { volume: clamped, muted: false };
      setVolumeState(clamped);
      setMuted(false);
      engine().setVolume(clamped, false);
    };
    const update = (change: (queue: Q.MusicQueue) => Q.MusicQueue) => commit(change(queueRef.current));
    const startIfIdle = (next: Q.MusicQueue) => (queueRef.current.current ? commit(next) : loadAndPlay(next));
    const remote = () => remoteRef.current;
    const position = () => Math.round(engine().currentTime());

    return {
      playList: (tracks, index, source) => {
        const shared = remote();
        if (!shared) loadAndPlay(Q.startList(queueRef.current, tracks, index, source));
        else if (tracks[index]) shared.load(tracks[index]);
      },
      toggle: () => {
        const shared = remote();
        if (shared) {
          if (playingRef.current) shared.pause(position());
          else shared.play(position());
        } else if (playingRef.current) engine().pause();
        else if (queueRef.current.current) engine().play();
      },
      play: () => {
        const shared = remote();
        if (shared) shared.play(position());
        else if (queueRef.current.current) engine().play();
      },
      pause: () => {
        const shared = remote();
        if (shared) shared.pause(position());
        else engine().pause();
      },
      next: () => {
        const shared = remote();
        if (shared) return shared.next(queueRef.current.current?.uploadId ?? null);
        const next = Q.next(queueRef.current);
        if (next !== queueRef.current) loadAndPlay(next);
      },
      previous: () => {
        const shared = remote();
        if (shared) return shared.seek(0);
        const prev = Q.previous(queueRef.current, engine().currentTime());
        if (prev === 'restart') engine().seek(0);
        else loadAndPlay(prev);
      },
      seek: (ms) => {
        const shared = remote();
        if (shared) shared.seek(Math.max(0, Math.round(ms)));
        else engine().seek(ms);
      },
      setVolume,
      toggleMute: () => {
        const nextMuted = !volumeRef.current.muted;
        volumeRef.current = { ...volumeRef.current, muted: nextMuted };
        setMuted(nextMuted);
        engine().setVolume(volumeRef.current.volume, nextMuted);
      },
      toggleShuffle: () => update((queue) => Q.setShuffle(queue, !queue.shuffle)),
      cycleRepeat: () => update((queue) => ({ ...queue, repeat: Q.cycleRepeat(queue.repeat) })),
      playNext: (track) => {
        const shared = remote();
        if (shared) shared.enqueue(track);
        else startIfIdle(Q.playNext(queueRef.current, track));
      },
      addToQueue: (track) => {
        const shared = remote();
        if (shared) shared.enqueue(track);
        else startIfIdle(Q.addToQueue(queueRef.current, track));
      },
      jumpTo: (tier, i) => loadAndPlay(Q.jumpTo(queueRef.current, tier, i)),
      remove: (tier, i) => update((queue) => Q.removeUpcoming(queue, tier, i)),
      move: (tier, from, to) => update((queue) => Q.moveUpcoming(queue, tier, from, to)),
      clearUpcoming: () => update(Q.clearUpcoming),
      stop: () => {
        remote()?.leave();
        engine().pause();
        engine().seek(0);
        const { shuffle, repeat } = queueRef.current;
        commit({ ...Q.emptyQueue, shuffle, repeat });
      },
      setRemote: (next) => {
        remoteRef.current = next;
      },
      applyRemote: ({ track, positionMs, playing }) => {
        if (!track) {
          engine().pause();
          return;
        }
        if (queueRef.current.current?.uploadId !== track.uploadId) {
          commit(Q.startList(queueRef.current, [track], 0, 'Listen Together'));
          setError(null);
          engine().load(track);
          engine().seek(positionMs);
        } else if (Math.abs(engine().currentTime() - positionMs) > LISTEN_DRIFT_MS) {
          engine().seek(positionMs);
        }
        if (playing && !playingRef.current) engine().play();
        else if (!playing && playingRef.current) engine().pause();
      },
    };
  }, []);

  // Engine events. The engine lives for the whole app (root layout), so only listeners are removed.
  useEffect(() => {
    const engine = (engineRef.current ??= createAudioEngine());
    const offs = [
      engine.on('time', () => {
        const position = engine.currentTime();
        const duration = engine.duration();
        setPositionMs(position);
        setDurationMs(duration);
        if (duration > 0 && 'mediaSession' in navigator) {
          try {
            navigator.mediaSession.setPositionState({ duration: duration / 1000, position: Math.min(position, duration) / 1000, playbackRate: 1 });
          } catch {
            // Position state is optional; some browsers reject it before metadata exists.
          }
        }
      }),
      engine.on('play', () => {
        playingRef.current = true;
        setIsPlaying(true);
      }),
      engine.on('pause', () => {
        playingRef.current = false;
        setIsPlaying(false);
      }),
      engine.on('error', () => {
        playingRef.current = false;
        setIsPlaying(false);
        setError('This song isn’t available any more.');
      }),
      engine.on('ended', () => {
        const queue = queueRef.current;
        if (remoteRef.current) {
          remoteRef.current.next(queue.current?.uploadId ?? null);
          return;
        }
        if (queue.repeat === 'one') {
          engine.seek(0);
          engine.play();
          return;
        }
        if (Q.next(queue) === queue) engine.seek(0);
        else actions.next();
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [actions]);

  // Preferences: read once after mount (avoids a hydration mismatch), then persist.
  useEffect(() => {
    const prefs = readPrefs();
    prefsReady.current = true;
    if (!prefs) return;
    queueRef.current = { ...queueRef.current, shuffle: prefs.shuffle, repeat: prefs.repeat };
    volumeRef.current = { volume: prefs.volume, muted: prefs.muted };
    engineRef.current?.setVolume(prefs.volume, prefs.muted);
    setQueue(queueRef.current);
    setVolumeState(prefs.volume);
    setMuted(prefs.muted);
  }, []);

  useEffect(() => {
    if (!prefsReady.current) return;
    try {
      window.localStorage.setItem(MUSIC_PREFS_KEY, JSON.stringify({ shuffle: queue.shuffle, repeat: queue.repeat, volume, muted }));
    } catch {
      // Storage can be full or blocked; preferences are optional.
    }
  }, [queue.shuffle, queue.repeat, volume, muted]);

  // Media Session: lock-screen / hardware keys.
  const current = queue.current;

  // Listening history (owner-only RLS); plays of uploads only, deduped server-side.
  const uploadId = current?.uploadId;
  useEffect(() => {
    if (!uploadId) return;
    createClient().rpc('record_music_play', { p_upload_id: uploadId }).then(({ error: recordError }: { error: { code?: string } | null }) => {
      if (recordError) console.warn('Listening history was not updated.', recordError.code);
    });
  }, [uploadId]);

  // "Listening to …" for friends. The server copies title/artist and applies privacy and audience;
  // friends treat a row older than 5 min as gone, so a 2 min heartbeat covers closed tabs.
  const publishedRef = useRef(false);
  useEffect(() => {
    const live = Boolean(uploadId && isPlaying);
    if (!live && !publishedRef.current) return;
    const send = (id: string | null) => {
      publishedRef.current = id !== null;
      createClient().rpc('set_music_now_playing', { p_upload_id: id }).then(({ error: presenceError }: { error: { code?: string } | null }) => {
        if (presenceError) console.warn('Listening status was not updated.', presenceError.code);
      });
    };
    if (!live) return send(null);
    send(uploadId!);
    const timer = window.setInterval(() => send(uploadId!), 120_000);
    return () => window.clearInterval(timer);
  }, [uploadId, isPlaying]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = current
      ? new MediaMetadata({ title: current.title, artist: current.artist, album: current.album, artwork: current.artwork ? [{ src: current.artwork }] : [] })
      : null;
  }, [current]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = current ? (isPlaying ? 'playing' : 'paused') : 'none';
  }, [current, isPlaying]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const session = navigator.mediaSession;
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', actions.play],
      ['pause', actions.pause],
      ['previoustrack', actions.previous],
      ['nexttrack', actions.next],
      ['seekto', (details) => details.seekTime !== undefined && actions.seek(details.seekTime * 1000)],
    ];
    for (const [action, handler] of handlers) {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // Unsupported action in this browser.
      }
    }
    return () => handlers.forEach(([action]) => {
      try {
        session.setActionHandler(action, null);
      } catch {
        // Unsupported action in this browser.
      }
    });
  }, [actions]);

  const value = useMemo<MusicPlayer>(
    () => ({ ...actions, queue, isPlaying, positionMs, durationMs, volume, muted, error }),
    [actions, queue, isPlaying, positionMs, durationMs, volume, muted, error],
  );

  return <MusicPlayerContext.Provider value={value}>{children}</MusicPlayerContext.Provider>;
}

export function useMusicPlayer() {
  const player = useContext(MusicPlayerContext);
  if (!player) throw new Error('useMusicPlayer must be used inside MusicPlayerProvider');
  return player;
}
