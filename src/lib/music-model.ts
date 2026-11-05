export type MusicTrack = {
  id: string;
  title: string;
  artist: string;
  album: string;
  albumId?: string;
  durationMs: number;
  /** Fixture artwork colour (0-359). Real uploads use `artwork` instead. */
  hue: number;
  artwork?: string;
  src?: string;
  lyrics?: { ms: number; text: string }[];
};

export type RepeatMode = 'off' | 'all' | 'one';
export type MusicEngineEvent = 'time' | 'play' | 'pause' | 'ended';

export interface MusicEngine {
  load(track: MusicTrack): void;
  play(): void;
  pause(): void;
  seek(ms: number): void;
  setVolume(volume: number, muted: boolean): void;
  currentTime(): number;
  duration(): number;
  on(event: MusicEngineEvent, listener: () => void): () => void;
  destroy(): void;
}

export const MUSIC_PREFS_KEY = 'omnilume:music:prefs';
export const MUSIC_BACK_RESTART_MS = 10_000;

export function formatMusicTime(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Clock-only engine: fixtures have no audio, so time advances without sound. */
export function createSilentEngine(now: () => number = Date.now): MusicEngine {
  const listeners = new Map<MusicEngineEvent, Set<() => void>>();
  let durationMs = 0;
  let offsetMs = 0;
  let startedAt: number | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const emit = (event: MusicEngineEvent) => listeners.get(event)?.forEach((listener) => listener());
  const position = () => Math.min(durationMs, offsetMs + (startedAt === null ? 0 : now() - startedAt));
  const stopClock = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const tick = () => {
    emit('time');
    if (durationMs > 0 && position() >= durationMs) {
      offsetMs = durationMs;
      startedAt = null;
      stopClock();
      emit('pause');
      emit('ended');
    }
  };

  return {
    load(track) {
      stopClock();
      durationMs = track.durationMs;
      offsetMs = 0;
      startedAt = null;
      emit('time');
    },
    play() {
      if (startedAt !== null || durationMs === 0) return;
      if (offsetMs >= durationMs) offsetMs = 0;
      startedAt = now();
      timer = setInterval(tick, 250);
      emit('play');
    },
    pause() {
      if (startedAt === null) return;
      offsetMs = position();
      startedAt = null;
      stopClock();
      emit('pause');
    },
    seek(ms) {
      offsetMs = Math.max(0, Math.min(durationMs, ms));
      if (startedAt !== null) startedAt = now();
      emit('time');
    },
    setVolume() {},
    currentTime: position,
    duration: () => durationMs,
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
      return () => listeners.get(event)?.delete(listener);
    },
    destroy() {
      stopClock();
      listeners.clear();
    },
  };
}
