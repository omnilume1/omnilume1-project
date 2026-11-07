import { logCastHistory } from '@/actions/media';
import type { MediaSearchResult, PlaylistItem } from '@/lib/media-search';
import { addToQueue, moveInQueue } from '@/lib/watch-queue-data';

// Links from paste, drop, share, search and playlists all go through the same
// server checks as the Cast box: logCastHistory registers the link (needs
// watch_control) and members only ever receive the resulting media id.

export type LinkOutcome = { ok: true } | { ok: false; error: string };

export async function registerLink(roomId: string, title: string, url: string): Promise<{ ok: true; mediaId: string } | { ok: false; error: string }> {
  const logged = await logCastHistory(roomId, title, url);
  if (!logged.success || !logged.mediaId) return { ok: false, error: logged.error ?? 'The link could not be added.' };
  return { ok: true, mediaId: logged.mediaId };
}

// 'next' puts the link at the top of the queue, 'last' at the end.
export async function queueLink(roomId: string, title: string, url: string, place: 'next' | 'last' = 'last'): Promise<LinkOutcome> {
  const registered = await registerLink(roomId, title, url);
  if (!registered.ok) return registered;
  const queued = await addToQueue(roomId, registered.mediaId);
  if (!queued.ok) return queued;
  if (place === 'next') {
    const moved = await moveInQueue(queued.data, 0);
    if (!moved.ok) return moved;
  }
  return { ok: true };
}

export async function fetchPlaylist(playlistId: string): Promise<{ ok: true; items: PlaylistItem[] } | { ok: false; error: string }> {
  try {
    const response = await fetch(`/api/media/playlist?id=${encodeURIComponent(playlistId)}`);
    const json = await response.json() as { items?: PlaylistItem[]; error?: string };
    return response.ok && json.items ? { ok: true, items: json.items } : { ok: false, error: json.error ?? 'The playlist could not be loaded.' };
  } catch {
    return { ok: false, error: 'The playlist could not be loaded. Check your connection.' };
  }
}

// Adds videos one by one (the queue keeps its order) and stops at the first
// refusal, such as a full queue, reporting how many made it in.
export async function importPlaylist(roomId: string, items: PlaylistItem[], onProgress: (done: number, total: number) => void): Promise<{ added: number; error?: string }> {
  let added = 0;
  for (const item of items) {
    onProgress(added, items.length);
    const result = await queueLink(roomId, item.title, item.url);
    if (!result.ok) return { added, error: result.error };
    added += 1;
  }
  onProgress(added, items.length);
  return { added };
}

export async function searchMedia(source: MediaSearchResult['source'], query: string): Promise<{ ok: true; results: MediaSearchResult[] } | { ok: false; error: string }> {
  try {
    const response = await fetch(`/api/media/search?source=${source}&q=${encodeURIComponent(query)}`);
    const json = await response.json() as { results?: MediaSearchResult[]; error?: string };
    return response.ok && json.results ? { ok: true, results: json.results } : { ok: false, error: json.error ?? 'Search did not work. Try again.' };
  } catch {
    return { ok: false, error: 'Search did not work. Check your connection.' };
  }
}
