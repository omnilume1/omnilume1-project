// Media metadata (Action 10): provider-neutral title/artist/album/year,
// duration and artwork read from the file's own embedded tags (MP3 ID3v2 and
// ID3v1, FLAC, MP4/M4A), with a file-name fallback. No external metadata
// service and no storage provider: callers pass a byte-range reader.
// No imports, so the unit-test build compiles it on its own.

export type MediaArtwork = { mimeType: 'image/jpeg' | 'image/png'; bytes: Uint8Array };

export type ExtractedMediaMetadata = {
  title: string | null;
  artist: string | null;
  album: string | null;
  year: string | null;
  durationSeconds: number | null;
  source: 'tags' | 'filename';
  artwork: MediaArtwork | null;
};

export type RangeReader = (start: number, endInclusive: number) => Promise<Uint8Array>;

export const MEDIA_METADATA_LIMITS = {
  tagBytes: 1_048_576,
  mp4MoovBytes: 4_194_304,
  artworkBytes: 204_800,
  text: 200,
} as const;

type RawTags = { title?: string | null; artist?: string | null; album?: string | null; year?: string | null; durationSeconds?: number | null; artwork?: MediaArtwork | null };

const latin1 = (bytes: Uint8Array) => Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
const ascii = (bytes: Uint8Array, start: number, length: number) => latin1(bytes.subarray(start, start + length));
const u32 = (bytes: Uint8Array, offset: number) => ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
const u32le = (bytes: Uint8Array, offset: number) => bytes[offset] + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16) + ((bytes[offset + 3] << 24) >>> 0);
const u24 = (bytes: Uint8Array, offset: number) => (bytes[offset] << 16) + (bytes[offset + 1] << 8) + bytes[offset + 2];
const syncsafe = (bytes: Uint8Array, offset: number) => ((bytes[offset] & 0x7f) << 21) + ((bytes[offset + 1] & 0x7f) << 14) + ((bytes[offset + 2] & 0x7f) << 7) + (bytes[offset + 3] & 0x7f);

function decodeUtf16(bytes: Uint8Array, littleEndian: boolean) {
  let out = '';
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    const code = littleEndian ? bytes[index] + (bytes[index + 1] << 8) : (bytes[index] << 8) + bytes[index + 1];
    out += String.fromCharCode(code);
  }
  return out;
}

function decodeUtf8(bytes: Uint8Array) {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return latin1(bytes);
  }
}

// ID3 text encodings: 0 ISO-8859-1, 1 UTF-16 with BOM, 2 UTF-16BE, 3 UTF-8.
function decodeId3Text(encoding: number, bytes: Uint8Array) {
  let text: string;
  if (encoding === 1) {
    const littleEndian = bytes[0] === 0xff && bytes[1] === 0xfe;
    const hasBom = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
    text = decodeUtf16(hasBom ? bytes.subarray(2) : bytes, littleEndian);
  } else if (encoding === 2) {
    text = decodeUtf16(bytes, false);
  } else if (encoding === 3) {
    text = decodeUtf8(bytes);
  } else {
    text = latin1(bytes);
  }
  // v2.4 separates multiple values with NUL: keep the first.
  return text.split('\u0000').find((part) => part.trim().length > 0) ?? '';
}

// Length of a NUL-terminated string in the given encoding, terminator included.
function terminatedLength(bytes: Uint8Array, start: number, encoding: number) {
  const wide = encoding === 1 || encoding === 2;
  for (let index = start; index < bytes.length; index += wide ? 2 : 1) {
    if (bytes[index] === 0 && (!wide || bytes[index + 1] === 0)) return index - start + (wide ? 2 : 1);
  }
  return bytes.length - start;
}

function removeUnsync(bytes: Uint8Array) {
  const out: number[] = [];
  for (let index = 0; index < bytes.length; index += 1) {
    out.push(bytes[index]);
    if (bytes[index] === 0xff && bytes[index + 1] === 0x00) index += 1;
  }
  return Uint8Array.from(out);
}

export function sniffImage(bytes: Uint8Array): MediaArtwork['mimeType'] | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  return null;
}

// Only real JPEG/PNG bytes within the size limit become artwork.
function toArtwork(bytes: Uint8Array): MediaArtwork | null {
  if (bytes.length === 0 || bytes.length > MEDIA_METADATA_LIMITS.artworkBytes) return null;
  const mimeType = sniffImage(bytes);
  return mimeType ? { mimeType, bytes: bytes.slice() } : null;
}

