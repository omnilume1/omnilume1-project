// Media metadata probe (Action 10, migrations 20261105200000 and 20261105200500).
//
//   node scripts/security/media-probe.mjs
//
// Uploads a small tagged MP3 (ID3v2.3 title/artist/album + JPEG artwork,
// then silent MPEG frames) as QA account A into a new qa-* room, registers
// it, and runs the same server pipeline as logTemporaryMedia: a signed URL
// plus HTTP Range reads, extractMediaMetadata, then the service-role-only
// cache RPC. Checks what members can read and that nobody else can write.
// The room and the object are deleted at the end.

import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractMediaMetadata } from '../../src/lib/media-metadata.ts';

const projectRoot = resolve(import.meta.dirname, '..', '..');
const env = Object.fromEntries(readFileSync(resolve(projectRoot, '.env.local'), 'utf8')
  .split(/\r?\n/).map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean)
  .map((match) => [match[1], match[2].replace(/^(['"])(.*)\1$/, '$2')]));
const secret = (name) => process.env[name] ?? (process.env[`${name}_FILE`] ? readFileSync(process.env[`${name}_FILE`], 'utf8').trim() : undefined);
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, options);
const BUCKET = 'room_attachments';

const results = [];
const record = (check, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  A10  ${check}${detail ? `  [${detail}]` : ''}`);
};
const codeOf = (res) => (res?.error ? String(res.error.code ?? res.error.statusCode ?? 'error') : 'ok');

async function signIn(label) {
  const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, options);
  const { data, error } = await client.auth.signInWithPassword({ email: secret(`OMNILUME_QA_${label}_EMAIL`), password: secret(`OMNILUME_QA_${label}_PASSWORD`) });
  if (error || !data.session) throw new Error(`Sign-in failed for account ${label}.`);
  return { client, id: data.user.id };
}

// ID3v2.3 tag + silent MPEG-1 Layer III frames (128 kbps, 44.1 kHz, mono).
function taggedMp3() {
  const be32 = (value) => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
  const syncsafe = (value) => [(value >> 21) & 127, (value >> 14) & 127, (value >> 7) & 127, value & 127];
  const text = (value) => Buffer.concat([Buffer.from([3]), Buffer.from(value, 'utf8')]);
  const frame = (id, payload) => Buffer.concat([Buffer.from(id, 'latin1'), Buffer.from(be32(payload.length)), Buffer.from([0, 0]), payload]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(900, 7), Buffer.from([0xff, 0xd9])]);
  const apic = Buffer.concat([Buffer.from([0]), Buffer.from('image/jpeg\0', 'latin1'), Buffer.from([3]), Buffer.from('cover\0', 'latin1'), jpeg]);
  const body = Buffer.concat([frame('TIT2', text('Probe Anthem')), frame('TPE1', text('QA Ensemble')), frame('TALB', text('Disposable Album')), frame('TYER', text('2026')), frame('APIC', apic)]);
  const tag = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]), Buffer.from(syncsafe(body.length)), body]);
  const silentFrame = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0xc4]), Buffer.alloc(413)]);
  return { bytes: Buffer.concat([tag, ...Array.from({ length: 120 }, () => silentFrame)]), artworkLength: jpeg.length };
}

async function main() {
  const A = await signIn('A');
  const B = await signIn('B');
  const tag = `qa-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  const R = randomUUID();
  const insert = await A.client.from('rooms').insert({ id: R, name: `${tag}-media`, description: 'Disposable media probe.', is_private: true, expiration_type: 'recoverable', expires_at: new Date(Date.now() + 2 * 3600_000).toISOString(), created_by: A.id, username: null });
  if (insert.error) throw new Error(`room: ${codeOf(insert)}`);
  await A.client.from('room_members').insert({ room_id: R, user_id: A.id, role: 'owner', join_status: 'approved' });
  const objectPath = `${R}/media/${randomUUID()}.mp3`;

  try {
    const join = await B.client.rpc('request_room_join', { p_identifier: R });
    const approve = await A.client.rpc('review_room_member', { p_room_id: R, p_target_user_id: B.id, p_action: 'approve', p_reason: '' });
    if (join.error || approve.error) throw new Error(`membership: ${codeOf(join)}/${codeOf(approve)}`);

    const mp3 = taggedMp3();
    const upload = await A.client.storage.from(BUCKET).upload(objectPath, new Blob([mp3.bytes], { type: 'audio/mpeg' }), { contentType: 'audio/mpeg', upsert: false });
    record('the owner uploads a tagged MP3 to the room media path', !upload.error, upload.error?.message?.slice(0, 60) ?? 'ok');
    const registered = await A.client.rpc('register_temporary_media', { p_room_id: R, p_file_name: 'probe-anthem.mp3', p_file_path: objectPath, p_media_type: 'audio', p_mime_type: 'audio/mpeg', p_file_size: mp3.bytes.length });
    const mediaId = (Array.isArray(registered.data) ? registered.data[0] : registered.data)?.id;
    record('the media row is registered', !registered.error && typeof mediaId === 'string', codeOf(registered));

    // Exactly the server pipeline: signed URL once, then Range reads.
    const signed = await service.storage.from(BUCKET).createSignedUrl(objectPath, 120);
    const ranges = [];
    const read = async (start, end) => {
      ranges.push(end - start + 1);
      const response = await fetch(signed.data.signedUrl, { headers: { Range: `bytes=${start}-${end}` } });
      const bytes = new Uint8Array(await response.arrayBuffer());
      return response.status === 200 ? bytes.subarray(start, end + 1) : bytes;
    };
    const extracted = await extractMediaMetadata({ read, size: mp3.bytes.length, mimeType: 'audio/mpeg', fileName: 'probe-anthem.mp3' });
    record('storage honours HTTP Range reads (provider-neutral)', ranges.length >= 1 && ranges.every((size) => size <= 65_536), `reads=${ranges.join(',')}`);
    record('tags are read from the stored file', extracted.source === 'tags' && extracted.title === 'Probe Anthem' && extracted.artist === 'QA Ensemble' && extracted.album === 'Disposable Album' && extracted.year === '2026', JSON.stringify({ t: extracted.title, a: extracted.artist, s: extracted.source }));
    record('embedded JPEG artwork is extracted', extracted.artwork?.mimeType === 'image/jpeg' && extracted.artwork.bytes.length === mp3.artworkLength, `${extracted.artwork?.bytes.length ?? 0} bytes`);

    const metadata = { source: extracted.source, title: extracted.title, artist: extracted.artist, album: extracted.album, year: extracted.year, extracted_at: new Date().toISOString(), artwork: { mime_type: extracted.artwork.mimeType, data: Buffer.from(extracted.artwork.bytes).toString('base64') } };
    const memberCache = await B.client.rpc('cache_temporary_media_metadata', { p_media_id: mediaId, p_room_id: R, p_metadata: { title: 'forged', source: 'tags' } });
    record('a member cannot write cached metadata', memberCache.error?.code === '42501', codeOf(memberCache));
    const ownerCache = await A.client.rpc('cache_temporary_media_metadata', { p_media_id: mediaId, p_room_id: R, p_metadata: { title: 'forged', source: 'tags' } });
    record('not even the owner (only the server)', ownerCache.error?.code === '42501', codeOf(ownerCache));
    const directWrite = await A.client.from('temporary_media').update({ metadata: { title: 'forged' } }).eq('id', mediaId);
    record('direct writes to the media row are refused', Boolean(directWrite.error), codeOf(directWrite));
    const serverCache = await service.rpc('cache_temporary_media_metadata', { p_media_id: mediaId, p_room_id: R, p_metadata: metadata });
    record('the server caches the metadata with the media row', !serverCache.error && serverCache.data === true, codeOf(serverCache));
    const unsafe = await service.rpc('cache_temporary_media_metadata', { p_media_id: mediaId, p_room_id: R, p_metadata: { artwork: { mime_type: 'image/svg+xml', data: 'PHN2Zz4=' } } });
    record('the database refuses unsafe artwork even from the server', unsafe.error?.code === '23514', codeOf(unsafe));

    const memberRead = await B.client.from('temporary_media').select('metadata').eq('id', mediaId).single();
    record('members who can watch read the cached details', memberRead.data?.metadata?.title === 'Probe Anthem' && memberRead.data?.metadata?.artwork?.mime_type === 'image/jpeg', codeOf(memberRead));
    const off = await A.client.rpc('update_room_controls', { p_room_id: R, p_rules: null, p_welcome_message: null, p_is_locked: null, p_feature_flags: { watch: false } });
    const hidden = await B.client.from('temporary_media').select('metadata').eq('id', mediaId);
    record('with Watch off, the details are not readable', !off.error && (Boolean(hidden.error) || (hidden.data ?? []).length === 0), `${codeOf(off)} rows=${(hidden.data ?? []).length}`);
  } finally {
    await service.storage.from(BUCKET).remove([objectPath]);
    await service.from('rooms').delete().eq('id', R).like('name', 'qa-%');
  }

  const passed = results.filter(Boolean).length;
  console.log(`\nsummary: ${passed} pass, ${results.length - passed} fail`);
  process.exit(results.length === passed ? 0 : 1);
}

main().catch((error) => {
  console.error(`media probe aborted: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
});
