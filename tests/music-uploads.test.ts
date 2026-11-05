import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cleanupMusicUploads } from '../src/lib/music-cleanup.js';
import {
  audioExtension, cleanTag, musicCoverPath, musicObjectPath, parseRegisterBody, signedUrlTtlSeconds, sniffAudio,
} from '../src/lib/music-upload-validation.js';

const bytes = (...values: (number | string)[]) => {
  const out: number[] = [];
  for (const value of values) {
    if (typeof value === 'number') out.push(value);
    else for (const char of value) out.push(char.charCodeAt(0));
  }
  while (out.length < 16) out.push(0);
  return new Uint8Array(out);
};

test('magic bytes must match the extension', () => {
  assert.equal(sniffAudio(bytes('ID3'), 'mp3'), true);
  assert.equal(sniffAudio(bytes(0xff, 0xfb), 'mp3'), true);
  assert.equal(sniffAudio(bytes('fLaC'), 'flac'), true);
  assert.equal(sniffAudio(bytes('OggS'), 'opus'), true);
  assert.equal(sniffAudio(bytes('RIFF', 0, 0, 0, 0, 'WAVE'), 'wav'), true);
  assert.equal(sniffAudio(bytes(0, 0, 0, 0x20, 'ftyp'), 'm4a'), true);
  assert.equal(sniffAudio(bytes(0x1a, 0x45, 0xdf, 0xa3), 'webm'), true);
  assert.equal(sniffAudio(bytes('%PDF-1.7'), 'mp3'), false, 'a PDF renamed to .mp3 is refused');
  assert.equal(sniffAudio(bytes('<html>'), 'flac'), false);
  assert.equal(sniffAudio(bytes('RIFF', 0, 0, 0, 0, 'AVI '), 'wav'), false);
  assert.equal(sniffAudio(new Uint8Array([0x49, 0x44]), 'mp3'), false, 'too short');
});

test('extensions, paths and tag cleaning', () => {
  assert.equal(audioExtension('Song.FLAC'), 'flac');
  assert.equal(audioExtension('notes.lrc'), null);
  assert.equal(audioExtension('archive.mp3.exe'), null);
  assert.equal(musicObjectPath('u', 'id', 'm4a'), 'u/id.m4a');
  assert.equal(musicCoverPath('u', 'id'), 'u/id.cover.jpg');
  assert.equal(cleanTag('  A\u0000 \u0007B\t\tC  ', 200), 'A B C');
  assert.equal(cleanTag('x'.repeat(300), 200).length, 200);
  assert.equal(cleanTag(42, 10), '');
});

test('register body is validated and normalised', () => {
  const id = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
  assert.equal(parseRegisterBody(null), 'Invalid request.');
  assert.equal(parseRegisterBody({ uploadId: 'nope', ext: 'mp3', originalName: 'a.mp3' }), 'Invalid upload id.');
  assert.equal(parseRegisterBody({ uploadId: id, ext: 'exe', originalName: 'a.exe' }), 'Unsupported audio format.');
  const parsed = parseRegisterBody({ uploadId: id, ext: 'mp3', originalName: 'My Song.mp3', title: '', trackNo: 1000, year: 2026.5, hue: 999, hasCover: 'yes', lyrics: 'a\r\nb' });
  assert.ok(typeof parsed === 'object');
  assert.equal(parsed.title, 'My Song', 'title falls back to the file name');
  assert.equal(parsed.mimeType, 'audio/mpeg', 'MIME comes from the extension, not the client');
  assert.equal(parsed.trackNo, null);
  assert.equal(parsed.year, null);
  assert.equal(parsed.hue, 260);
  assert.equal(parsed.hasCover, false);
  assert.equal(parsed.lyrics, 'a\nb');
});

test('signed URL lifetime is min(1 h, remaining life)', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  assert.equal(signedUrlTtlSeconds('2026-11-12T12:00:00Z', now), 3600);
  assert.equal(signedUrlTtlSeconds('2026-11-05T12:10:00Z', now), 600);
  assert.equal(signedUrlTtlSeconds('2026-11-05T11:59:00Z', now), 0);
  assert.equal(signedUrlTtlSeconds('garbage', now), 0);
});