export function id3TagSize(header: Uint8Array) {
  if (header.length < 10 || ascii(header, 0, 3) !== 'ID3') return 0;
  return 10 + syncsafe(header, 6) + ((header[5] & 0x10) ? 10 : 0);
}

export function parseId3v2(bytes: Uint8Array): RawTags | null {
  if (bytes.length < 10 || ascii(bytes, 0, 3) !== 'ID3') return null;
  const version = bytes[3];
  if (version < 2 || version > 4) return null;
  const flags = bytes[5];
  const end = Math.min(bytes.length, 10 + syncsafe(bytes, 6));
  let body = bytes.subarray(10, end);
  if ((flags & 0x80) && version < 4) body = removeUnsync(body);
  let offset = 0;
  if (flags & 0x40 && version > 2) {
    offset = version === 4 ? syncsafe(body, 0) : u32(body, 0) + 4;
  }
  const tags: RawTags = {};
  const idLength = version === 2 ? 3 : 4;
  const headerLength = version === 2 ? 6 : 10;
  while (offset + headerLength <= body.length) {
    const id = ascii(body, offset, idLength);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const size = version === 2 ? u24(body, offset + 3) : version === 4 ? syncsafe(body, offset + 4) : u32(body, offset + 4);
    const formatFlags = version === 2 ? 0 : body[offset + 9];
    const start = offset + headerLength;
    if (size <= 0 || start + size > body.length) break;
    let frame = body.subarray(start, start + size);
    if (version === 4 && (formatFlags & 0x02)) frame = removeUnsync(frame);
    offset = start + size;
    const encoding = frame[0];
    const text = () => decodeId3Text(encoding, frame.subarray(1));
    switch (id) {
      case 'TIT2': case 'TT2': tags.title ??= text(); break;
      case 'TPE1': case 'TP1': tags.artist ??= text(); break;
      case 'TALB': case 'TAL': tags.album ??= text(); break;
      case 'TYER': case 'TDRC': case 'TYE': tags.year ??= text(); break;
      case 'TLEN': case 'TLE': {
        const ms = Number.parseInt(text(), 10);
        if (Number.isFinite(ms) && ms > 0) tags.durationSeconds ??= ms / 1000;
        break;
      }
      case 'APIC': {
        if (tags.artwork) break;
        let cursor = 1;
        cursor += terminatedLength(frame, cursor, 0); // MIME type (ISO-8859-1)
        cursor += 1; // picture type
        cursor += terminatedLength(frame, cursor, encoding); // description
        tags.artwork = toArtwork(frame.subarray(cursor));
        break;
      }
      case 'PIC': {
        if (tags.artwork) break;
        let cursor = 1 + 3 + 1; // encoding, 3-char image format, picture type
        cursor += terminatedLength(frame, cursor, encoding);
        tags.artwork = toArtwork(frame.subarray(cursor));
        break;
      }
      default:
        break;
    }
  }
  return tags;
}

export function parseId3v1(tail: Uint8Array): RawTags | null {
  if (tail.length < 128) return null;
  const tag = tail.subarray(tail.length - 128);
  if (ascii(tag, 0, 3) !== 'TAG') return null;
  const field = (start: number, length: number) => latin1(tag.subarray(start, start + length)).replace(/\u0000.*$/, '').trim();
  return { title: field(3, 30), artist: field(33, 30), album: field(63, 30), year: field(93, 4) };
}

// FLAC metadata blocks: STREAMINFO (duration), VORBIS_COMMENT, PICTURE.
export function parseFlac(bytes: Uint8Array): RawTags | null {
  let offset = id3TagSize(bytes);
  if (bytes.length < offset + 4 || ascii(bytes, offset, 4) !== 'fLaC') return null;
  offset += 4;
  const tags: RawTags = {};
  let last = false;
  while (!last && offset + 4 <= bytes.length) {
    const header = bytes[offset];
    last = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const length = u24(bytes, offset + 1);
    const start = offset + 4;
    if (start + length > bytes.length) break;
    const block = bytes.subarray(start, start + length);
    offset = start + length;
    if (type === 0 && block.length >= 18) {
      const sampleRate = (block[10] << 12) + (block[11] << 4) + (block[12] >> 4);
      const totalSamples = (block[13] & 0x0f) * 4_294_967_296 + u32(block, 14);
      if (sampleRate > 0 && totalSamples > 0) tags.durationSeconds = totalSamples / sampleRate;
    } else if (type === 4 && block.length >= 8) {
      let cursor = 4 + u32le(block, 0);
      const count = cursor + 4 <= block.length ? u32le(block, cursor) : 0;
      cursor += 4;
      for (let index = 0; index < count && cursor + 4 <= block.length; index += 1) {
        const size = u32le(block, cursor);
        cursor += 4;
        if (cursor + size > block.length) break;
        const comment = decodeUtf8(block.subarray(cursor, cursor + size));
        cursor += size;
        const separator = comment.indexOf('=');
        if (separator <= 0) continue;
        const key = comment.slice(0, separator).toUpperCase();
        const value = comment.slice(separator + 1);
        if (key === 'TITLE') tags.title ??= value;
        else if (key === 'ARTIST') tags.artist ??= value;
        else if (key === 'ALBUM') tags.album ??= value;
        else if (key === 'DATE' || key === 'YEAR') tags.year ??= value;
      }
    } else if (type === 6 && block.length >= 32 && !tags.artwork) {
      let cursor = 4;
      cursor += 4 + u32(block, cursor); // MIME type
      cursor += 4 + u32(block, cursor); // description
      cursor += 16; // width, height, depth, colours
      if (cursor + 4 > block.length) continue;
      const size = u32(block, cursor);
      cursor += 4;
      if (cursor + size <= block.length) tags.artwork = toArtwork(block.subarray(cursor, cursor + size));
    }
  }
  return tags;
}

