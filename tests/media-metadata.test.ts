import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  MEDIA_METADATA_LIMITS,
  cleanText,
  extractMediaMetadata,
  fallbackArtwork,
  metadataFromFileName,
  parseFlac,
  parseId3v1,
  parseId3v2,
  parseMp4Moov,
  sniffImage,
} from '../src/lib/media-metadata.js';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
const bytes = (...parts: Array<number[] | Uint8Array | string>) => Uint8Array.from(parts.flatMap((part) => typeof part === 'string' ? [...Buffer.from(part, 'latin1')] : [...part]));
const be32 = (value: number) => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
const le32 = (value: number) => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255];
const syncsafe = (value: number) => [(value >> 21) & 127, (value >> 14) & 127, (value >> 7) & 127, value & 127];
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], 'fakejpegpayload');
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'fakepngpayload');

function id3Frame(id: string, payload: Uint8Array, version: 3 | 4) {
  return bytes(id, version === 4 ? syncsafe(payload.length) : be32(payload.length), [0, 0], payload);
}
function id3Tag(version: 3 | 4, frames: Uint8Array[]) {
  const body = bytes(...frames);
  return bytes('ID3', [version, 0, 0], syncsafe(body.length), body);
}
const utf8Text = (value: string) => bytes([3], Buffer.from(value, 'utf8'));
const utf16Text = (value: string) => bytes([1, 0xff, 0xfe], Buffer.from(value, 'utf16le'));

function atom(type: string, ...children: Uint8Array[]) {
  const body = bytes(...children);
  return bytes(be32(body.length + 8), type, body);
}
function ilstItem(key: number[] | string, value: Uint8Array, kind: number) {
  return atom(typeof key === 'string' ? key : Buffer.from(key).toString('latin1'), atom('data', bytes(be32(kind), be32(0), value)));
}
const COPYRIGHT = 0xa9;

function memoryReader(data: Uint8Array) {
  const calls: Array<[number, number]> = [];
  const reader = async (start: number, end: number) => { calls.push([start, end]); return data.slice(start, end + 1); };
  return { reader, calls };
}

test('ID3v2.3 and v2.4 text frames, UTF-16, length and attached picture', () => {
  const v3 = parseId3v2(id3Tag(3, [
    id3Frame('TIT2', utf16Text('Café Song'), 3),
    id3Frame('TPE1', utf8Text('The Artist'), 3),
    id3Frame('TALB', bytes([0], 'Latin Album'), 3),
    id3Frame('TYER', bytes([0], '1999'), 3),
    id3Frame('TLEN', bytes([0], '215000'), 3),
    id3Frame('APIC', bytes([0], 'image/jpeg', [0], [3], 'cover', [0], JPEG), 3),
  ]));
  assert.equal(v3?.title, 'Café Song');
  assert.equal(v3?.artist, 'The Artist');
  assert.equal(v3?.album, 'Latin Album');
  assert.equal(v3?.year, '1999');
  assert.equal(v3?.durationSeconds, 215);
  assert.equal(v3?.artwork?.mimeType, 'image/jpeg');
  assert.deepEqual([...v3!.artwork!.bytes], [...JPEG]);

  const v4 = parseId3v2(id3Tag(4, [id3Frame('TIT2', utf8Text('First\u0000Second'), 4), id3Frame('TDRC', utf8Text('2024-05-01'), 4)]));
  assert.equal(v4?.title, 'First', 'v2.4 keeps the first of several values');
  assert.equal(v4?.year, '2024-05-01');
  assert.equal(parseId3v2(bytes('NOTID3')), null);
});

