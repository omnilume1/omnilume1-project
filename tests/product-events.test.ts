import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  isNewMembership,
  isValidRef,
  logProductEventFromBrowser,
  productEventArgs,
  PRODUCT_EVENTS,
  refFromCookieString,
  refToStore,
} from '../src/lib/product-events.js';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
const params = (query: string) => new URLSearchParams(query);

test('ref tags are short lowercase slugs', () => {
  assert.ok(isValidRef('campus-iitb'));
  assert.ok(isValidRef('lp-a'));
  assert.ok(!isValidRef('Campus'));
  assert.ok(!isValidRef('a b'));
  assert.ok(!isValidRef(''));
  assert.ok(!isValidRef('x'.repeat(41)));
  assert.ok(!isValidRef(null));
});

test('the ref cookie is first touch and set only on /, /login and /join/*', () => {
  assert.equal(refToStore('/', params('ref=founder'), null), 'founder');
  assert.equal(refToStore('/login', params('ref=break'), undefined), 'break');
  assert.equal(refToStore('/join/abc', params('ref=recap'), null), 'recap');
  assert.equal(refToStore('/', params('v=b'), null), 'lp-b');
  assert.equal(refToStore('/', params(''), null), 'lp-a');
  assert.equal(refToStore('/', params('v=b&ref=alumni'), null), 'alumni');
  // First touch wins.
  assert.equal(refToStore('/', params('ref=founder'), 'lp-a'), null);
  assert.equal(refToStore('/', params(''), 'campus-x'), null);
  // An invalid existing cookie doesn't block a valid ref.
  assert.equal(refToStore('/', params('ref=founder'), 'BAD VALUE'), 'founder');
  // Other paths, or no ref on /login and /join, leave it alone.
  assert.equal(refToStore('/home', params('ref=founder'), null), null);
  assert.equal(refToStore('/login', params(''), null), null);
  assert.equal(refToStore('/join/abc', params(''), null), null);
  // An invalid ref on / doesn't fall back to lp-a.
  assert.equal(refToStore('/', params('ref=Bad!'), null), null);
});

test('the ref is read from a cookie string', () => {
  assert.equal(refFromCookieString('a=1; omni_ref=campus-x; b=2'), 'campus-x');
  assert.equal(refFromCookieString('omni_ref=Bad'), null);
  assert.equal(refFromCookieString(''), null);
  assert.equal(refFromCookieString(undefined), null);
});

test('an explicit ref wins over the cookie, and empty meta becomes null', () => {
  assert.deepEqual(productEventArgs('joined', { roomId: 'r', ref: 'recap' }, 'lp-a'), { p_event: 'joined', p_room_id: 'r', p_ref: 'recap', p_meta: null });
  assert.deepEqual(productEventArgs('joined', { ref: 'BAD' }, 'lp-a'), { p_event: 'joined', p_room_id: null, p_ref: 'lp-a', p_meta: null });
  assert.deepEqual(productEventArgs('timer_started', { meta: { minutes: 25 } }, null).p_meta, { minutes: 25 });
  assert.equal(productEventArgs('timer_started', { meta: {} }, null).p_meta, null);
});

test('only a membership created by this request counts as joined', () => {
  const start = Date.parse('2026-11-10T10:00:00Z');
  assert.ok(isNewMembership('2026-11-10T10:00:02Z', start));
  assert.ok(isNewMembership('2026-11-10T09:59:55Z', start));
  assert.ok(!isNewMembership('2026-11-09T10:00:00Z', start));
  assert.ok(!isNewMembership(null, start));
  assert.ok(!isNewMembership('not a date', start));
});

test('the browser helper never throws', async () => {
  await logProductEventFromBrowser({ rpc: () => { throw new Error('offline'); } }, 'timer_started');
  await logProductEventFromBrowser({ rpc: () => Promise.reject(new Error('offline')) }, 'timer_started');
  let args: unknown;
  await logProductEventFromBrowser({ rpc: async (_fn, value) => { args = value; return { error: null }; } }, 'timer_completed', { roomId: 'r', meta: { minutes: 5 } });
  assert.deepEqual(args, { p_event: 'timer_completed', p_room_id: 'r', p_ref: null, p_meta: { minutes: 5 } });
});

test('the ledger migration keeps clients out and matches the app event list', () => {
  const sql = read('supabase/migrations/20261110071321_phase02_product_events.sql');
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.product_events FROM PUBLIC, anon, authenticated;/);
  assert.doesNotMatch(sql, /CREATE POLICY/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.log_product_event\(text, uuid, text, jsonb\) TO authenticated;/);
  assert.doesNotMatch(sql, /GRANT[^;]*\banon\b/);
  assert.match(sql, /is_approved_room_member\(p_room_id, auth\.uid\(\)\)/);
  // Every client event is accepted by the RPC; room_tick is server-only.
  const rpc = sql.slice(sql.indexOf('CREATE FUNCTION public.log_product_event'));
  for (const event of PRODUCT_EVENTS) assert.match(rpc, new RegExp(`'${event}'`));
  assert.doesNotMatch(rpc.slice(0, rpc.indexOf('RAISE EXCEPTION \'Unknown event.\'')), /'room_tick'/);
  // No personal data columns.
  const table = sql.slice(sql.indexOf('CREATE TABLE public.product_events'), sql.indexOf('COMMENT ON TABLE'));
  assert.doesNotMatch(table, /user_id|\bip\b|title|text_body/);
});

test('timer and room events are logged where the roadmap says', () => {
  const study = read('src/components/room/StudyStage.tsx');
  assert.match(study, /if \(!isResume\) void logProductEventFromBrowser\(createClient\(\), 'timer_started'/);
  assert.match(study, /logProductEventFromBrowser\(createClient\(\), 'timer_completed'/);
  assert.match(read('src/actions/rooms.ts'), /logProductEventAfter\('room_created'/);
  const controls = read('src/actions/room-controls.ts');
  assert.match(controls, /logProductEventAfter\('invite_created'/);
  assert.match(controls, /'guest_joined' : 'joined'/);
  assert.match(controls, /isNewMembership\(/);
  assert.match(read('src/lib/product-events-server.ts'), /after\(async/);
});
