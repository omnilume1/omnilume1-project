import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clockTime,
  doorNoticeFor,
  focusLine,
  joinFrom,
  joinPath,
  liveLine,
  parseDoorNotice,
  parseJoinCard,
  roomLabel,
  safeTimeZone,
  type JoinCard,
} from '../src/lib/join-card.js';

const ROW = {
  room_name: 'Night Owls',
  nameplate: 'B-204',
  member_count: 6,
  people: 3,
  desk: 1,
  screen: 2,
  speaker: 0,
  bed: 0,
  door: 'open',
  is_visitor_pass: false,
  visitor_until: null,
  focus_ends_at: null,
};

const card = (overrides: Partial<JoinCard> = {}): JoinCard => ({ ...parseJoinCard(ROW)!, ...overrides });

test('a card row parses to the fields the page shows, nothing else', () => {
  assert.deepEqual(parseJoinCard(ROW), {
    roomName: 'Night Owls', nameplate: 'B-204', people: 3, desk: 1, screen: 2, speaker: 0, bed: 0, focusEndsAt: null,
  });
  assert.equal(parseJoinCard(null), null);
  assert.equal(parseJoinCard([]), null);
  assert.equal(parseJoinCard({ ...ROW, room_name: '  ' }), null);
  const odd = parseJoinCard({ ...ROW, nameplate: '', people: -2, desk: 1.9, screen: '4' })!;
  assert.equal(odd.nameplate, null);
  assert.equal(odd.people, 0);
  assert.equal(odd.desk, 1);
  assert.equal(odd.screen, 0);
});

test('the live line lists the busiest spot first, lights off when nobody is in', () => {
  assert.equal(liveLine(card()), 'Room B-204 · lights on · 2 at the screen · 1 at the desk');
  assert.equal(liveLine(card({ people: 0, desk: 0, screen: 0 })), 'Room B-204 · lights off');
  assert.equal(
    liveLine(card({ people: 4, desk: 1, screen: 1, speaker: 1, bed: 1 })),
    'Room B-204 · lights on · 1 at the desk · 1 at the screen · 1 by the speaker · 1 on the bed',
  );
  assert.equal(liveLine(card({ nameplate: null, people: 0, desk: 0, screen: 0 })), 'Night Owls · lights off');
  assert.equal(roomLabel({ nameplate: 'C 12', roomName: 'x' }), 'Room C 12');
});

test('focus ends shows a clock time in the given zone, only for a timer still running', () => {
  const now = Date.parse('2026-11-10T15:00:00Z');
  assert.equal(focusLine('2026-11-10T16:10:00Z', 'Asia/Kolkata', now), 'focus ends 9:40 pm');
  assert.equal(focusLine('2026-11-10T16:10:00Z', 'UTC', now), 'focus ends 4:10 pm');
  assert.equal(focusLine('2026-11-10T14:59:00Z', 'UTC', now), null);
  assert.equal(focusLine(null, 'UTC', now), null);
  assert.equal(focusLine('not a date', 'UTC', now), null);
  assert.equal(clockTime(new Date('2026-11-10T06:05:00Z'), 'Asia/Kolkata'), '11:35 am');
});

test('an unknown time zone falls back to the default', () => {
  assert.equal(safeTimeZone('Europe/London'), 'Europe/London');
  assert.equal(safeTimeZone('Mars/Olympus'), 'Asia/Kolkata');
  assert.equal(safeTimeZone(null), 'Asia/Kolkata');
  assert.equal(safeTimeZone('', 'UTC'), 'UTC');
});

test('from is visitor for a guest, else callin for a call-in link, else invite', () => {
  assert.equal(joinFrom('guest', 'callin'), 'visitor');
  assert.equal(joinFrom('guest', null), 'visitor');
  assert.equal(joinFrom('member', 'callin'), 'callin');
  assert.equal(joinFrom('admin', 'campus-iitb'), 'invite');
  assert.equal(joinFrom('member', null), 'invite');
  assert.equal(joinFrom(undefined, undefined), 'invite');
});

test('the join path keeps the ref, and Come in errors map to a door notice', () => {
  const token = 'a'.repeat(48);
  assert.equal(joinPath(token, null), `/join/${token}`);
  assert.equal(joinPath(token, 'callin'), `/join/${token}?ref=callin`);
  assert.equal(doorNoticeFor('Invite is invalid or expired.'), 'changed');
  assert.equal(doorNoticeFor('Invalid invite token.'), 'changed');
  assert.equal(doorNoticeFor('Room is unavailable.'), 'closed');
  assert.equal(doorNoticeFor('fetch failed'), 'retry');
  assert.equal(parseDoorNotice('closed'), 'closed');
  assert.equal(parseDoorNotice('anything'), null);
  assert.equal(parseDoorNotice(undefined), null);
});