test('pictures that are not real JPEG/PNG, or too large, are never used', () => {
  const svg = parseId3v2(id3Tag(3, [id3Frame('APIC', bytes([0], 'image/svg+xml', [0], [3], [0], '<svg onload=alert(1)>'), 3)]));
  assert.equal(svg?.artwork, null);
  const huge = bytes([0xff, 0xd8, 0xff], new Uint8Array(MEDIA_METADATA_LIMITS.artworkBytes + 1));
  const big = parseId3v2(id3Tag(3, [id3Frame('APIC', bytes([0], 'image/jpeg', [0], [3], [0], huge), 3)]));
  assert.equal(big?.artwork, null);
  assert.equal(sniffImage(PNG), 'image/png');
  assert.equal(sniffImage(bytes('GIF89a')), null);
});

test('ID3v1 trailer', () => {
  const tag = new Uint8Array(128);
  tag.set(Buffer.from('TAG', 'latin1'), 0);
  tag.set(Buffer.from('Old Title', 'latin1'), 3);
  tag.set(Buffer.from('Old Artist', 'latin1'), 33);
  tag.set(Buffer.from('1987', 'latin1'), 93);
  const parsed = parseId3v1(bytes(new Uint8Array(500), tag));
  assert.equal(parsed?.title, 'Old Title');
  assert.equal(parsed?.artist, 'Old Artist');
  assert.equal(parsed?.year, '1987');
});

test('FLAC stream info, Vorbis comments and picture block', () => {
  const streamInfo = new Uint8Array(34);
  // 44.1 kHz, 441000 samples → 10 s.
  const sampleRate = 44_100;
  streamInfo[10] = (sampleRate >> 12) & 0xff;
  streamInfo[11] = (sampleRate >> 4) & 0xff;
  streamInfo[12] = ((sampleRate & 0x0f) << 4) | 0x02;
  streamInfo.set(be32(441_000), 14);
  const comments = ['TITLE=Flac Title', 'ARTIST=Flac Artist', 'album=Flac Album', 'DATE=2010'];
  const vorbis = bytes(le32(6), 'vendor', le32(comments.length), ...comments.flatMap((comment) => [le32(Buffer.byteLength(comment)), Buffer.from(comment, 'utf8')]));
  const picture = bytes(be32(3), be32(9), 'image/png', be32(0), be32(1), be32(1), be32(24), be32(0), be32(PNG.length), PNG);
  const block = (type: number, payload: Uint8Array, last = false) => bytes([(last ? 0x80 : 0) | type, (payload.length >> 16) & 255, (payload.length >> 8) & 255, payload.length & 255], payload);
  const flac = parseFlac(bytes('fLaC', block(0, streamInfo), block(4, vorbis), block(6, picture, true)));
  assert.equal(flac?.durationSeconds, 10);
  assert.equal(flac?.title, 'Flac Title');
  assert.equal(flac?.artist, 'Flac Artist');
  assert.equal(flac?.album, 'Flac Album');
  assert.equal(flac?.year, '2010');
  assert.equal(flac?.artwork?.mimeType, 'image/png');
});

test('MP4/M4A moov: duration, iTunes tags and cover, found after mdat by ranged reads', async () => {
  const mvhd = atom('mvhd', bytes([0, 0, 0, 0], be32(0), be32(0), be32(1000), be32(183_500), new Uint8Array(80)));
  const meta = atom('meta', bytes([0, 0, 0, 0]), atom('hdlr', new Uint8Array(25)), atom('ilst',
    ilstItem([COPYRIGHT, ...Buffer.from('nam')], Buffer.from('M4A Title', 'utf8'), 1),
    ilstItem([COPYRIGHT, ...Buffer.from('ART')], Buffer.from('M4A Artist', 'utf8'), 1),
    ilstItem([COPYRIGHT, ...Buffer.from('alb')], Buffer.from('M4A Album', 'utf8'), 1),
    ilstItem('covr', JPEG, 13),
  ));
  const moov = atom('moov', mvhd, atom('udta', meta));
  const parsed = parseMp4Moov(moov);
  assert.equal(parsed?.durationSeconds, 183.5);
  assert.equal(parsed?.title, 'M4A Title');
  assert.equal(parsed?.artist, 'M4A Artist');
  assert.equal(parsed?.album, 'M4A Album');
  assert.equal(parsed?.artwork?.mimeType, 'image/jpeg');

  const file = bytes(atom('ftyp', bytes('M4A ', be32(0))), atom('mdat', new Uint8Array(200_000)), moov);
  const { reader, calls } = memoryReader(file);
  const extracted = await extractMediaMetadata({ read: reader, size: file.length, mimeType: 'audio/mp4', fileName: 'x.m4a' });
  assert.equal(extracted.source, 'tags');
  assert.equal(extracted.title, 'M4A Title');
  assert.ok(calls.every(([start, end]) => end - start < 70_000), 'never downloads the media data');
});

