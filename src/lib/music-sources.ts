// Custom sources (decision 9): a user-added JSON manifest implementing OmniLume's
// contract. Everything here runs in the browser; the server never fetches a source.
//
// Manifest  GET <manifest URL> →
//   { "omnilume": 1, "name": "My source", "search": "https://host/search?q={query}", "health": "https://host/health" }
// Search    GET <search with {query} replaced> →
//   { "tracks": [{ "id": "1", "title": "…", "artist": "…", "album": "…", "durationMs": 180000,
//                  "artwork": "https://…/a.jpg", "audio": "https://…/a.mp3" }] }
// Every URL must be https:// (or http://localhost for local development) and CORS-enabled.

import type { MusicTrack } from './music-model';
import { cleanTag } from './music-upload-validation';

export const MUSIC_MAX_SOURCES = 10;
const MAX_URL = 500;
const MAX_TRACKS = 50;
const MAX_BODY_CHARS = 1_000_000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/** Same rule as the music_custom_sources CHECKs. */
export function isSourceUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_URL || /\s/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));
}

export type SourceManifest = { name: string; searchUrl: string; healthUrl: string | null };

export function parseManifest(json: unknown): SourceManifest | string {
  if (!json || typeof json !== 'object') return 'The manifest is not a JSON object.';
  const manifest = json as Record<string, unknown>;
  if (manifest.omnilume !== 1) return 'The manifest must declare "omnilume": 1.';
  const name = cleanTag(manifest.name, 60);
  if (!name) return 'The manifest needs a "name".';
  if (!isSourceUrl(manifest.search) || !manifest.search.includes('{query}')) return '"search" must be an https URL containing {query}.';
  if (manifest.health !== undefined && manifest.health !== null && !isSourceUrl(manifest.health)) return '"health" must be an https URL.';
  return { name, searchUrl: manifest.search, healthUrl: (manifest.health as string | undefined) ?? null };
}

export function searchUrlFor(template: string, query: string) {
  return template.split('{query}').join(encodeURIComponent(query.trim().slice(0, 100)));
}

function hueOf(text: string) {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

/** Invalid entries are dropped, not fatal; text is plain and length-capped; at most 50 tracks. */
export function parseSearchResults(json: unknown, source: { id: string; name: string }): MusicTrack[] {
  const list = json && typeof json === 'object' ? (json as { tracks?: unknown }).tracks : null;
  if (!Array.isArray(list)) return [];
  const tracks: MusicTrack[] = [];
  for (const raw of list) {
    if (tracks.length >= MAX_TRACKS) break;
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const id = cleanTag(typeof item.id === 'number' ? String(item.id) : item.id, 200);
    const title = cleanTag(item.title, 200);
    if (!id || !title || !isSourceUrl(item.audio)) continue;
    const duration = typeof item.durationMs === 'number' && Number.isFinite(item.durationMs) ? Math.round(item.durationMs) : 0;
    tracks.push({
      id: `source:${source.id}:${id}`,
      title,
      artist: cleanTag(item.artist, 200) || 'Unknown Artist',
      album: cleanTag(item.album, 200) || source.name,
      durationMs: Math.max(0, Math.min(86_400_000, duration)),
      hue: hueOf(`${source.id}:${id}`),
      artwork: isSourceUrl(item.artwork) ? item.artwork : undefined,
      src: item.audio,
      sourceName: source.name,
      available: true,
    });
  }
  return tracks;
}

/** Browser-only GET: no cookies, no referrer, no redirects, 8 s timeout. */
export async function fetchSource(url: string): Promise<Response> {
  if (!isSourceUrl(url)) throw new Error('This address is not allowed.');
  let response: Response;
  try {
    // `cache` is a browser RequestInit field (absent from Node's typings used by the unit tests).
    response = await fetch(url, {
      credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store',
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000),
    } as RequestInit);
  } catch {
    throw new Error('Not reachable (network error, timeout, redirect or missing CORS headers).');
  }
  if (!response.ok) throw new Error(`The source answered ${response.status}.`);
  return response;
}

/** fetchSource + a 1 MB cap + JSON parse. */
export async function fetchSourceJson(url: string): Promise<unknown> {
  const text = await (await fetchSource(url)).text();
  if (text.length > MAX_BODY_CHARS) throw new Error('The response is too large.');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('The response is not valid JSON.');
  }
}
