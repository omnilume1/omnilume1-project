import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  countSpots,
  publicUsersForViewer,
  heartbeatArgs,
  heartbeatLeader,
  heartbeatPaused,
  HIDDEN_PAUSE_MS,
  liveStatusKey,
  normalizeSpot,
  strictestDoor,
} from '../src/lib/room-live-status.js';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');

test('the lowest user id leads the heartbeat', () => {
  assert.equal(heartbeatLeader([{ user_id: 'c' }, { user_id: 'a' }, { user_id: 'b' }]), 'a');
  assert.equal(heartbeatLeader([{ user_id: '9f' }, { user_id: '0a' }]), '0a');
  assert.equal(heartbeatLeader([]), null);
  assert.equal(heartbeatLeader([{ user_id: '' }, { user_id: 'b' }]), 'b');
});

test('spots are counted once per person, defaulting to bed', () => {
  const result = countSpots([
    { user_id: 'a', spot: 'desk' },
    { user_id: 'b', spot: 'desk' },
    { user_id: 'c', spot: 'screen' },
    { user_id: 'd' },
    { user_id: 'e', spot: 'roof' },
    { user_id: 'a', spot: 'desk' }, // a second tab
  ]);
  assert.deepEqual(result, { people: 5, spots: { desk: 2, screen: 1, speaker: 0, bed: 2 } });
  assert.equal(normalizeSpot('speaker'), 'speaker');
  assert.equal(normalizeSpot(undefined), 'bed');
});

test('the strictest door wins: dnd > knock > open', () => {
  assert.equal(strictestDoor([]), 'open');
  assert.equal(strictestDoor([{ user_id: 'a' }, { user_id: 'b', door: 'open' }]), 'open');
  assert.equal(strictestDoor([{ user_id: 'a', door: 'knock' }, { user_id: 'b', door: 'open' }]), 'knock');
  assert.equal(strictestDoor([{ user_id: 'a', door: 'knock' }, { user_id: 'b', door: 'dnd' }]), 'dnd');
  assert.equal(strictestDoor([{ user_id: 'a', door: 'locked' }]), 'open');
});

test('ghosts are not on the public list, so they never change the counts or lead', () => {
  const publicUsers = [{ user_id: 'b', spot: 'desk' }, { user_id: 'c' }];
  const ghost = { user_id: 'a', spot: 'screen', door: 'dnd' };
  const merged = [...publicUsers, ghost];
  // The heartbeat reads the public list only.
  assert.deepEqual(heartbeatArgs('r', publicUsers), { p_room_id: 'r', p_people: 2, p_spots: { desk: 1, screen: 0, speaker: 0, bed: 1 }, p_door: 'open' });
  assert.notEqual(heartbeatLeader(publicUsers), ghost.user_id);
  assert.notEqual(liveStatusKey(merged), liveStatusKey(publicUsers));
  const presence = read('src/hooks/useRoomPresence.ts');
  assert.match(presence, /useRoomHeartbeat\(roomId, selfId, visiblePublicUsers\)/);
  assert.match(presence, /setPublicUsers\(uniqueUsers\(channelUsers\(publicChannel\)\)\)/);
  assert.match(presence, /publicUsersForViewer\(publicUsers, selfId, isGhostMode\)/);
  assert.match(presence, /\(ghostMode && isPrivateScope\) \|\| \(!ghostMode && !isPrivateScope\)/);
});

test('a ghost viewer never counts their own stale public presence', () => {
  const publicUsers = [
    { user_id: 'a', spot: 'screen' },
    { user_id: 'b', spot: 'desk' },
  ];
  assert.deepEqual(publicUsersForViewer(publicUsers, 'a', true), [publicUsers[1]]);
  assert.equal(publicUsersForViewer(publicUsers, 'a', false), publicUsers);
  assert.equal(publicUsersForViewer(publicUsers, null, true), publicUsers);
});

test('the status key changes only when counts or the door change', () => {
  const a = [{ user_id: 'a', spot: 'desk' }, { user_id: 'b' }];
  const b = [{ user_id: 'b' }, { user_id: 'a', spot: 'desk' }];
  assert.equal(liveStatusKey(a), liveStatusKey(b));
  assert.notEqual(liveStatusKey(a), liveStatusKey([{ user_id: 'a', spot: 'screen' }, { user_id: 'b' }]));
  assert.notEqual(liveStatusKey(a), liveStatusKey([{ user_id: 'a', spot: 'desk', door: 'knock' }, { user_id: 'b' }]));
});

test('heartbeats pause after 2 minutes hidden', () => {
  assert.equal(heartbeatPaused(null, 1_000_000), false);
  assert.equal(heartbeatPaused(1_000_000, 1_000_000 + HIDDEN_PAUSE_MS), false);
  assert.equal(heartbeatPaused(1_000_000, 1_000_001 + HIDDEN_PAUSE_MS), true);
});

test('the live status migration is member-only and keeps clients off the table', () => {
  const sql = read('supabase/migrations/20261110071805_phase03_room_live_status.sql');
  assert.match(sql, /REVOKE ALL ON TABLE public\.room_live_status FROM PUBLIC, anon, authenticated;/);
  assert.doesNotMatch(sql, /CREATE POLICY/);
  assert.doesNotMatch(sql, /GRANT[^;]*\banon\b/);
  assert.equal(sql.match(/is_approved_room_member\([^)]*auth\.uid\(\)\)/g)?.length, 2);
  assert.match(sql, /v_people >= 2 AND NOT EXISTS/);
  assert.match(sql, /interval '10 minutes'/);
  assert.match(sql, /'people', v_people, 'desk', v_desk, 'screen', v_screen, 'speaker', v_speaker, 'bed', v_bed/);
  assert.match(sql, /interval '2 minutes'/);
  assert.match(read('src/hooks/useRoomHeartbeat.ts'), /createClient\(\)\.rpc\('room_heartbeat'/);
});