test('falls back to the file name, cleans text and never throws', async () => {
  assert.deepEqual(metadataFromFileName('Daft_Punk - One More Time.mp3'), { artist: 'Daft Punk', title: 'One More Time' });
  assert.deepEqual(metadataFromFileName('lecture-01.mp4'), { artist: null, title: 'lecture-01' });
  assert.equal(cleanText('  a\u0000b‮ c  '), 'a b c');
  assert.equal(cleanText('x'.repeat(500))?.length, MEDIA_METADATA_LIMITS.text);
  const failing = async () => { throw new Error('network'); };
  const fallback = await extractMediaMetadata({ read: failing, size: 1000, mimeType: 'audio/mpeg', fileName: 'Artist - Track.mp3' });
  assert.deepEqual({ title: fallback.title, artist: fallback.artist, source: fallback.source, artwork: fallback.artwork }, { title: 'Track', artist: 'Artist', source: 'filename', artwork: null });
  const art = fallbackArtwork('One More Time');
  assert.equal(art.initials, 'OM');
  assert.deepEqual(fallbackArtwork('One More Time'), art, 'deterministic');
});

test('server-side extraction, provider-neutral reads and a guarded cache', () => {
  const media = read('src/actions/media.ts');
  assert.match(media, /getServerStorageProvider\(\)\.openRangeReader\(ROOM_ATTACHMENT_BUCKET, objectPath\)/);
  assert.match(media, /await cacheMediaMetadata\(row\.id, roomId, filePath, fileName, verifiedMimeType, verifiedFileSize\)\.catch\(\(\) => undefined\);/);
  assert.match(media, /await assertCapability\(supabase, roomId, user\.id, 'watch'\);\n    const \{ data, error \} = await supabase\n      \.from\('temporary_media'\)\n      \.select\('id, media_type, file_name, metadata'\)/);
  assert.doesNotMatch(media, /lyrics/i);
  const provider = read('src/lib/storage/server-provider.ts');
  assert.match(provider, /headers: \{ Range: `bytes=\$\{start\}-\$\{endInclusive\}` \}/);
  const sql = read('supabase/migrations/20261105200000_action10_media_metadata_cache.sql');
  assert.match(sql, /metadata -> 'artwork' ->> 'mime_type' IN \('image\/jpeg', 'image\/png'\)/);
  assert.match(sql, /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.temporary_media FROM anon, authenticated;/);
  const admin = read('src/utils/supabase/admin.ts');
  assert.match(admin, /Tables: Record<string, never>;/, 'the service role still has no public-table access in app code');
  assert.match(admin, /cache_temporary_media_metadata: \{/);
  assert.match(media, /createAdminClient\(\)\.rpc\('cache_temporary_media_metadata'/);
  const rpc = read('supabase/migrations/20261105200500_action10_media_metadata_rpc.sql');
  assert.match(rpc, /REVOKE ALL ON FUNCTION public\.cache_temporary_media_metadata\(uuid, uuid, jsonb\) FROM PUBLIC, anon, authenticated;\nGRANT EXECUTE ON FUNCTION public\.cache_temporary_media_metadata\(uuid, uuid, jsonb\) TO service_role;/);
});