type Atom = { type: string; start: number; size: number; header: number };

function readAtoms(bytes: Uint8Array, start: number, end: number): Atom[] {
  const atoms: Atom[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = u32(bytes, offset);
    let header = 8;
    if (size === 1 && offset + 16 <= end) {
      size = u32(bytes, offset + 8) * 4_294_967_296 + u32(bytes, offset + 12);
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) break;
    atoms.push({ type: latin1(bytes.subarray(offset + 4, offset + 8)), start: offset, size, header });
    offset += size;
  }
  return atoms;
}

const childAtoms = (bytes: Uint8Array, atom: Atom, skip = 0) => readAtoms(bytes, atom.start + atom.header + skip, atom.start + atom.size);

// Parses an MP4/M4A 'moov' atom (bytes start at the atom header).
export function parseMp4Moov(moov: Uint8Array): RawTags | null {
  const [root] = readAtoms(moov, 0, moov.length);
  if (!root || root.type !== 'moov') return null;
  const tags: RawTags = {};
  const children = childAtoms(moov, root);
  const mvhd = children.find((atom) => atom.type === 'mvhd');
  if (mvhd) {
    const base = mvhd.start + mvhd.header;
    const version = moov[base];
    const timescale = version === 1 ? u32(moov, base + 20) : u32(moov, base + 12);
    const duration = version === 1 ? u32(moov, base + 24) * 4_294_967_296 + u32(moov, base + 28) : u32(moov, base + 16);
    if (timescale > 0 && duration > 0) tags.durationSeconds = duration / timescale;
  }
  const udta = children.find((atom) => atom.type === 'udta');
  const meta = udta ? childAtoms(moov, udta).find((atom) => atom.type === 'meta') : undefined;
  if (!meta) return tags;
  // 'meta' is a full box in MP4 (4 bytes of version/flags) but not in QuickTime.
  const isFullBox = latin1(moov.subarray(meta.start + meta.header + 4, meta.start + meta.header + 8)) !== 'hdlr';
  const ilst = childAtoms(moov, meta, isFullBox ? 4 : 0).find((atom) => atom.type === 'ilst');
  if (!ilst) return tags;
  for (const item of childAtoms(moov, ilst)) {
    const data = childAtoms(moov, item).find((atom) => atom.type === 'data');
    if (!data) continue;
    const valueStart = data.start + data.header + 8; // type indicator + locale
    const value = moov.subarray(valueStart, data.start + data.size);
    const key = item.type;
    if (key === '©nam') tags.title ??= decodeUtf8(value);
    else if (key === '©ART' || key === 'aART') tags.artist ??= decodeUtf8(value);
    else if (key === '©alb') tags.album ??= decodeUtf8(value);
    else if (key === '©day') tags.year ??= decodeUtf8(value);
    else if (key === 'covr') tags.artwork ??= toArtwork(value);
  }
  return tags;
}

// Walks top-level atoms with small ranged reads to find 'moov' (often after
// 'mdat' at the end of the file) and reads it whole when within the limit.
async function readMp4Moov(read: RangeReader, size: number) {
  let offset = 0;
  for (let steps = 0; steps < 64 && offset + 8 <= size; steps += 1) {
    const header = await read(offset, Math.min(size - 1, offset + 15));
    if (header.length < 8) return null;
    let atomSize = u32(header, 0);
    const type = latin1(header.subarray(4, 8));
    if (atomSize === 1 && header.length >= 16) atomSize = u32(header, 8) * 4_294_967_296 + u32(header, 12);
    else if (atomSize === 0) atomSize = size - offset;
    if (atomSize < 8) return null;
    if (type === 'moov') {
      if (atomSize > MEDIA_METADATA_LIMITS.mp4MoovBytes) return null;
      return read(offset, offset + atomSize - 1);
    }
    offset += atomSize;
  }
  return null;
}

