import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  ACTIVITY_KINDS,
  DEFAULT_DISCOVER_FILTERS,
  activeFilterCount,
  bucketRoom,
  describeActivity,
  discoverArgs,
  exportFileName,
  groupActivityByDay,
  mergeActivity,
  organizeRooms,
  pulseChips,
  relativeTime,
  type ActivityRow,
  type OverviewRoom,
} from '../src/lib/room-management-model.js';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
const row = (id: number, created_at: string, kind: ActivityRow['kind'] = 'announcement'): ActivityRow =>
  ({ id, kind, actor_id: 'u', actor_name: 'Sam', entity_id: null, detail: null, label: null, created_at });
const room = (overrides: Partial<OverviewRoom> = {}): OverviewRoom => ({
  room_id: 'r', name: 'Room', role: 'member', expiration_type: 'permanent', expires_at: null, is_group: false,
  member_count: 2, unread_count: 0, last_activity_at: null, next_event_at: null, open_tasks: 0, bookmarked: false, ...overrides,
});
const NOW = Date.parse('2026-11-08T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const ahead = (ms: number) => new Date(NOW + ms).toISOString();
const HOUR = 3_600_000;

test('activity wording covers every kind and never invents content', () => {
  for (const kind of ACTIVITY_KINDS) {
    const text = describeActivity({ kind, actor_name: 'Sam', detail: null, label: null });
    assert.ok(text.length > 4, kind);
    assert.ok(!text.includes('null') && !text.includes('undefined'), kind);
  }
  assert.equal(describeActivity({ kind: 'file_shared', actor_name: 'Sam', detail: null, label: 'notes.pdf' }), 'Sam shared notes.pdf');
  // A viewer without the capability gets no label, so no title leaks.
  assert.equal(describeActivity({ kind: 'file_shared', actor_name: 'Sam', detail: null, label: null }), 'Sam shared a file');
  assert.equal(describeActivity({ kind: 'role_changed', actor_name: 'Sam', detail: 'admin', label: null }), 'Sam changed a member’s role to admin');
});

test('merging activity de-duplicates by id and keeps newest first (live insert + refetch overlap)', () => {
  const merged = mergeActivity(
    [row(2, '2026-11-08T10:00:00Z'), row(1, '2026-11-08T09:00:00Z')],
    [row(3, '2026-11-08T11:00:00Z'), row(2, '2026-11-08T10:00:00Z')],
  );
  assert.deepEqual(merged.map((item) => item.id), [3, 2, 1]);
  assert.deepEqual(mergeActivity(merged, merged).map((item) => item.id), [3, 2, 1]);
});

test('activity groups by day with Today / Yesterday labels', () => {
  const now = new Date(2026, 10, 8, 12, 0, 0);
  const groups = groupActivityByDay([
    row(3, new Date(2026, 10, 8, 9).toISOString()),
    row(2, new Date(2026, 10, 7, 20).toISOString()),
    row(1, new Date(2026, 10, 7, 8).toISOString()),
  ], now);
  assert.deepEqual(groups.map((group) => [group.label, group.items.length]), [['Today', 1], ['Yesterday', 2]]);
});

test('pulse chips: counts only, hide capability-gated numbers', () => {
  assert.deepEqual(pulseChips(null, 3, NOW), ['3 online']);
  const chips = pulseChips({ members: 4, chat_15m: 1, activity_1h: 2, next_event: { id: 'e', title: 'Quiz', starts_at: ahead(2 * HOUR) }, open_tasks_mine: 2 }, 1, NOW);
  assert.deepEqual(chips, ['1 online', '1 message in 15 min', '2 updates this hour', 'Next: Quiz in 2h', '2 tasks for you']);
  const noChat = pulseChips({ members: 4, chat_15m: null, activity_1h: 0, next_event: null, open_tasks_mine: null }, 0, NOW);
  assert.deepEqual(noChat, ['0 online', '0 updates this hour']);
  assert.equal(relativeTime(ago(30 * 60_000), NOW), '30m ago');
});

test('smart organization: expiring > attention > active > saved > quiet, stable order', () => {
  assert.equal(bucketRoom(room({ expiration_type: 'recoverable', expires_at: ahead(2 * HOUR), unread_count: 9 }), NOW), 'expiring');
  assert.equal(bucketRoom(room({ expiration_type: 'recoverable', expires_at: ahead(5 * HOUR), unread_count: 9 }), NOW), 'attention', 'a room with hours left is not flagged');
  assert.equal(bucketRoom(room({ expiration_type: 'recoverable', expires_at: ahead(48 * HOUR), unread_count: 1 }), NOW), 'attention');
  assert.equal(bucketRoom(room({ expiration_type: 'recoverable', expires_at: ago(HOUR) }), NOW), 'quiet', 'an already-ended room is not "expiring"');
  assert.equal(bucketRoom(room({ open_tasks: 1 }), NOW), 'attention');
  assert.equal(bucketRoom(room({ next_event_at: ahead(3 * HOUR) }), NOW), 'attention');
  assert.equal(bucketRoom(room({ next_event_at: ahead(72 * HOUR) }), NOW), 'quiet');
  assert.equal(bucketRoom(room({ last_activity_at: ago(2 * HOUR) }), NOW), 'active');
  assert.equal(bucketRoom(room({ last_activity_at: ago(30 * HOUR), bookmarked: true }), NOW), 'saved');
  assert.equal(bucketRoom(room({ last_activity_at: ago(30 * HOUR) }), NOW), 'quiet');
  const organized = organizeRooms([
    room({ room_id: 'q', name: 'Quiet' }),
    room({ room_id: 'a2', name: 'B', unread_count: 1 }),
    room({ room_id: 'a1', name: 'A', unread_count: 5 }),
    room({ room_id: 'x', name: 'Soon', expiration_type: 'irreversible', expires_at: ahead(HOUR) }),
  ], NOW);
  assert.deepEqual(organized.map((group) => group.bucket), ['expiring', 'attention', 'quiet']);
  assert.deepEqual(organized[1].rooms.map((item) => item.room_id), ['a1', 'a2']);
  assert.deepEqual(organizeRooms([], NOW), []);
});

test('discovery arguments are normalised and bounded before they reach the RPC', () => {
  const base = discoverArgs(DEFAULT_DISCOVER_FILTERS);
  assert.deepEqual(base, { p_query: null, p_lifespan: null, p_min_members: null, p_feature: null, p_sort: 'newest', p_scope: 'public', p_limit: 24, p_offset: 0 });
  const args = discoverArgs({ query: `  ${'x'.repeat(150)}  `, lifespan: 'recoverable', feature: 'watch', minMembers: 99_999_999.7, sort: 'members', scope: 'mine' }, -5);
  assert.equal(args.p_query?.length, 100);
  assert.equal(args.p_min_members, 100_000);
  assert.equal(args.p_offset, 0);
  assert.equal(args.p_scope, 'mine');
  assert.equal(discoverArgs({ ...DEFAULT_DISCOVER_FILTERS, minMembers: Number.NaN }).p_min_members, null);
  assert.equal(activeFilterCount(DEFAULT_DISCOVER_FILTERS), 0);
  assert.equal(activeFilterCount({ ...DEFAULT_DISCOVER_FILTERS, lifespan: 'permanent', sort: 'active', minMembers: 3 }), 3);
});

test('export file names are safe', () => {
  assert.equal(exportFileName('Late Night: Study!', '2026-11-08T10:00:00Z'), 'omnilume-late-night-study-2026-11-08.json');
  assert.equal(exportFileName('../../etc/passwd', '2026-11-08T10:00:00Z'), 'omnilume-etc-passwd-2026-11-08.json');
  assert.equal(exportFileName('###', '2026-11-08T10:00:00Z'), 'omnilume-room-2026-11-08.json');
});

test('migration contract: Action 13 tables have RLS, minimal grants, definer functions pin search_path', () => {
  const sql = read('supabase/migrations/20261108100000_action13_activity_discovery.sql');
  for (const table of ['room_activity', 'room_bookmarks', 'room_templates', 'room_exports', 'room_event_rsvps']) {
    assert.match(sql, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`), table);
    assert.match(sql, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM PUBLIC, anon, authenticated`), table);
    assert.match(sql, new RegExp(`GRANT SELECT ON TABLE public\\.${table} TO authenticated`), table);
  }
  assert.ok(!/GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*TO (anon|authenticated)/i.test(sql), 'no direct write grants');
  const functions = sql.split(/CREATE OR REPLACE FUNCTION /).slice(1);
  assert.equal(functions.length, 17);
  for (const body of functions) {
    const name = body.slice(0, 40).split('(')[0];
    assert.match(body.slice(0, 700), /SECURITY DEFINER/, name);
    assert.match(body.slice(0, 700), /SET search_path = ''/, name);
  }
  // Only discovery is open to anon; everything else is signed-in only.
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.discover_rooms\([^)]*\) TO anon/);
  assert.equal((sql.match(/TO anon/g) ?? []).length, 1);
  assert.match(sql, /ALTER PUBLICATION supabase_realtime ADD TABLE public\.room_activity/);
});

