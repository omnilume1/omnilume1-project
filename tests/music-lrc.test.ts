import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLyrics, toLrc } from '../src/lib/music-lrc.js';

test('parses LRC stamps, fractions and sorts lines', () => {
  const { synced, lines } = parseLyrics('[ar:Someone]\n[00:12.50]Second\n[00:01]First\n[01:02.005]Third');
  assert.equal(synced, true);
  assert.deepEqual(lines, [
    { ms: 1000, text: 'First' },
    { ms: 12500, text: 'Second' },
    { ms: 62005, text: 'Third' },
  ]);
});

test('a line with several stamps repeats; offset shifts every stamp; unstamped lines are dropped', () => {
  const { lines } = parseLyrics('[offset:+500]\n[00:10.00][00:40.00]Chorus\nplain words\n[00:20.00]Verse');
  assert.deepEqual(lines.map((line) => [line.ms, line.text]), [[9500, 'Chorus'], [19500, 'Verse'], [39500, 'Chorus']]);
});

test('plain text is unsynced; malformed or empty input never throws', () => {
  assert.deepEqual(parseLyrics('One\r\n\r\nTwo'), { synced: false, lines: [{ ms: 0, text: 'One' }, { ms: 0, text: 'Two' }] });
  assert.deepEqual(parseLyrics(null), { synced: false, lines: [] });
  assert.deepEqual(parseLyrics('[xx:yy]broken\n[ti:Only tags]').lines, [{ ms: 0, text: '[xx:yy]broken' }]);
  assert.ok(parseLyrics('[00:01.00]x\n'.repeat(5000)).lines.length <= 2000, 'line count is capped');
});

test('embedded synced lyrics round-trip through LRC', () => {
  const lrc = toLrc([{ text: 'Hello ', timestamp: 1234 }, { text: 'skip me' }, { text: 'World', timestamp: 61_000 }]);
  assert.equal(lrc, '[00:01.23]Hello\n[01:01.00]World');
  assert.deepEqual(parseLyrics(lrc).lines, [{ ms: 1230, text: 'Hello' }, { ms: 61000, text: 'World' }]);
});
