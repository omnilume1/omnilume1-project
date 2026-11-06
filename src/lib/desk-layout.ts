// Pure window math for movable, resizable desks (the room desk and the
// landing demo). No imports, no DOM: every function takes and returns plain
// numbers so it can be unit tested.

export type Point = { x: number; y: number };
export type Size = { w: number; h: number };
export type Box = { x: number; y: number; w: number; h: number };
export type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export type Limits = { minW: number; minH: number };
export type Divider = { axis: 'x' | 'y'; at: number; before: string[]; after: string[]; from: number; to: number };

export const DESK_PAD = 16; // inset from the desk edge (concept: 16px)
export const DESK_GAP = 12; // space between tiled windows (concept: 12px)
export const SNAP_DISTANCE = 12;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

// Keep a window of `size` fully inside `area`, `margin` px from every edge.
// A window larger than the area pins to the top-left margin.
export function clampPoint(point: Point, size: Size, area: Size, margin = 0): Point {
  return {
    x: Math.round(clamp(point.x, margin, Math.max(margin, area.w - size.w - margin))),
    y: Math.round(clamp(point.y, margin, Math.max(margin, area.h - size.h - margin))),
  };
}

// Size first (between the limits and what fits), then position.
export function clampBox(box: Box, area: Size, limits: Limits, margin = DESK_PAD): Box {
  // What fits wins over the minimum, so a tiny desk never pushes a window off it.
  const maxW = Math.max(1, area.w - margin * 2);
  const maxH = Math.max(1, area.h - margin * 2);
  const w = Math.round(clamp(box.w, Math.min(limits.minW, maxW), maxW));
  const h = Math.round(clamp(box.h, Math.min(limits.minH, maxH), maxH));
  return { ...clampPoint(box, { w, h }, area, margin), w, h };
}