export function cleanText(value: unknown) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, MEDIA_METADATA_LIMITS.text) : null;
}

function cleanYear(value: unknown) {
  const match = typeof value === 'string' ? /(1[0-9]{3}|2[0-9]{3})/.exec(value) : null;
  return match ? match[1] : null;
}

function cleanDuration(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 172_800 ? Math.round(value * 10) / 10 : null;
}

// "Artist - Title.mp3" → artist and title; otherwise the name is the title.
export function metadataFromFileName(fileName: string) {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.[A-Za-z0-9]{1,8}$/, '').replace(/[_]+/g, ' ');
  const split = /^(.{1,120}?)\s+[-–—]\s+(.{1,200})$/.exec(base.trim());
  return split ? { artist: cleanText(split[1]), title: cleanText(split[2]) } : { artist: null, title: cleanText(base) };
}

export function finalizeMetadata(raw: RawTags | null, fileName: string): ExtractedMediaMetadata {
  const fromName = metadataFromFileName(fileName);
  const title = cleanText(raw?.title);
  const artist = cleanText(raw?.artist);
  const album = cleanText(raw?.album);
  const year = cleanYear(raw?.year);
  const hasTags = Boolean(title || artist || album || year || raw?.artwork);
  return {
    title: title ?? fromName.title,
    artist: artist ?? (hasTags ? null : fromName.artist),
    album,
    year,
    durationSeconds: cleanDuration(raw?.durationSeconds),
    source: hasTags ? 'tags' : 'filename',
    artwork: raw?.artwork ?? null,
  };
}

// Reads tags for the formats Watch accepts. Unknown formats, unreadable
// ranges or corrupt tags fall back to the file name; this never throws.
export async function extractMediaMetadata(input: { read: RangeReader; size: number; mimeType: string; fileName: string }): Promise<ExtractedMediaMetadata> {
  const { read, size, mimeType, fileName } = input;
  let raw: RawTags | null = null;
  try {
    if (size > 0) {
      const head = await read(0, Math.min(size, 65_536) - 1);
      const isMp4 = head.length >= 8 && ascii(head, 4, 4) === 'ftyp';
      if (isMp4 || /^(audio|video)\/(mp4|x-m4a|m4a|quicktime)$/.test(mimeType)) {
        const moov = await readMp4Moov(read, size);
        raw = moov ? parseMp4Moov(moov) : null;
      } else {
        const id3Size = id3TagSize(head);
        const tagBytes = id3Size > head.length && id3Size <= MEDIA_METADATA_LIMITS.tagBytes
          ? await read(0, Math.min(size, id3Size) - 1)
          : head;
        if (ascii(tagBytes, id3Size, 4) === 'fLaC' || mimeType === 'audio/flac') {
          const flacBytes = tagBytes.length >= Math.min(size, MEDIA_METADATA_LIMITS.tagBytes) ? tagBytes : await read(0, Math.min(size, MEDIA_METADATA_LIMITS.tagBytes) - 1);
          raw = parseFlac(flacBytes);
        } else {
          raw = parseId3v2(tagBytes);
          const hasText = raw && (raw.title || raw.artist || raw.album);
          if (!hasText && size >= 128 && /^audio\/(mpeg|mp3)$/.test(mimeType)) {
            const v1 = parseId3v1(await read(size - 128, size - 1));
            if (v1) raw = { ...v1, artwork: raw?.artwork ?? null, durationSeconds: raw?.durationSeconds ?? null };
          }
        }
      }
    }
  } catch {
    raw = null;
  }
  return finalizeMetadata(raw, fileName);
}

// Deterministic generated artwork when a file has none.
export function fallbackArtwork(seed: string) {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  const hue = hash % 360;
  const words = seed.replace(/\.[A-Za-z0-9]{1,8}$/, '').split(/[\s_\-–—]+/).filter(Boolean);
  const initials = (words.length > 1 ? `${words[0][0]}${words[1][0]}` : (words[0] ?? '?').slice(0, 2)).toUpperCase();
  return { from: `hsl(${hue} 70% 46%)`, to: `hsl(${(hue + 48) % 360} 72% 30%)`, initials };
}
