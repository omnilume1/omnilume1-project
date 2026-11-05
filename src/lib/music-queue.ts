import type { MusicTrack, RepeatMode } from './music-model';
import { MUSIC_BACK_RESTART_MS } from './music-model';

/**
 * Two tiers: `context` (the list that was started, maybe shuffled) and `user`
 * (hand-queued "Play Next" / "Add to Queue", always played first).
 * shortcut: no autoplay/radio tier, add one when a track source can suggest more.
 */
export type MusicQueue = {
  original: MusicTrack[];
  context: MusicTrack[];
  index: number;
  user: MusicTrack[];
  current: MusicTrack | null;
  currentFromUser: boolean;
  source: string;
  shuffle: boolean;
  repeat: RepeatMode;
};

export const emptyQueue: MusicQueue = {
  original: [], context: [], index: -1, user: [], current: null, currentFromUser: false, source: '', shuffle: false, repeat: 'off',
};

export type Rng = () => number;

function shuffled<T>(items: T[], rng: Rng): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function startList(queue: MusicQueue, tracks: MusicTrack[], startIndex: number, source: string, rng: Rng = Math.random): MusicQueue {
  const start = Math.max(0, Math.min(tracks.length - 1, startIndex));
  const picked = tracks[start];
  if (!picked) return queue;
  const context = queue.shuffle ? [picked, ...shuffled(tracks.filter((_, i) => i !== start), rng)] : tracks;
  const index = queue.shuffle ? 0 : start;
  return { ...queue, original: tracks, context, index, current: context[index], currentFromUser: false, source };
}

export function playNext(queue: MusicQueue, track: MusicTrack): MusicQueue {
  if (!queue.current) return { ...queue, current: track, currentFromUser: true, source: queue.source || 'Queue' };
  return { ...queue, user: [track, ...queue.user.filter((queued) => queued.id !== track.id)] };
}

export function addToQueue(queue: MusicQueue, track: MusicTrack): MusicQueue {
  if (!queue.current) return playNext(queue, track);
  if (queue.user.some((queued) => queued.id === track.id)) return queue;
  return { ...queue, user: [...queue.user, track] };
}

/** Returns the same object when nothing follows (end of list, repeat off). */
export function next(queue: MusicQueue): MusicQueue {
  const [head, ...rest] = queue.user;
  if (head) return { ...queue, user: rest, current: head, currentFromUser: true };
  let index = queue.index + 1;
  if (index >= queue.context.length) {
    if (queue.repeat !== 'all' || queue.context.length === 0) return queue;
    index = 0;
  }
  return { ...queue, index, current: queue.context[index], currentFromUser: false };
}

/** "restart" = seek the current track to 0 instead of moving. */
export function previous(queue: MusicQueue, positionMs: number): MusicQueue | 'restart' {
  if (!queue.current || positionMs > MUSIC_BACK_RESTART_MS) return 'restart';
  if (queue.currentFromUser && queue.context[queue.index]) {
    return { ...queue, current: queue.context[queue.index], currentFromUser: false };
  }
  let index = queue.index - 1;
  if (index < 0) {
    if (queue.repeat !== 'all' || queue.context.length === 0) return 'restart';
    index = queue.context.length - 1;
  }
  return { ...queue, index, current: queue.context[index], currentFromUser: false };
}

export type UpNextTier = 'user' | 'context';

export function upNext(queue: MusicQueue) {
  return { user: queue.user, context: queue.context.slice(queue.index + 1) };
}

/** `i` is the row index inside its Up Next tier. */
export function jumpTo(queue: MusicQueue, tier: UpNextTier, i: number): MusicQueue {
  if (tier === 'user') {
    const track = queue.user[i];
    return track ? { ...queue, user: queue.user.slice(i + 1), current: track, currentFromUser: true } : queue;
  }
  const index = queue.index + 1 + i;
  const track = queue.context[index];
  return track ? { ...queue, index, current: track, currentFromUser: false } : queue;
}

export function removeUpcoming(queue: MusicQueue, tier: UpNextTier, i: number): MusicQueue {
  if (tier === 'user') return { ...queue, user: queue.user.filter((_, at) => at !== i) };
  const index = queue.index + 1 + i;
  const track = queue.context[index];
  if (!track) return queue;
  return {
    ...queue,
    context: queue.context.filter((_, at) => at !== index),
    original: queue.original.filter((item) => item !== track),
  };
}

export function moveUpcoming(queue: MusicQueue, tier: UpNextTier, from: number, to: number): MusicQueue {
  const list = tier === 'user' ? [...queue.user] : queue.context.slice(queue.index + 1);
  if (!list[from] || to < 0 || to >= list.length || from === to) return queue;
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  return tier === 'user'
    ? { ...queue, user: list }
    : { ...queue, context: [...queue.context.slice(0, queue.index + 1), ...list] };
}

/** Clear only removes hand-queued tracks; the started list keeps playing. */
export function clearUpcoming(queue: MusicQueue): MusicQueue {
  return { ...queue, user: [] };
}

export function setShuffle(queue: MusicQueue, on: boolean, rng: Rng = Math.random): MusicQueue {
  if (on === queue.shuffle) return queue;
  const anchor = queue.context[queue.index];
  if (on) {
    const rest = queue.original.filter((track) => track !== anchor);
    return anchor
      ? { ...queue, shuffle: true, context: [anchor, ...shuffled(rest, rng)], index: 0 }
      : { ...queue, shuffle: true, context: shuffled(rest, rng) };
  }
  return { ...queue, shuffle: false, context: queue.original, index: anchor ? queue.original.indexOf(anchor) : -1 };
}

export function cycleRepeat(repeat: RepeatMode): RepeatMode {
  return repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off';
}
