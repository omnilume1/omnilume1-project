import type { MusicEngine, MusicEngineEvent } from './music-model';

/** HTMLAudioElement engine. The element is created on first use (browser only). */
export function createAudioEngine(): MusicEngine {
  const listeners = new Map<MusicEngineEvent, Set<() => void>>();
  const emit = (event: MusicEngineEvent) => listeners.get(event)?.forEach((listener) => listener());
  let audio: HTMLAudioElement | null = null;
  let fallbackDurationMs = 0;
  let volume = { level: 1, muted: false };

  const element = () => {
    if (audio) return audio;
    audio = new Audio();
    audio.preload = 'auto';
    audio.volume = volume.level;
    audio.muted = volume.muted;
    for (const name of ['timeupdate', 'durationchange', 'seeked', 'loadedmetadata']) audio.addEventListener(name, () => emit('time'));
    audio.addEventListener('play', () => emit('play'));
    audio.addEventListener('pause', () => emit('pause'));
    audio.addEventListener('ended', () => emit('ended'));
    audio.addEventListener('error', () => {
      if (audio?.getAttribute('src')) emit('error');
    });
    return audio;
  };

  return {
    load(track) {
      const media = element();
      fallbackDurationMs = track.durationMs;
      media.src = track.src ?? '';
      media.load();
      emit('time');
    },
    play() {
      element().play().catch((error: unknown) => {
        // AbortError = a newer load() replaced this play; anything else (autoplay block) leaves us paused.
        if (!(error instanceof DOMException && error.name === 'AbortError')) emit('pause');
      });
    },
    pause() {
      audio?.pause();
    },
    seek(ms) {
      if (audio) audio.currentTime = Math.max(0, ms / 1000);
    },
    setVolume(level, muted) {
      volume = { level, muted };
      if (audio) {
        audio.volume = level;
        audio.muted = muted;
      }
    },
    currentTime: () => (audio ? audio.currentTime * 1000 : 0),
    duration: () => (audio && Number.isFinite(audio.duration) ? audio.duration * 1000 : fallbackDurationMs),
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
      return () => listeners.get(event)?.delete(listener);
    },
    destroy() {
      audio?.pause();
      audio?.removeAttribute('src');
      audio?.load();
      listeners.clear();
    },
  };
}
