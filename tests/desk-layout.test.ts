import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DESK_GAP,
  DESK_PAD,
  arrangeBoxes,
  clampBox,
  clampPoint,
  findDividers,
  fromFractions,
  moveDivider,
  resizeBox,
  snapBox,
  tileBoxes,
  toFractions,
  type Box,
} from '../src/lib/desk-layout.js';

const AREA = { w: 1296, h: 720 };
const LIMITS = { minW: 280, minH: 200 };

test('clampPoint keeps a window inside the area and pins oversized ones', () => {
  assert.deepEqual(clampPoint({ x: -50, y: 900 }, { w: 300, h: 280 }, { w: 1200, h: 680 }, 8), { x: 8, y: 392 });
  assert.deepEqual(clampPoint({ x: 2000, y: 10 }, { w: 300, h: 280 }, { w: 1200, h: 680 }, 8), { x: 892, y: 10 });
  assert.deepEqual(clampPoint({ x: 50, y: 50 }, { w: 1500, h: 900 }, { w: 1200, h: 680 }, 8), { x: 8, y: 8 });
});

test('clampBox limits size to the minimum and to what fits, then position', () => {
  assert.deepEqual(clampBox({ x: 10, y: 10, w: 100, h: 50 }, AREA, LIMITS), { x: 16, y: 16, w: 280, h: 200 });
  assert.deepEqual(clampBox({ x: 0, y: 0, w: 5000, h: 5000 }, AREA, LIMITS), { x: 16, y: 16, w: 1264, h: 688 });
  assert.deepEqual(clampBox({ x: 1200, y: 600, w: 400, h: 300 }, AREA, LIMITS), { x: 880, y: 404, w: 400, h: 300 });
  // A desk smaller than the minimum still yields a window that fits.
  assert.deepEqual(clampBox({ x: 0, y: 0, w: 400, h: 400 }, { w: 300, h: 220 }, LIMITS), { x: 16, y: 16, w: 268, h: 188 });
});

test('resizeBox moves only the dragged edges and respects min size and the desk', () => {
  const start: Box = { x: 100, y: 100, w: 400, h: 300 };
  assert.deepEqual(resizeBox(start, 'se', 60, 40, AREA, LIMITS), { x: 100, y: 100, w: 460, h: 340 });
  assert.deepEqual(resizeBox(start, 'se', -500, -500, AREA, LIMITS), { x: 100, y: 100, w: 280, h: 200 });
  assert.deepEqual(resizeBox(start, 'e', 5000, 0, AREA, LIMITS), { x: 100, y: 100, w: 1180, h: 300 });
  // The left edge moves while the right edge stays at 500.
  assert.deepEqual(resizeBox(start, 'w', -40, 0, AREA, LIMITS), { x: 60, y: 100, w: 440, h: 300 });
  assert.deepEqual(resizeBox(start, 'w', 300, 0, AREA, LIMITS), { x: 220, y: 100, w: 280, h: 300 });
  assert.deepEqual(resizeBox(start, 'nw', -500, -500, AREA, LIMITS), { x: 16, y: 16, w: 484, h: 384 });
});

test('snapBox pulls edges onto the desk edge and next to other windows', () => {
  const other: Box = { x: 16, y: 16, w: 620, h: 340 };
  // Left edge 8px from the desk inset snaps flush to it.
  assert.equal(snapBox({ x: 24, y: 400, w: 300, h: 200 }, [], AREA).x, DESK_PAD);
  // Right edge near the desk's right inset snaps so it ends exactly there.
  assert.equal(snapBox({ x: 990, y: 400, w: 300, h: 200 }, [], AREA).x, AREA.w - DESK_PAD - 300);
  // Next to another window: one gap from its right edge.
  assert.equal(snapBox({ x: 655, y: 16, w: 300, h: 200 }, [other], AREA).x, 636 + DESK_GAP);
  // Far from everything: unchanged.
  assert.deepEqual(snapBox({ x: 400, y: 420, w: 300, h: 200 }, [other], AREA), { x: 400, y: 420, w: 300, h: 200 });
});