function fakeClient(options: { failRemove?: string } = {}) {
  const calls: string[] = [];
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push(`rpc:${name}:${JSON.stringify(args)}`);
      if (name === 'list_music_uploads_due_for_cleanup') return { data: [{ id: 'u1', object_path: 'o/u1.mp3', cover_path: 'o/u1.cover.jpg' }, { id: 'u2', object_path: 'o/u2.flac', cover_path: null }], error: null };
      if (name === 'list_music_orphan_objects') return { data: [{ name: 'o/orphan.mp3' }], error: null };
      return { data: null, error: null };
    },
    storage: {
      from: () => ({
        remove: async (paths: string[]) => {
          calls.push(`remove:${paths.join(',')}`);
          return { data: [], error: options.failRemove && paths.includes(options.failRemove) ? { message: 'storage down' } : null };
        },
      }),
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

test('cleanup removes storage before finalising each row, then sweeps orphans', async () => {
  const { client, calls } = fakeClient();
  const result = await cleanupMusicUploads(client);
  assert.deepEqual(result, { removed: 2, orphansRemoved: 1, failures: [] });
  const removeU1 = calls.indexOf('remove:o/u1.mp3,o/u1.cover.jpg');
  const completeU1 = calls.findIndex((call) => call.startsWith('rpc:complete_music_upload_cleanup:{"p_upload_id":"u1","p_error":null'));
  assert.ok(removeU1 >= 0 && completeU1 > removeU1, 'storage first, then the row');
  assert.ok(calls.includes('remove:o/orphan.mp3'));
});

test('a failed removal is recorded for retry instead of tombstoning the row', async () => {
  const { client, calls } = fakeClient({ failRemove: 'o/u2.flac' });
  const result = await cleanupMusicUploads(client);
  assert.equal(result.removed, 1);
  assert.equal(result.failures.length, 1);
  assert.ok(calls.some((call) => call === 'rpc:complete_music_upload_cleanup:{"p_upload_id":"u2","p_error":"storage down"}'));
});

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

test('migration contract: private bucket, one 7-day constant, RLS, grants, hardened definers', () => {
  const sql = read('supabase/migrations/20261110100000_action16_music_library.sql');
  assert.match(sql, /'music_uploads', 'music_uploads', false, 52428800/);
  assert.equal((sql.match(/interval '7 days'/g) ?? []).length, 1, 'the retention lives in music_upload_ttl() only');
  assert.match(sql, /CHECK \(expires_at = created_at \+ public\.music_upload_ttl\(\)\)/);
  for (const table of ['music_uploads', 'music_upload_shares', 'music_playlists', 'music_playlist_items', 'music_listening_history']) {
    assert.match(sql, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`));
  }
  assert.match(sql, /FROM PUBLIC, anon, authenticated;/);
  const definers = sql.split('CREATE OR REPLACE FUNCTION').slice(1).filter((body) => body.includes('SECURITY DEFINER'));
  assert.ok(definers.length >= 15);
  for (const body of definers) assert.match(body, /SET search_path = ''/, `definer without search_path: ${body.slice(0, 60)}`);
  const grantToUsers = sql.slice(sql.indexOf('GRANT EXECUTE ON FUNCTION'), sql.indexOf('TO authenticated, service_role;'));
  for (const helper of ['music_can_play(uuid, uuid)', 'music_object_insert_ok(text)', 'music_object_readable(text)']) {
    assert.ok(grantToUsers.includes(`public.${helper}`), `policy helper ${helper} is executable by authenticated`);
  }
  assert.ok(!grantToUsers.includes('register_music_upload'), 'register is not granted to users');
  const serviceOnly = sql.slice(sql.lastIndexOf('GRANT EXECUTE ON FUNCTION'));
  for (const name of ['register_music_upload', 'list_music_uploads_due_for_cleanup', 'list_music_orphan_objects', 'complete_music_upload_cleanup']) {
    assert.ok(serviceOnly.includes(name) && serviceOnly.trim().endsWith('TO service_role;'), `${name} is service-role only`);
  }
  assert.doesNotMatch(sql, /FOR (UPDATE|DELETE) TO authenticated[\s\S]{0,80}bucket_id = 'music_uploads'/, 'no client update/delete on music objects');
  assert.match(sql, /RAISE EXCEPTION 'Confirm you have the right to share this file\.'/);
});

test('routes: register sniffs before the service RPC; playback signs with the capped TTL; flat paths reach account deletion', () => {
  const register = read('src/app/api/music/uploads/route.ts');
  assert.ok(register.indexOf('sniffAudio(') < register.indexOf("rpc('register_music_upload'"));
  const play = read('src/app/api/music/uploads/[id]/[asset]/route.ts');
  assert.match(play, /rpc\('get_music_playback'/);
  assert.match(play, /signedUrlTtlSeconds\(/);
  assert.match(play, /no-store/);
  const remove = read('src/app/api/music/uploads/[id]/route.ts');
  assert.ok(remove.indexOf('.remove(paths)') < remove.indexOf("rpc('complete_music_upload_cleanup'"), 'storage before row');
  // Account deletion lists `<userId>/` one level deep in every non-room bucket; music objects are flat there.
  assert.equal(musicObjectPath('user', 'id', 'mp3').split('/').length, 2);
  const account = read('src/actions/account.ts');
  assert.ok(account.indexOf('await removePersonalStorage(admin') < account.indexOf('deleteUser('), 'objects go before the auth-user cascade removes the rows');
  assert.match(read('src/app/api/internal/cleanup-expired-rooms/route.ts'), /cleanupMusicUploads\(supabase\)/);
});
