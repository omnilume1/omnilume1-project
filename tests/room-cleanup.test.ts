import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { cleanupDestroyedRooms, cleanupExpiredMedia, isMissingParentRow } from '../src/lib/room-cleanup.js';

type Result = { data?: unknown; error?: { code?: string; message: string } | null };
type Call = { table?: string; rpc?: string; op: string; filters: Record<string, unknown>; payload?: unknown };
type Handler = (call: Call) => Result;

// Minimal stand-in for the Supabase client surface the cleanup steps use.
function fakeClient(handler: Handler) {
  const calls: Call[] = [];
  const run = (call: Call) => { calls.push(call); return Promise.resolve({ data: null, error: null, ...handler(call) }); };
  const query = (table: string) => {
    const call: Call = { table, op: 'select', filters: {} };
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => { call.filters[column] = value; return builder; },
      lte: (column: string, value: unknown) => { call.filters[`${column}<=`] = value; return builder; },
      limit: () => builder,
      maybeSingle: () => run({ ...call, op: call.op === 'select' ? 'maybeSingle' : call.op }),
      upsert: (payload: unknown) => run({ ...call, op: 'upsert', payload }),
      update: (payload: unknown) => { call.op = 'update'; call.payload = payload; return builder; },
      delete: () => { call.op = 'delete'; return builder; },
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => run({ ...call }).then(resolve, reject),
    };
    return builder;
  };
  const client = {
    from: query,
    rpc: (name: string, args: Record<string, unknown>) => run({ rpc: name, op: 'rpc', filters: args }),
    storage: {
      from: () => ({
        list: (prefix: string) => run({ table: 'storage', op: 'list', filters: { prefix } }),
        remove: (paths: string[]) => run({ table: 'storage', op: 'remove', filters: {}, payload: paths }),
      }),
    },
  };
  return { client: client as never, calls };
}

const NOW = '2026-11-05T08:00:00.000Z';

test('a foreign-key violation means the parent row is already gone', () => {
  assert.equal(isMissingParentRow({ code: '23503' }), true);
  assert.equal(isMissingParentRow({ code: '42501' }), false);
  assert.equal(isMissingParentRow(null), false);
});

test('overlapping runs: a room already destroyed by another run is skipped, not a failure', async () => {
  const { client, calls } = fakeClient((call) => {
    if (call.rpc === 'list_rooms_due_for_destruction') return { data: ['room-gone', 'room-due'] };
    if (call.table === 'room_cleanup_jobs' && call.op === 'upsert') {
      return (call.payload as { room_id: string }).room_id === 'room-gone'
        ? { error: { code: '23503', message: 'insert or update on table "room_cleanup_jobs" violates foreign key constraint' } }
        : {};
    }
    if (call.table === 'storage' && call.op === 'list') return { data: [] };
    if (call.rpc === 'destroy_expired_room') return { data: true };
    return {};
  });
  const result = await cleanupDestroyedRooms(client, NOW);
  assert.deepEqual(result, { removed: 1, failures: [], skipped: 1 });
  // The skipped room never reaches storage removal or destruction.
  assert.ok(!calls.some((call) => call.rpc === 'destroy_expired_room' && call.filters.p_room_id === 'room-gone'));
});

test('a room that vanished between listing and destruction is skipped', async () => {
  const { client } = fakeClient((call) => {
    if (call.rpc === 'list_rooms_due_for_destruction') return { data: ['room-raced'] };
    if (call.table === 'storage' && call.op === 'list') return { data: [] };
    if (call.rpc === 'destroy_expired_room') return { data: false };
    if (call.table === 'rooms' && call.op === 'maybeSingle') return { data: null };
    return {};
  });
  assert.deepEqual(await cleanupDestroyedRooms(client, NOW), { removed: 0, failures: [], skipped: 1 });
});

test('real failures are still reported (207) or abort the run (500)', async () => {
  // Storage removal fails: reported per room, the run continues.
  const storageFailure = fakeClient((call) => {
    if (call.rpc === 'list_rooms_due_for_destruction') return { data: ['room-a'] };
    if (call.table === 'storage' && call.op === 'list') return { data: [{ id: 'obj', name: 'file.pdf' }] };
    if (call.table === 'storage' && call.op === 'remove') return { error: { message: 'storage unavailable' } };
    return {};
  });
  const result = await cleanupDestroyedRooms(storageFailure.client, NOW);
  assert.equal(result.removed, 0);
  assert.equal(result.skipped, 0);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /^room:room-a:storage unavailable/);

  // A room that still exists but is no longer due is a failure, not a skip.
  const notDue = fakeClient((call) => {
    if (call.rpc === 'list_rooms_due_for_destruction') return { data: ['room-b'] };
    if (call.table === 'storage' && call.op === 'list') return { data: [] };
    if (call.rpc === 'destroy_expired_room') return { data: false };
    if (call.table === 'rooms' && call.op === 'maybeSingle') return { data: { id: 'room-b' } };
    return {};
  });
  assert.equal((await cleanupDestroyedRooms(notDue.client, NOW)).failures.length, 1);

  // Any other job-table error aborts the whole run (the route answers 500).
  const permissionError = fakeClient((call) => {
    if (call.rpc === 'list_rooms_due_for_destruction') return { data: ['room-c'] };
    if (call.table === 'room_cleanup_jobs' && call.op === 'upsert') return { error: { code: '42501', message: 'permission denied' } };
    return {};
  });
  await assert.rejects(cleanupDestroyedRooms(permissionError.client, NOW), /permission denied/);

  const route = readFileSync(resolve(process.cwd(), 'src/app/api/internal/cleanup-expired-rooms/route.ts'), 'utf8');
  assert.match(route, /status: failures\.length === 0 \? 200 : 207/);
  assert.match(route, /status: 500/);
});

test('overlapping runs: expired media already deleted by another run is skipped', async () => {
  const { client } = fakeClient((call) => {
    if (call.table === 'temporary_media' && call.op === 'select') return { data: [{ id: 'media-gone', room_id: 'r', file_url: 'r/media/x.mp4', storage_path: null, subtitle_path: null }] };
    if (call.table === 'temporary_media_cleanup_jobs' && call.op === 'upsert') return { error: { code: '23503', message: 'violates foreign key constraint' } };
    return {};
  });
  assert.deepEqual(await cleanupExpiredMedia(client, NOW), { removed: 0, failures: [], skipped: 1 });
});
