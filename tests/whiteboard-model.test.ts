import assert from 'node:assert/strict';
import test from 'node:test';
import { toRoomBroadcastPayload } from '../src/lib/room-broadcast-contract.js';
import {
  LEGACY_IMAGE_KEY,
  applyWhiteboardOps,
  parseWhiteboardState,
  serializeWhiteboard,
  simplifyStrokePoints,
  translateElement,
  wrapText,
  type WhiteboardElement,
  type WhiteboardOps,
} from '../src/lib/whiteboard-model.js';

const rect = (id: string, x = 0): WhiteboardElement => ({ id, kind: 'rect', x, y: 0, w: 10, h: 10, color: '#818cf8', width: 2 });

test('whiteboard Broadcast carries only a positive version', () => {
  assert.deepEqual(
    toRoomBroadcastPayload('whiteboard_changed', { version: 7, elements: [rect('a')], text: 'secret', url: 'https://x.test' }),
    { version: 7 },
  );
  assert.equal(toRoomBroadcastPayload('whiteboard_changed', { version: 0 }), null);
  assert.equal(toRoomBroadcastPayload('whiteboard_changed', { version: 1.5 }), null);
  assert.equal(toRoomBroadcastPayload('whiteboard_changed', {}), null);
});

test('board state is sanitized: malformed, duplicate and hostile elements are dropped', () => {
  const doc = parseWhiteboardState({
    elements: [
      rect('ok'),
      rect('ok'),
      { ...rect('bad-color'), color: 'red;background:url(x)' },
      { id: 'no-kind', color: '#ffffff', width: 2 },
      { id: 'xss', kind: 'text', x: 0, y: 0, size: 20, text: '<img src=x onerror=alert(1)>', color: '#ffffff', width: 1 },
      { id: 'huge', kind: 'rect', x: 1e12, y: 0, w: 1, h: 1, color: '#ffffff', width: 1 },
      { id: 'odd-points', kind: 'stroke', points: [1, 2, 3], color: '#ffffff', width: 2 },
    ],
    legacyImage: 'javascript:alert(1)',
  });
  assert.deepEqual(doc.elements.map((element) => element.id), ['ok', 'xss']);
  // Text survives as plain text; React renders it as a text node, never HTML.
  assert.equal(doc.elements[1].kind === 'text' && doc.elements[1].text, '<img src=x onerror=alert(1)>');
  assert.equal(doc.legacyImage, null);
});

test('the first raster whiteboard format is kept as a background', () => {
  const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal(parseWhiteboardState({ dataUrl }).legacyImage, dataUrl);
  assert.deepEqual(serializeWhiteboard(parseWhiteboardState({ dataUrl })), { v: 2, elements: [], legacyImage: dataUrl });
});

test('local operations merge onto a newer remote board instead of overwriting it', () => {
  const remote = { elements: [rect('theirs'), rect('shared'), rect('deleted-by-me')], legacyImage: 'data:image/png;base64,AA==' };
  const ops: WhiteboardOps = new Map<string, WhiteboardElement | null>([
    ['mine', rect('mine', 50)],
    ['shared', rect('shared', 99)],
    ['deleted-by-me', null],
    [LEGACY_IMAGE_KEY, null],
  ]);
  const merged = applyWhiteboardOps(remote, ops);
  assert.deepEqual(merged.elements.map((element) => element.id), ['theirs', 'shared', 'mine']);
  assert.equal(merged.elements[1].kind === 'rect' && merged.elements[1].x, 99);
  assert.equal(merged.legacyImage, null);
  assert.equal(applyWhiteboardOps(remote, new Map()), remote);
});

test('strokes are simplified and rounded, keeping both end points', () => {
  const points = [0, 0, 0.1, 0.1, 0.2, 0.2, 5.55, 5.55, 5.6, 5.6, 10.04, 10.04];
  const simplified = simplifyStrokePoints(points, 1.2);
  assert.deepEqual(simplified, [0, 0, 5.6, 5.6, 10, 10]);
  assert.deepEqual(translateElement({ id: 's', kind: 'stroke', points: [1, 2, 3, 4], color: '#ffffff', width: 2 }, 10, -1), { id: 's', kind: 'stroke', points: [11, 1, 13, 3], color: '#ffffff', width: 2 });
});

test('note text wraps to the note width and splits very long words', () => {
  const lines = wrapText('hello whiteboard world\nsecond', 60, 10);
  assert.ok(lines.every((line) => line.length <= Math.floor(60 / (10 * 0.56))));
  assert.equal(lines[lines.length - 1], 'second');
  assert.deepEqual(wrapText('abcdefghijklmnop', 40, 10), ['abcdefg', 'hijklmn', 'op']);
});
