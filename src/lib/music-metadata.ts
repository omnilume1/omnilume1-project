// MusicBrainz recording search → tag candidates for "Fix tags" (16.13, part).
// Pure helpers shared by the server route and the browser dialog.

import { cleanTag, isUuid } from './music-upload-validation';

export type TagCandidate = {
  recordingId: string;
  releaseId: string | null;
  title: string;
  artist: string;
  album: string;
  year: number | null;
  trackNo: number | null;
  durationMs: number | null;
  score: number;
};

export const MUSICBRAINZ_SEARCH = 'https://musicbrainz.org/ws/2/recording';

/** Lucene phrase query on title (+ artist); the album is left out because it is often what needs fixing. */
export function musicBrainzQuery(tags: { title: string; artist?: string }) {
  const phrase = (value: string) => `"${value.slice(0, 200).replace(/[\\"]/g, (char) => `\\${char}`)}"`;
  const parts = [`recording:${phrase(tags.title)}`];
  if (tags.artist && tags.artist !== 'Unknown Artist') parts.push(`artist:${phrase(tags.artist)}`);
  return parts.join(' AND ');
}

const intOrNull = (value: unknown, min: number, max: number) => {
  const number = typeof value === 'string' ? Number.parseInt(value, 10) : typeof value === 'number' ? value : NaN;
  return Number.isInteger(number) && number >= min && number <= max ? number : null;
};

type Credit = { name?: unknown; joinphrase?: unknown };
const credits = (list: unknown) => Array.isArray(list)
  ? (list as Credit[]).map((credit) => `${typeof credit.name === 'string' ? credit.name : ''}${typeof credit.joinphrase === 'string' ? credit.joinphrase : ''}`).join('')
  : '';

/** Up to 5 candidates; text cleaned and capped; anything malformed is skipped. */
export function parseMusicBrainz(json: unknown): TagCandidate[] {
  const recordings = json && typeof json === 'object' ? (json as { recordings?: unknown }).recordings : null;
  if (!Array.isArray(recordings)) return [];
  const out: TagCandidate[] = [];
  for (const raw of recordings) {
    if (out.length >= 5) break;
    if (!raw || typeof raw !== 'object') continue;
    const recording = raw as Record<string, unknown>;
    const title = cleanTag(recording.title, 200);
    if (!isUuid(recording.id) || !title) continue;
    const release = Array.isArray(recording.releases) ? (recording.releases[0] as Record<string, unknown> | undefined) : undefined;
    const media = release && Array.isArray(release.media) ? (release.media[0] as Record<string, unknown> | undefined) : undefined;
    const track = media && Array.isArray(media.track) ? (media.track[0] as Record<string, unknown> | undefined) : undefined;
    out.push({
      recordingId: recording.id,
      releaseId: release && isUuid(release.id) ? release.id : null,
      title,
      artist: cleanTag(credits(recording['artist-credit']), 200),
      album: cleanTag(release?.title, 200),
      year: intOrNull(typeof release?.date === 'string' ? release.date.slice(0, 4) : null, 1000, 9999),
      trackNo: intOrNull(track?.number, 1, 999),
      durationMs: intOrNull(recording.length, 0, 86_400_000),
      score: intOrNull(recording.score, 0, 100) ?? 0,
    });
  }
  return out;
}

/** Cover Art Archive front image for a release (sizes 250/500/1200). */
export function coverArtUrl(releaseId: string, size: 250 | 500 | 1200) {
  return isUuid(releaseId) ? `https://coverartarchive.org/release/${releaseId}/front-${size}` : null;
}
