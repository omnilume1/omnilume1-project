import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  acceptListenState, canControlListen, listenPositionMs, listenTopic, parseListenSession,
} from '../src/lib/music-together.js';

const G = '11111111-2222-4333-8444-555555555555';
const U = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const raw = (overrides: Record<string, unknown> = {}) => ({
  target_kind: 'group', target_id: G, host_id: 'h', host_name: 'Host', host_only: false, upload_id: U,
  position_ms: 10_000, is_playing: true, anchor_at: '2026-11-05T10:00:00.000Z', queue: [U, 'not-a-uuid'], seq: 3,
  ended: false, server_now: '2026-11-05T10:00:02.000Z', ...overrides,
});
const at = (iso: string) => Date.parse(iso);

test('parses server state, drops malformed fields and measures the clock offset', () => {
  const session = parseListenSession(raw(), at('2026-11-05T10:00:01.000Z'))!;
  assert.equal(session.targetKind, 'group');
  assert.deepEqual(session.queue, [U], 'non-uuid queue entries are dropped');
  assert.equal(session.clockOffsetMs, 1_000, 'server is 1 s ahead of this client');
  assert.equal(parseListenSession(raw({ target_kind: 'public' }), 0), null);
  assert.equal(parseListenSession(raw({ target_id: 'x' }), 0), null);
  assert.equal(parseListenSession(raw({ anchor_at: 'nope' }), 0), null);
  assert.equal(parseListenSession(null, 0), null);
  assert.equal(parseListenSession(raw({ upload_id: '<script>' }), 0)!.uploadId, null);
});

test('playhead follows the anchor on the server clock', () => {
  const clientNow = at('2026-11-05T10:00:01.000Z');
  const session = parseListenSession(raw(), clientNow)!;
  // Server time is 10:00:03 then (client 1 s behind, 1 s later): 3 s past the anchor.
  assert.equal(listenPositionMs(session, clientNow + 1_000), 13_000);
  assert.equal(listenPositionMs(session, clientNow + 1_000, 12_000), 12_000, 'clamped to the duration');
  assert.equal(listenPositionMs({ ...session, isPlaying: false }, clientNow + 60_000), 10_000, 'paused does not advance');
  assert.equal(listenPositionMs(session, clientNow - 60_000), 10_000, 'never runs backwards');
});

test('only newer seq is applied; another target replaces the state', () => {
  const a = parseListenSession(raw({ seq: 5 }), 0)!;
  assert.equal(acceptListenState(a, parseListenSession(raw({ seq: 5 }), 0)), a, 'duplicate ignored');
  assert.equal(acceptListenState(a, parseListenSession(raw({ seq: 4 }), 0)), a, 'late delivery ignored');
  assert.equal(acceptListenState(a, parseListenSession(raw({ seq: 6 }), 0))!.seq, 6);
  assert.equal(acceptListenState(a, null), a);
  const other = parseListenSession(raw({ seq: 1, target_kind: 'room' }), 0)!;
  assert.equal(acceptListenState(a, other), other);
});

test('host-only control and ended sessions', () => {
  const open = parseListenSession(raw(), 0)!;
  assert.equal(canControlListen(open, 'member'), true);
  assert.equal(canControlListen({ ...open, hostOnly: true }, 'member'), false);
  assert.equal(canControlListen({ ...open, hostOnly: true }, 'h'), true);
  assert.equal(canControlListen({ ...open, ended: true }, 'h'), false);
  assert.equal(canControlListen(open, null), false);
  assert.equal(listenTopic('room', G), `music_listen_room_${G}`);
});

test('migration: server-only publishing, private topic, hardened RPCs', () => {
  const sql = readFileSync(resolve('supabase/migrations/20261111100000_action16_music_presence_together.sql'), 'utf8');
  assert.match(sql, /ON realtime\.messages\s+FOR SELECT TO authenticated/);
  assert.doesNotMatch(sql, /ON realtime\.messages\s+FOR (INSERT|ALL)/, 'clients cannot publish on the music topic');
  assert.match(sql, /realtime\.send\(out_json, 'state', 'music_listen_' \|\| p_kind/);
  for (const table of ['music_settings', 'music_now_playing', 'music_listen_sessions']) {
    assert.match(sql, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`));
  }
  assert.doesNotMatch(sql, /GRANT [A-Z, ]+ ON TABLE public\.(music_now_playing|music_listen_sessions)/, 'no direct table access');
  const definers = sql.match(/SECURITY DEFINER\s+SET search_path = ''/g) ?? [];
  assert.equal(definers.length, (sql.match(/SECURITY DEFINER/g) ?? []).length, 'every definer pins search_path');
  assert.match(sql, /p_topic !~ '\^music_listen_\(room\|group\)_/, 'topic validated before the uuid cast');
  assert.doesNotMatch(sql.split('-- 5. Function privileges')[1].split('TO authenticated, service_role')[0].split('GRANT EXECUTE')[1] ?? '', /music_listen_json/, 'json builder is internal');
  // PostgREST retries 40001 (serialization_failure): the latest control function must never raise it.
  const repair = readFileSync(resolve('supabase/migrations/20261111110000_action16_listen_queue_conflict_code.sql'), 'utf8');
  assert.match(repair, /CREATE OR REPLACE FUNCTION public\.music_listen_control\(/);
  assert.doesNotMatch(repair, /ERRCODE = '40001'/);
  assert.match(repair, /SECURITY DEFINER\s+SET search_path = ''/);
});

test('client: private channel, presence via RPC only', () => {
  const hook = readFileSync(resolve('src/hooks/useListenTogether.tsx'), 'utf8');
  assert.match(hook, /\.channel\(listenTopic\(target\.kind, target\.id\), \{ config: \{ private: true \} \}\)/);
  assert.doesNotMatch(hook, /\.send\(/, 'the client never broadcasts');
  const player = readFileSync(resolve('src/hooks/useMusicPlayer.tsx'), 'utf8');
  assert.match(player, /rpc\('set_music_now_playing', \{ p_upload_id: id \}\)/);
});
