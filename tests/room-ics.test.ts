import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRoomIcs } from '../src/lib/room-ics.js';

const now = new Date('2026-11-11T08:00:00Z');
const lines = (ics: string) => ics.split('\r\n');

test('room ics converts an IST opening time to UTC and ends one hour later', () => {
  const ics = buildRoomIcs({ title: 'Study', start: new Date('2026-11-12T15:00:00+05:30'), url: 'https://omnilume.com/room/abc', now });
  assert.ok(lines(ics).includes('DTSTART:20261112T093000Z'));
  assert.ok(lines(ics).includes('DTEND:20261112T103000Z'));
  assert.ok(lines(ics).includes('DTSTAMP:20261111T080000Z'));
});

test('room ics uses CRLF line endings and the required calendar frame', () => {
  const ics = buildRoomIcs({ title: 'Study', start: new Date('2026-11-12T09:30:00Z'), url: 'https://omnilume.com/room/abc', now });
  assert.equal(ics.replace(/\r\n/g, '').includes('\n'), false);
  assert.equal(ics.endsWith('END:VCALENDAR\r\n'), true);
  const rows = lines(ics);
  assert.equal(rows[0], 'BEGIN:VCALENDAR');
  assert.ok(rows.includes('BEGIN:VEVENT') && rows.includes('END:VEVENT'));
  assert.ok(rows.some((row) => row.startsWith('UID:')));
  assert.ok(rows.includes('URL:https://omnilume.com/room/abc'));
});

test('room ics escapes backslash, semicolon, comma and newlines in text', () => {
  const ics = buildRoomIcs({ title: 'a\\b;c,d\ne\r\nf', start: new Date('2026-11-12T09:30:00Z'), url: 'https://omnilume.com/room/abc', now });
  assert.ok(lines(ics).includes('SUMMARY:a\\\\b\\;c\\,d\\ne\\nf'));
});
