import assert from 'node:assert/strict';
import test from 'node:test';
import { VOICE_CHAIRS, chairsTakenMessage, isFull, nextChairStep, pruneSeen, screenFullMessage, seatedIds } from '../src/lib/voice-seats.js';

const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, at: 1_000 + i }));

test('six chairs: the cap is 6 and the copy names it', () => {
  assert.equal(VOICE_CHAIRS, 6);
  assert.equal(chairsTakenMessage(6), "All 6 chairs are taken. You're on the floor: chat along, and you'll get a chair when one frees up.");
  assert.equal(screenFullMessage(6), 'Screen is full (6 watching).');
  assert.equal(screenFullMessage(1), 'Screen is full (1 watching).');
});

test('six chairs: under the cap everyone is seated and it is not full', () => {
  const members = ids(4);
  assert.deepEqual([...seatedIds(members, 6)].sort(), ['m0', 'm1', 'm2', 'm3']);
  assert.equal(isFull(members.length, 6), false);
  assert.equal(isFull(5, 6), false);
});

test('six chairs: at the cap it is full and a 7th member is not seated', () => {
  assert.equal(isFull(6, 6), true);
  assert.equal(isFull(7, 6), true);
  const members = [...ids(6), { id: 'late', at: 9_999 }];
  const seated = seatedIds(members, 6);
  assert.equal(seated.size, 6);
  assert.equal(seated.has('late'), false);
});

test('six chairs: two joiners at 5 seated end with exactly 6, the earlier one in', () => {
  const five = ids(5);
  const x = { id: 'zz-joiner', at: 5_000 };
  const y = { id: 'aa-joiner', at: 5_150 };
  // Each joiner computes from its own view, in any order: both views agree.
  const fromX = seatedIds([...five, y, x], 6);
  const fromY = seatedIds([x, ...five, y], 6);
  assert.deepEqual([...fromX].sort(), [...fromY].sort());
  assert.equal(fromX.size, 6);
  assert.equal(fromX.has('zz-joiner'), true);
  assert.equal(fromX.has('aa-joiner'), false);
});

test('six chairs: a member without `at` (an old client) counts as already seated', () => {
  const members = [...ids(6).map((m) => ({ ...m, at: m.at + 10 })), { id: 'old-client' }];
  const seated = seatedIds(members, 6);
  assert.equal(seated.has('old-client'), true);
  assert.equal(seated.has('m5'), false, 'the newest timed member gives up the chair');
  assert.deepEqual([...seatedIds([{ id: 'b' }, { id: 'a' }], 1)], ['a'], 'two without `at` tie by id');
});

test('six chairs: equal `at` breaks the tie by id', () => {
  const seated = seatedIds([{ id: 'b', at: 7 }, { id: 'c', at: 7 }, { id: 'a', at: 7 }], 2);
  assert.deepEqual([...seated].sort(), ['a', 'b']);
  assert.equal(seatedIds([{ id: 'x', at: 1 }], 0).size, 0, 'a cap of 0 seats nobody');
});

test('six chairs: a member silent past the timeout frees the chair', () => {
  const seen = new Map<string, { at?: number; seen: number }>([
    ['fresh', { at: 1, seen: 100_000 }],
    ['stale', { at: 2, seen: 60_000 }],
  ]);
  assert.equal(pruneSeen(seen, 100_000, 32_000), true);
  assert.deepEqual([...seen.keys()], ['fresh']);
  assert.equal(pruneSeen(seen, 100_000, 32_000), false, 'nothing left to drop');
  assert.equal(pruneSeen(seen, 132_000, 32_000), false, 'exactly at the timeout still counts');
  assert.equal(pruneSeen(seen, 132_001, 32_000), true);
  assert.equal(seen.size, 0);
});

test('six chairs: "Take the next chair" joins only when a chair is free and the room is live', () => {
  const live = { count: 5, cap: 6, watchOnly: false, shareLive: false, connected: true, heardAgoMs: 3_000, timeoutMs: 32_000 };
  assert.equal(nextChairStep(live), 'join');
  assert.equal(nextChairStep({ ...live, count: 6 }), 'wait', 'still full');
  // Our own connection went quiet: everyone expired at once, but the room is still full.
  assert.equal(nextChairStep({ ...live, count: 0, heardAgoMs: 40_000 }), 'ask', 'silence is not a free chair');
  assert.equal(nextChairStep({ ...live, connected: false }), 'ask', 'not while the room connection is down');
  assert.equal(nextChairStep({ ...live, heardAgoMs: 32_000 }), 'join', 'exactly at the timeout still counts as live');
});

test('six chairs: waiting to watch gives up once the share has ended', () => {
  const watch = { count: 5, cap: 6, watchOnly: true, shareLive: true, connected: true, heardAgoMs: 1_000, timeoutMs: 32_000 };
  assert.equal(nextChairStep(watch), 'join');
  assert.equal(nextChairStep({ ...watch, shareLive: false }), 'give-up');
  assert.equal(nextChairStep({ ...watch, shareLive: false, count: 6 }), 'give-up', 'nothing left to wait for even while full');
  assert.equal(nextChairStep({ ...watch, watchOnly: false, shareLive: false }), 'join', 'a mic seat does not need a share');
});
