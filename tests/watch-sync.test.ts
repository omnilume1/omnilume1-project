import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  DRIFT_SEEK_THRESHOLD_SECONDS,
  createCoalescer,
  expectedPosition,
  formatPlaybackTime,
  needsDriftSeek,
  reorderQueue,
  shouldBroadcastNative,
  type PlaybackSnapshot,
} from '../src/lib/watch-sync.js';
import { toRoomBroadcastPayload } from '../src/lib/room-broadcast-contract.js';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
const state = (extra: Partial<PlaybackSnapshot> = {}): PlaybackSnapshot => ({ time: 100, playing: true, speed: 1, updatedAt: 1_000_000, eventTimestamp: 900_000, source: 'remote', ...extra });

test('the room position advances while playing, from receive time (or server time when restored)', () => {
  assert.equal(expectedPosition(state(), 1_004_000), 104);
  assert.equal(expectedPosition(state({ speed: 2 }), 1_004_000), 108);
  assert.equal(expectedPosition(state({ playing: false }), 1_004_000), 100);
  assert.equal(expectedPosition(state({ source: 'restored' }), 1_004_000), 204, 'restored snapshots extrapolate from the stored time');
  assert.equal(expectedPosition(state(), 999_000), 100, 'clock going backwards never rewinds');
  assert.ok(expectedPosition(state({ updatedAt: 1 }), 10 ** 12) <= 100 + 6 * 3600, 'extrapolation is capped');
});

test('drift correction seeks only beyond the threshold', () => {
  assert.equal(needsDriftSeek(100, 100 + DRIFT_SEEK_THRESHOLD_SECONDS - 0.1), false);
  assert.equal(needsDriftSeek(100, 101.5), true);
  assert.equal(needsDriftSeek(103, 101), true);
  assert.equal(needsDriftSeek(Number.NaN, 101), false);
});

test('native events are broadcast only when they change room state (no echo)', () => {
  const now = 1_004_000;
  assert.equal(shouldBroadcastNative('play', state(), 104, now), false, 'already playing');
  assert.equal(shouldBroadcastNative('play', state({ playing: false }), 100, now), true);
  assert.equal(shouldBroadcastNative('pause', state(), 104, now), true);
  assert.equal(shouldBroadcastNative('pause', state({ playing: false }), 100, now), false, 'already paused');
  assert.equal(shouldBroadcastNative('seek', state(), 104.4, now), false, 'echo of an applied seek');
  assert.equal(shouldBroadcastNative('seek', state(), 30, now), true, 'a real seek backwards');
  assert.equal(shouldBroadcastNative('seek', state(), 200, now), true, 'a real seek forwards');
  assert.equal(shouldBroadcastNative('seek', null, 5, now), false);
});

test('rapid seeks coalesce into the last one', () => {
  const calls: number[] = [];
  let pending: (() => void) | null = null;
  const coalescer = createCoalescer<number>((value) => calls.push(value), 300, { set: (fn) => { pending = fn; return 1; }, clear: () => { pending = null; } });
  coalescer.push(10);
  coalescer.push(20);
  coalescer.push(42);
  (pending as (() => void) | null)?.();
  assert.deepEqual(calls, [42]);
  coalescer.push(5);
  coalescer.cancel();
  assert.equal(pending, null);
  assert.deepEqual(calls, [42]);
});

test('queue reordering and time formatting', () => {
  const items = [{ id: 'a', position: 0 }, { id: 'b', position: 1 }, { id: 'c', position: 2 }];
  assert.deepEqual(reorderQueue(items, 'c', 0).map((item) => item.id), ['c', 'a', 'b']);
  assert.deepEqual(reorderQueue(items, 'a', 99).map((item) => `${item.id}${item.position}`), ['b0', 'c1', 'a2']);
  assert.equal(formatPlaybackTime(65), '1:05');
  assert.equal(formatPlaybackTime(3725), '1:02:05');
});

test('wire contract: heartbeat carries only playback state, hints only a version', () => {
  const mediaId = '11111111-1111-4111-8111-111111111111';
  assert.deepEqual(
    toRoomBroadcastPayload('media_heartbeat', { mediaId, castId: 'c-1', time: 12.5, speed: 1, playing: true, url: 'https://evil.example/a.mp4', title: 'secret' }),
    { mediaId, castId: 'c-1', time: 12.5, speed: 1, playing: true },
  );
  assert.equal(toRoomBroadcastPayload('media_heartbeat', { time: 3 }), null, 'needs a media id');
  assert.deepEqual(toRoomBroadcastPayload('queue_changed', { version: 5, title: 'x' }), { version: 5 });
  assert.equal(toRoomBroadcastPayload('clips_changed', {}), null);
});

test('player contract and sync wiring', () => {
  const stage = read('src/components/room/MediaStage.tsx');
  for (const forbidden of ['getInternalPlayer', 'config.file', ' as any', 'url={']) {
    assert.ok(!stage.includes(forbidden), `MediaStage must not use ${forbidden}`);
  }
  assert.match(stage, /src=\{playbackUrl\}/);
  assert.match(stage, /playerRef\.current\?\.currentTime/);
  assert.match(stage, /const targetTime = expectedPosition\(mediaState, Date\.now\(\)\);/);
  assert.match(stage, /if \(connectionGeneration > 1\) broadcastEvent\('request_sync'\);/);
  assert.match(stage, /shouldBroadcastNative\('play'/);
  assert.match(stage, /seekCoalescer\.current\?\.push\(safeGetTime\(\)\)/);
  // Walkthrough regressions: a controller who reloads (restored snapshot)
  // must still be able to act, and the echo guard must only arm when the sync
  // effect really changes the element (a play right after a seek was lost).
  assert.doesNotMatch(stage, /if \(!canCast \|\| mediaState\?\.source === 'restored'\) return;/);
  assert.match(stage, /if \(!willSeek && !willPlay && !willPause && !willChangeVolume\) \{\n\s+isSyncing\.current = false;/);
  assert.match(stage, /className="media-audio-caption" aria-live="polite"/, 'audio casts render the active subtitle cue');
  const sync = read('src/hooks/useRoomSync.ts');
  assert.match(sync, /if \(eventType === 'media_heartbeat'\) return 'control';/, 'heartbeat on sync-control (watch_control to publish)');
  assert.match(sync, /if \(eventType === 'queue_changed' \|\| eventType === 'clips_changed'\) return 'watch';/);
  assert.match(sync, /current\.controllerId !== event\.sender_id\)\) return;/, 'only the controller\'s heartbeat counts');
  assert.equal((sync.match(/supabase\.channel\(/g) ?? []).length, 5, 'no new channel');
});

test('queue and clips migration: RLS read, capability-checked RPC writes', () => {
  const sql = read('supabase/migrations/20261106100000_action11_watch_queue_clips.sql');
  for (const table of ['room_media_queue', 'room_media_clips']) {
    assert.match(sql, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY;`));
    assert.match(sql, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM PUBLIC, anon, authenticated;\\n`));
  }
  assert.match(sql, /media_id uuid NOT NULL REFERENCES public\.temporary_media\(id\) ON DELETE CASCADE/);
  assert.match(sql, /room_has_capability\(v_item\.room_id, v_uid, 'watch_control'\)/);
  assert.doesNotMatch(sql, /GRANT (INSERT|UPDATE|DELETE)/);
  for (const body of sql.split('CREATE OR REPLACE FUNCTION').slice(1)) assert.match(body.split('AS $$')[0], /SET search_path = ''/);
});
