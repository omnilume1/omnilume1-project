import assert from 'node:assert/strict';
import test from 'node:test';
import { createSilentEngine, type MusicTrack } from '../src/lib/music-model.js';
import * as Q from '../src/lib/music-queue.js';

const track = (id: string): MusicTrack => ({ id, title: id, artist: 'A', album: 'X', durationMs: 180_000, hue: 0 });
const list = ['a', 'b', 'c', 'd', 'e'].map(track);
const ids = (tracks: MusicTrack[]) => tracks.map((item) => item.id).join('');
const reverseRng = () => 0; // Fisher-Yates with 0 picks index 0 every time: deterministic.

test('starting a list plays the picked track and keeps earlier tracks behind', () => {
  const q = Q.startList(Q.emptyQueue, list, 2, 'Album X');
  assert.equal(q.current?.id, 'c');
  assert.equal(q.source, 'Album X');
  assert.equal(ids(Q.upNext(q).context), 'de');
  const back = Q.previous(q, 2_000);
  assert.notEqual(back, 'restart');
  assert.equal((back as Q.MusicQueue).current?.id, 'b');
});

test('play next goes to the head, add to queue to the tail, both before the list; dedupe', () => {
  let q = Q.startList(Q.emptyQueue, list, 0, 'X');
  q = Q.addToQueue(q, track('y'));
  q = Q.playNext(q, track('z'));
  q = Q.addToQueue(q, track('y'));
  assert.equal(ids(q.user), 'zy');
  q = Q.playNext(q, track('y'));
  assert.equal(ids(q.user), 'yz', 'play next moves an already-queued track to the head');
  q = Q.next(q);
  assert.equal(q.current?.id, 'y');
  assert.equal(q.currentFromUser, true);
  q = Q.next(Q.next(q));
  assert.equal(q.current?.id, 'b', 'list resumes after the hand-queued tracks');
});

test('adding to an idle queue starts playback', () => {
  const q = Q.addToQueue(Q.emptyQueue, track('solo'));
  assert.equal(q.current?.id, 'solo');
});

test('jump: list row seeks forward, queued row drops the bypassed ones', () => {
  let q = Q.startList(Q.emptyQueue, list, 0, 'X');
  assert.equal(Q.jumpTo(q, 'context', 2).current?.id, 'd');
  q = Q.addToQueue(Q.addToQueue(Q.addToQueue(q, track('p')), track('q')), track('r'));
  const jumped = Q.jumpTo(q, 'user', 1);
  assert.equal(jumped.current?.id, 'q');
  assert.equal(ids(jumped.user), 'r');
});

test('shuffle leads with the current track and restores the original order when off', () => {
  let q = Q.startList(Q.emptyQueue, list, 2, 'X');
  q = Q.setShuffle(q, true, reverseRng);
  assert.equal(q.context[0].id, 'c');
  assert.equal(q.index, 0);
  assert.equal(new Set(q.context.map((item) => item.id)).size, 5);
  q = Q.next(q);
  q = Q.setShuffle(q, false);
  assert.equal(ids(q.context), 'abcde');
  assert.equal(q.context[q.index].id, q.current?.id);
});

test('starting a list with shuffle on leads with the picked track', () => {
  const q = Q.startList({ ...Q.emptyQueue, shuffle: true }, list, 3, 'X', Math.random);
  assert.equal(q.current?.id, 'd');
  assert.equal(q.context[0].id, 'd');
  assert.equal(q.context.length, 5);
});

test('repeat cycles off → all → one; end of list stops unless repeat all', () => {
  assert.equal(Q.cycleRepeat('off'), 'all');
  assert.equal(Q.cycleRepeat('all'), 'one');
  assert.equal(Q.cycleRepeat('one'), 'off');
  const last = Q.startList(Q.emptyQueue, list, 4, 'X');
  assert.equal(Q.next(last), last, 'same object = nothing follows');
  assert.equal(Q.next({ ...last, repeat: 'all' }).current?.id, 'a');
  assert.equal((Q.previous({ ...Q.startList(Q.emptyQueue, list, 0, 'X'), repeat: 'all' }, 0) as Q.MusicQueue).current?.id, 'e');
});

test('back restarts the track after 10 s and at the start of the list', () => {
  const q = Q.startList(Q.emptyQueue, list, 2, 'X');
  assert.equal(Q.previous(q, 10_001), 'restart');
  assert.notEqual(Q.previous(q, 10_000), 'restart');
  assert.equal(Q.previous(Q.startList(Q.emptyQueue, list, 0, 'X'), 0), 'restart');
});

test('back from a hand-queued track returns to the list track', () => {
  const q = Q.next(Q.addToQueue(Q.startList(Q.emptyQueue, list, 1, 'X'), track('z')));
  assert.equal(q.current?.id, 'z');
  assert.equal((Q.previous(q, 0) as Q.MusicQueue).current?.id, 'b');
});

test('clear removes only hand-queued tracks; remove and move edit one tier', () => {
  let q = Q.addToQueue(Q.startList(Q.emptyQueue, list, 0, 'X'), track('z'));
  assert.equal(Q.clearUpcoming(q).user.length, 0);
  assert.equal(ids(Q.upNext(Q.clearUpcoming(q)).context), 'bcde');
  q = Q.removeUpcoming(q, 'context', 1);
  assert.equal(ids(Q.upNext(q).context), 'bde');
  assert.equal(ids(q.original), 'abde', 'removed tracks stay gone after shuffle off');
  q = Q.moveUpcoming(q, 'context', 0, 2);
  assert.equal(ids(Q.upNext(q).context), 'deb');
  assert.equal(Q.moveUpcoming(q, 'context', 0, 9), q, 'out-of-range move is ignored');
});

test('silent engine advances on its clock, seeks, and reports ended once', () => {
  let now = 0;
  const engine = createSilentEngine(() => now);
  engine.load(track('a'));
  engine.play();
  now = 5_000;
  assert.equal(engine.currentTime(), 5_000);
  engine.pause();
  now = 9_000;
  assert.equal(engine.currentTime(), 5_000);
  engine.seek(179_000);
  assert.equal(engine.currentTime(), 179_000);
  engine.destroy();
});
