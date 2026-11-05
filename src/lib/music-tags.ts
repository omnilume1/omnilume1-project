// Browser-only: reads tags from a picked file before it is uploaded.
import { toLrc } from './music-lrc';
import { audioExtension, cleanTag, MUSIC_MAX_COVER_BYTES, MUSIC_MAX_LYRICS_CHARS, type MusicAudioExt } from './music-upload-validation';

export type MusicFileInfo = {
  ext: MusicAudioExt;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  trackNo: number | null;
  year: number | null;
  genre: string;
  durationMs: number | null;
  lyrics: string;
  cover: Blob | null;
  hue: number;
};

function nameHue(name: string) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

/** Saturation-weighted circular mean of a 16×16 thumbnail's hues. */
function sampleHue(bitmap: ImageBitmap, fallback: number) {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const context = canvas.getContext('2d');
  if (!context) return fallback;
  context.drawImage(bitmap, 0, 0, 16, 16);
  const { data } = context.getImageData(0, 0, 16, 16);
  let x = 0;
  let y = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), chroma = max - min;
    if (chroma < 0.08) continue;
    const hue = max === r ? ((g - b) / chroma) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
    const angle = (hue * 60 * Math.PI) / 180;
    x += Math.cos(angle) * chroma;
    y += Math.sin(angle) * chroma;
  }
  if (x === 0 && y === 0) return fallback;
  return Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);
}

/** Re-encode embedded art as JPEG ≤ 1200 px and ≤ 2 MB (drops EXIF and other metadata). */
async function toCover(source: Blob, fallbackHue: number) {
  try {
    const bitmap = await createImageBitmap(source);
    const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const hue = sampleHue(bitmap, fallbackHue);
    bitmap.close();
    for (const quality of [0.86, 0.72, 0.55]) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (blob && blob.size <= MUSIC_MAX_COVER_BYTES) return { blob, hue };
    }
    return { blob: null, hue };
  } catch {
    return null; // Unreadable artwork: the upload goes ahead without a cover.
  }
}

export async function readMusicFile(file: File): Promise<MusicFileInfo> {
  const ext = audioExtension(file.name);
  if (!ext) throw new Error('Unsupported format. Use MP3, FLAC, OGG, Opus, WAV, M4A, AAC or WebM.');
  const { parseBlob, selectCover } = await import('music-metadata');
  let meta;
  try {
    meta = await parseBlob(file, { duration: true });
  } catch {
    throw new Error('This file couldn’t be read. It may be damaged or not an audio file.');
  }
  const tags = meta.common;
  const fallbackHue = nameHue(file.name);
  const picture = selectCover(tags.picture);
  const cover = picture ? await toCover(new Blob([new Uint8Array(picture.data)], { type: picture.format }), fallbackHue) : null;
  const synced = tags.lyrics?.find((entry) => entry.syncText?.length)?.syncText;
  const lyrics = synced?.length ? toLrc(synced) : (tags.lyrics?.find((entry) => entry.text)?.text ?? '');

  return {
    ext,
    title: cleanTag(tags.title, 200) || cleanTag(file.name.replace(/\.[^.]+$/, ''), 200),
    artist: cleanTag(tags.artist, 200),
    album: cleanTag(tags.album, 200),
    albumArtist: cleanTag(tags.albumartist, 200),
    trackNo: tags.track.no ?? null,
    year: tags.year ?? null,
    genre: cleanTag(tags.genre?.[0], 80),
    durationMs: meta.format.duration ? Math.round(meta.format.duration * 1000) : null,
    lyrics: lyrics.slice(0, MUSIC_MAX_LYRICS_CHARS),
    cover: cover?.blob ?? null,
    hue: cover?.hue ?? fallbackHue,
  };
}