test('discovery SQL excludes private, locked, scheduled, deleting and group rooms for the public scope', () => {
  const sql = read('supabase/migrations/20261108100000_action13_activity_discovery.sql');
  const discover = sql.slice(sql.indexOf('FUNCTION public.discover_rooms'), sql.indexOf('-- 4. Bookmarks'));
  for (const guard of ['NOT r.is_private', 'NOT r.is_group', 'r.scheduled_for IS NULL', 'r.deletion_scheduled_at IS NULL', 'NOT COALESCE(s.is_locked, false)', 'room_user_is_restricted']) {
    assert.ok(discover.includes(guard), guard);
  }
  assert.ok(!/ciphertext/i.test(discover), 'discovery never touches ciphertext');
});

test('activity is realtime through the existing private room channel only', () => {
  const sync = read('src/hooks/useRoomSync.ts');
  assert.match(sync, /table: 'room_activity', filter: `room_id=eq\.\$\{roomId\}`/);
  assert.equal((sync.match(/private: true/g) ?? []).length, 5, 'still exactly five private room channels');
  for (const file of ['src/components/room/RoomPulseBar.tsx', 'src/components/room/RoomActivityFeed.tsx', 'src/components/home/HomeOverview.tsx']) {
    assert.ok(!/\.channel\(/.test(read(file)), `${file} opens no channel`);
  }
});

test('export never selects keys, ciphertext bodies, paths or URLs', () => {
  const sql = read('supabase/migrations/20261108100000_action13_activity_discovery.sql');
  const exportFn = sql.slice(sql.indexOf('FUNCTION public.export_room_snapshot'), sql.indexOf('FUNCTION public.record_room_export_digest'))
    .split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  assert.ok(!/public_key|storage_path|object_path|file_url|signed/i.test(exportFn));
  assert.match(exportFn, /m\.ciphertext IS NULL/);
  assert.match(exportFn, /P0429/);
  const action = read('src/actions/room-management.ts');
  assert.match(action, /createHash\('sha256'\)/);
  assert.match(action, /record_room_export_digest/);
});