// Drag one edge or corner by (dx, dy); the opposite edge stays put.
export function resizeBox(start: Box, edge: Edge, dx: number, dy: number, area: Size, limits: Limits, margin = DESK_PAD): Box {
  let { x, y, w, h } = start;
  const right = start.x + start.w;
  const bottom = start.y + start.h;
  if (edge.includes('e')) w = clamp(start.w + dx, limits.minW, area.w - margin - start.x);
  if (edge.includes('s')) h = clamp(start.h + dy, limits.minH, area.h - margin - start.y);
  if (edge.includes('w')) { x = clamp(start.x + dx, margin, right - limits.minW); w = right - x; }
  if (edge.includes('n')) { y = clamp(start.y + dy, margin, bottom - limits.minH); h = bottom - y; }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

// While moving, pull the window's edges onto the desk edges and onto the
// edges of other windows (flush or one gap apart) when they come close.
export function snapBox(box: Box, others: Box[], area: Size, distance = SNAP_DISTANCE, margin = DESK_PAD, gap = DESK_GAP): Box {
  const xs = [margin, area.w - margin];
  const ys = [margin, area.h - margin];
  for (const other of others) {
    xs.push(other.x, other.x + other.w, other.x - gap, other.x + other.w + gap);
    ys.push(other.y, other.y + other.h, other.y - gap, other.y + other.h + gap);
  }
  const nearest = (start: number, size: number, lines: number[]) => {
    let best = start;
    let bestDistance = distance + 1;
    for (const line of lines) {
      for (const candidate of [line, line - size]) {
        const d = Math.abs(candidate - start);
        if (d < bestDistance) { best = candidate; bestDistance = d; }
      }
    }
    return best;
  };
  return { ...box, x: nearest(box.x, box.w, xs), y: nearest(box.y, box.h, ys) };
}

const SIDE_IDS = new Set(['chat', 'members', 'voice', 'collab', 'files']);
export const isSideWindow = (id: string) => SIDE_IDS.has(id);

// Stack `ids` top to bottom in one column.
function stack(ids: string[], x: number, y: number, w: number, h: number, gap: number, out: Record<string, Box>) {
  const each = (h - gap * (ids.length - 1)) / ids.length;
  ids.forEach((id, i) => { out[id] = { x: Math.round(x), y: Math.round(y + i * (each + gap)), w: Math.round(w), h: Math.round(each) }; });
}

// Tile every open window (concept "Tile all windows"): side tools (chat,
// members…) share a full-height column on the right; stage windows fill the
// rest in up to two columns, the first one wider.
export function tileBoxes(ids: string[], area: Size, sideShare = 0.3, margin = DESK_PAD, gap = DESK_GAP): Record<string, Box> {
  const out: Record<string, Box> = {};
  if (!ids.length) return out;
  const side = ids.filter(isSideWindow);
  const stage = ids.filter((id) => !isSideWindow(id));
  const innerW = area.w - margin * 2;
  const innerH = area.h - margin * 2;
  if (!stage.length || !side.length) {
    const group = stage.length ? stage : side;
    if (stage.length) tileStage(group, margin, margin, innerW, innerH, gap, out);
    else group.forEach((id, i) => { const each = (innerW - gap * (group.length - 1)) / group.length; out[id] = { x: Math.round(margin + i * (each + gap)), y: margin, w: Math.round(each), h: innerH }; });
    return out;
  }
  const sideW = Math.round((innerW - gap) * sideShare);
  const stageW = innerW - gap - sideW;
  tileStage(stage, margin, margin, stageW, innerH, gap, out);
  stack(side, margin + stageW + gap, margin, sideW, innerH, gap, out);
  return out;
}

function tileStage(ids: string[], x: number, y: number, w: number, h: number, gap: number, out: Record<string, Box>) {
  if (ids.length === 1) { stack(ids, x, y, w, h, gap, out); return; }
  const first = ids.slice(0, Math.ceil(ids.length / 2));
  const second = ids.slice(first.length);
  const firstW = Math.round((w - gap) * 0.6);
  stack(first, x, y, firstW, h, gap, out);
  stack(second, x + firstW + gap, y, w - gap - firstW, h, gap, out);
}

// Starting arrangement for a room layout preset.
// balanced: tiled, side tools take ~30% (60% when room home is the only stage).
// chat: side tools take half. stage: stage windows fill the desk; side tools
// float on the right above them.
export function arrangeBoxes(preset: 'balanced' | 'stage' | 'chat', ids: string[], area: Size, margin = DESK_PAD, gap = DESK_GAP): Record<string, Box> {
  const stage = ids.filter((id) => !isSideWindow(id));
  if (preset === 'stage') {
    const out = tileBoxes(stage, area, 0, margin, gap);
    ids.filter(isSideWindow).forEach((id, i) => {
      const w = Math.min(380, area.w - margin * 2);
      const h = Math.min(560, area.h - margin * 2);
      out[id] = clampBox({ x: area.w - margin - w - i * 28, y: margin + i * 28, w, h }, area, { minW: 1, minH: 1 }, margin);
    });
    return out;
  }
  const share = preset === 'chat' ? 0.5 : stage.length === 1 && stage[0] === 'home' ? 0.6 : 0.3;
  return tileBoxes(ids, area, share, margin, gap);
}

// Where two tiles meet (one gap apart, overlapping along the edge), there is
// a divider that resizes both sides at once.
export function findDividers(boxes: Record<string, Box>, gap = DESK_GAP, tolerance = 2): Divider[] {
  const entries = Object.entries(boxes);
  const out: Divider[] = [];
  for (const axis of ['x', 'y'] as const) {
    const start = (b: Box) => (axis === 'x' ? b.x : b.y);
    const end = (b: Box) => (axis === 'x' ? b.x + b.w : b.y + b.h);
    const spanStart = (b: Box) => (axis === 'x' ? b.y : b.x);
    const spanEnd = (b: Box) => (axis === 'x' ? b.y + b.h : b.x + b.w);
    const lines = new Map<number, Divider>();
    for (const [aId, a] of entries) {
      for (const [bId, b] of entries) {
        if (aId === bId || Math.abs(start(b) - (end(a) + gap)) > tolerance) continue;
        if (Math.min(spanEnd(a), spanEnd(b)) - Math.max(spanStart(a), spanStart(b)) <= 0) continue;
        const at = Math.round(end(a));
        const line = [...lines.values()].find((d) => Math.abs(d.at - at) <= tolerance) ?? { axis, at, before: [], after: [], from: Infinity, to: -Infinity };
        lines.set(line.at, line);
        if (!line.before.includes(aId)) line.before.push(aId);
        if (!line.after.includes(bId)) line.after.push(bId);
        line.from = Math.min(line.from, spanStart(a), spanStart(b));
        line.to = Math.max(line.to, spanEnd(a), spanEnd(b));
      }
    }
    out.push(...lines.values());
  }
  return out;
}

// Move a divider by `delta`: windows before it grow, windows after it shrink
// (or the reverse), never below their minimum size.
export function moveDivider(boxes: Record<string, Box>, divider: Divider, delta: number, limits: Limits): Record<string, Box> {
  const key = divider.axis === 'x' ? 'w' : 'h';
  const pos = divider.axis === 'x' ? 'x' : 'y';
  const min = divider.axis === 'x' ? limits.minW : limits.minH;
  let low = -Infinity;
  let high = Infinity;
  for (const id of divider.before) if (boxes[id]) low = Math.max(low, min - boxes[id][key]);
  for (const id of divider.after) if (boxes[id]) high = Math.min(high, boxes[id][key] - min);
  const d = Math.round(clamp(delta, Math.min(0, low), Math.max(0, high)));
  const out = { ...boxes };
  for (const id of divider.before) if (out[id]) out[id] = { ...out[id], [key]: out[id][key] + d };
  for (const id of divider.after) if (out[id]) out[id] = { ...out[id], [pos]: out[id][pos] + d, [key]: out[id][key] - d };
  return out;
}

// Boxes are stored as fractions of the desk so a layout survives a resize.
export function toFractions(box: Box, area: Size): [number, number, number, number] {
  const r = (v: number) => Math.round(v * 10000) / 10000;
  return [r(box.x / area.w), r(box.y / area.h), r(box.w / area.w), r(box.h / area.h)];
}

export function fromFractions(value: unknown, area: Size, limits: Limits, margin = DESK_PAD): Box | null {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)) return null;
  const [fx, fy, fw, fh] = value as number[];
  return clampBox({ x: fx * area.w, y: fy * area.h, w: fw * area.w, h: fh * area.h }, area, limits, margin);
}
