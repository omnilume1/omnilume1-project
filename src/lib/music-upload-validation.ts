// Shared by the browser upload flow and POST /api/music/uploads. The database
// (register_music_upload) stays authoritative for caps and the 7-day expiry.

export const MUSIC_BUCKET = 'music_uploads';
export const MUSIC_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MUSIC_MAX_COVER_BYTES = 2 * 1024 * 1024;
export const MUSIC_MAX_ACTIVE_FILES = 40;
export const MUSIC_MAX_TOTAL_BYTES = 300 * 1024 * 1024;
export const MUSIC_MAX_LYRICS_CHARS = 20_000;

export const MUSIC_AUDIO_TYPES = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  webm: 'audio/webm',
} as const;
export type MusicAudioExt = keyof typeof MUSIC_AUDIO_TYPES;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

export function audioExtension(fileName: string): MusicAudioExt | null {
  const ext = fileName.toLowerCase().match(/\.([a-z0-9]{2,5})$/)?.[1];
  return ext && ext in MUSIC_AUDIO_TYPES ? (ext as MusicAudioExt) : null;
}

export const musicObjectPath = (ownerId: string, uploadId: string, ext: MusicAudioExt) => `${ownerId}/${uploadId}.${ext}`;
export const musicCoverPath = (ownerId: string, uploadId: string) => `${ownerId}/${uploadId}.cover.jpg`;

/** Signed-URL lifetime: at most 1 hour and never past the upload's expiry (0 = expired). */
export function signedUrlTtlSeconds(expiresAt: string, nowMs: number): number {
  const remaining = Math.floor((Date.parse(expiresAt) - nowMs) / 1000);
  return Number.isFinite(remaining) ? Math.max(0, Math.min(3600, remaining)) : 0;
}

const ascii = (bytes: Uint8Array, start: number, text: string) => [...text].every((char, i) => bytes[start + i] === char.charCodeAt(0));

/** Magic-byte check on the first 12+ bytes; the bucket's MIME list only trusts the client's Content-Type. */
export function sniffAudio(bytes: Uint8Array, ext: MusicAudioExt): boolean {
  if (bytes.length < 12) return false;
  const id3 = ascii(bytes, 0, 'ID3');
  const mpegSync = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  switch (ext) {
    case 'mp3': return id3 || mpegSync;
    case 'flac': return ascii(bytes, 0, 'fLaC') || id3;
    case 'ogg': case 'oga': case 'opus': return ascii(bytes, 0, 'OggS');
    case 'wav': return ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WAVE');
    case 'm4a': return ascii(bytes, 4, 'ftyp');
    case 'aac': return id3 || (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0);
    case 'webm': return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  }
}

/** Text-only, trimmed, control characters removed, length-capped. */
export function cleanTag(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, max);
}

const intIn = (value: unknown, min: number, max: number) =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;

export type MusicRegisterInput = {
  uploadId: string;
  ext: MusicAudioExt;
  mimeType: string;
  originalName: string;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  trackNo: number | null;
  year: number | null;
  genre: string;
  durationMs: number | null;
  hue: number;
  lyrics: string;
  hasCover: boolean;
};

export function parseRegisterBody(body: unknown): MusicRegisterInput | string {
  if (!body || typeof body !== 'object') return 'Invalid request.';
  const input = body as Record<string, unknown>;
  if (!isUuid(input.uploadId)) return 'Invalid upload id.';
  const ext = typeof input.ext === 'string' && input.ext in MUSIC_AUDIO_TYPES ? (input.ext as MusicAudioExt) : null;
  if (!ext) return 'Unsupported audio format.';
  const originalName = cleanTag(input.originalName, 180);
  const title = cleanTag(input.title, 200) || originalName.replace(/\.[^.]+$/, '').slice(0, 200);
  if (!originalName || !title) return 'A file name is required.';
  const lyrics = typeof input.lyrics === 'string' ? input.lyrics.replace(/\r\n?/g, '\n').slice(0, MUSIC_MAX_LYRICS_CHARS) : '';
  return {
    uploadId: input.uploadId,
    ext,
    mimeType: MUSIC_AUDIO_TYPES[ext],
    originalName,
    title,
    artist: cleanTag(input.artist, 200),
    album: cleanTag(input.album, 200),
    albumArtist: cleanTag(input.albumArtist, 200),
    trackNo: intIn(input.trackNo, 1, 999),
    year: intIn(input.year, 1000, 9999),
    genre: cleanTag(input.genre, 80),
    durationMs: intIn(input.durationMs, 0, 86_400_000),
    hue: intIn(input.hue, 0, 359) ?? 260,
    lyrics,
    hasCover: input.hasCover === true,
  };
}