test('tileBoxes puts side tools in a right column and stage windows in two columns', () => {
  const boxes = tileBoxes(['watch', 'whiteboard', 'study', 'home', 'chat'], AREA, 0.25);
  const inner = AREA.w - DESK_PAD * 2;
  // Every window stays inside the desk inset and nothing overlaps.
  const list = Object.values(boxes);
  for (const b of list) {
    assert.ok(b.x >= DESK_PAD && b.y >= DESK_PAD && b.x + b.w <= AREA.w - DESK_PAD + 1 && b.y + b.h <= AREA.h - DESK_PAD + 1, JSON.stringify(b));
  }
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i]; const b = list[j];
    assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, 'no overlap');
  }
  assert.equal(boxes.chat.h, AREA.h - DESK_PAD * 2);
  assert.equal(boxes.chat.x + boxes.chat.w, DESK_PAD + inner);
  assert.equal(boxes.watch.x, DESK_PAD);
  assert.equal(boxes.whiteboard.x, DESK_PAD, 'first column stacks watch and whiteboard');
  assert.ok(boxes.watch.w > boxes.study.w, 'first column is wider');
  assert.deepEqual(tileBoxes(['chat'], AREA), { chat: { x: 16, y: 16, w: 1264, h: 688 } });
  assert.deepEqual(tileBoxes([], AREA), {});
});

test('arrangeBoxes follows the layout presets', () => {
  const balanced = arrangeBoxes('balanced', ['home', 'chat'], AREA);
  assert.ok(balanced.chat.w > balanced.home.w, 'room home gives chat the larger share');
  const chatFocus = arrangeBoxes('chat', ['watch', 'chat'], AREA);
  assert.ok(Math.abs(chatFocus.chat.w - chatFocus.watch.w) <= 1);
  const stage = arrangeBoxes('stage', ['watch', 'chat'], AREA);
  assert.deepEqual(stage.watch, { x: 16, y: 16, w: 1264, h: 688 });
  assert.equal(stage.chat.w, 380);
  assert.equal(stage.chat.x + stage.chat.w, AREA.w - DESK_PAD);
});

test('dividers appear where tiles meet and resize both sides within limits', () => {
  const boxes = tileBoxes(['watch', 'whiteboard', 'study', 'home', 'chat'], AREA, 0.25);
  const dividers = findDividers(boxes);
  const columns = dividers.filter((d) => d.axis === 'x').sort((a, b) => a.at - b.at);
  assert.equal(columns.length, 2);
  assert.deepEqual(columns[0].before.sort(), ['watch', 'whiteboard']);
  assert.deepEqual(columns[0].after.sort(), ['home', 'study']);
  assert.ok(dividers.some((d) => d.axis === 'y' && d.before.includes('watch') && d.after.includes('whiteboard')));

  const moved = moveDivider(boxes, columns[0], -100, LIMITS);
  assert.equal(moved.watch.w, boxes.watch.w - 100);
  assert.equal(moved.study.x, boxes.study.x - 100);
  assert.equal(moved.study.w, boxes.study.w + 100);
  assert.equal(moved.study.x + moved.study.w, boxes.study.x + boxes.study.w, 'far edge stays');
  // Never shrinks a side below its minimum.
  const squeezed = moveDivider(boxes, columns[0], 5000, LIMITS);
  assert.equal(squeezed.study.w, LIMITS.minW);
  assert.equal(findDividers({ a: { x: 0, y: 0, w: 100, h: 100 }, b: { x: 400, y: 0, w: 100, h: 100 } }).length, 0);
});

test('layouts persist as fractions and bad stored values are rejected', () => {
  const box = { x: 648, y: 16, w: 300, h: 270 };
  const stored = toFractions(box, AREA);
  assert.deepEqual(fromFractions(stored, AREA, LIMITS), box);
  const bigger = fromFractions(stored, { w: 2592, h: 1440 }, LIMITS);
  assert.deepEqual(bigger, { x: 1296, y: 32, w: 600, h: 540 });
  for (const bad of [null, 'x', [1, 2, 3], [0.1, 0.1, 2, 0.5], [0.1, Number.NaN, 0.2, 0.2], ['0', 0, 0, 0]]) assert.equal(fromFractions(bad, AREA, LIMITS), null);
});
