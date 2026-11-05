// Shared whiteboard document model (Action 10, owner decision 2026-11-05).
//
// The board is a list of vector elements stored in public.room_whiteboards
// (state jsonb, 512 KiB cap, optimistic version). Each client keeps a map of
// its own unsaved element operations, so a save that loses a version race is
// merged onto the latest board and retried instead of being discarded.
//
// No imports: unit tests load this module directly.

export type WhiteboardTool =
  | 'select'
  | 'hand'
  | 'pen'
  | 'highlighter'
  | 'eraser'
  | 'line'
  | 'arrow'
  | 'rect'
  | 'ellipse'
  | 'text'
  | 'note';

type ElementBase = { id: string; color: string; width: number };

export type StrokeElement = ElementBase & { kind: 'stroke'; points: number[]; highlighter?: boolean };
export type SegmentElement = ElementBase & { kind: 'line' | 'arrow'; x1: number; y1: number; x2: number; y2: number };
export type BoxElement = ElementBase & { kind: 'rect' | 'ellipse'; x: number; y: number; w: number; h: number; fill?: boolean };
export type TextElement = ElementBase & { kind: 'text'; x: number; y: number; text: string; size: number };
export type NoteElement = ElementBase & { kind: 'note'; x: number; y: number; w: number; h: number; text: string; size: number };

export type WhiteboardElement = StrokeElement | SegmentElement | BoxElement | TextElement | NoteElement;

export type WhiteboardDocument = {
  elements: WhiteboardElement[];
  // Raster drawing from the first whiteboard version ({ dataUrl }). Kept as
  // a background until someone clears the board.
  legacyImage: string | null;
};

// An unsaved local change: an element value, or null for a deletion. The key
// LEGACY_IMAGE_KEY with null clears the legacy raster background.
export type WhiteboardOps = Map<string, WhiteboardElement | null>;

export const LEGACY_IMAGE_KEY = '__legacy_image__';
export const WHITEBOARD_STATE_MAX_BYTES = 512 * 1024;
// Leave headroom under the database cap for JSON escaping differences.
export const WHITEBOARD_SAVE_BUDGET_BYTES = 480 * 1024;
export const WHITEBOARD_MAX_ELEMENTS = 4000;
export const WHITEBOARD_TEXT_MAX_CHARS = 2000;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const COORDINATE_LIMIT = 1_000_000;

const isCoordinate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= COORDINATE_LIMIT;
const isSize = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max;

// Keeps only well-formed elements, so a malformed or hostile board row can
// never crash rendering or inject markup (all text is rendered as text).
export function sanitizeWhiteboardElement(value: unknown): WhiteboardElement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const el = value as Record<string, unknown>;
  if (typeof el.id !== 'string' || !ID_PATTERN.test(el.id)) return null;
  if (typeof el.color !== 'string' || !COLOR_PATTERN.test(el.color)) return null;
  if (!isSize(el.width, 200)) return null;
  const base = { id: el.id, color: el.color, width: el.width };

  switch (el.kind) {
    case 'stroke': {
      if (!Array.isArray(el.points) || el.points.length < 2 || el.points.length > 20_000 || el.points.length % 2 !== 0) return null;
      if (!el.points.every(isCoordinate)) return null;
      return { ...base, kind: 'stroke', points: el.points as number[], ...(el.highlighter === true ? { highlighter: true } : {}) };
    }
    case 'line':
    case 'arrow':
      if (![el.x1, el.y1, el.x2, el.y2].every(isCoordinate)) return null;
      return { ...base, kind: el.kind, x1: el.x1 as number, y1: el.y1 as number, x2: el.x2 as number, y2: el.y2 as number };
    case 'rect':
    case 'ellipse':
      if (!isCoordinate(el.x) || !isCoordinate(el.y) || !isSize(el.w, COORDINATE_LIMIT) || !isSize(el.h, COORDINATE_LIMIT)) return null;
      return { ...base, kind: el.kind, x: el.x, y: el.y, w: el.w, h: el.h, ...(el.fill === true ? { fill: true } : {}) };
    case 'text':
      if (!isCoordinate(el.x) || !isCoordinate(el.y) || !isSize(el.size, 400)) return null;
      if (typeof el.text !== 'string' || el.text.length === 0 || el.text.length > WHITEBOARD_TEXT_MAX_CHARS) return null;
      return { ...base, kind: 'text', x: el.x, y: el.y, text: el.text, size: el.size };
    case 'note':
      if (!isCoordinate(el.x) || !isCoordinate(el.y) || !isSize(el.w, COORDINATE_LIMIT) || !isSize(el.h, COORDINATE_LIMIT) || !isSize(el.size, 400)) return null;
      if (typeof el.text !== 'string' || el.text.length > WHITEBOARD_TEXT_MAX_CHARS) return null;
      return { ...base, kind: 'note', x: el.x, y: el.y, w: el.w, h: el.h, text: el.text, size: el.size };
    default:
      return null;
  }
}

export function parseWhiteboardState(state: unknown): WhiteboardDocument {
  const record = state && typeof state === 'object' && !Array.isArray(state) ? state as Record<string, unknown> : {};
  const seen = new Set<string>();
  const elements: WhiteboardElement[] = [];
  if (Array.isArray(record.elements)) {
    for (const candidate of record.elements.slice(0, WHITEBOARD_MAX_ELEMENTS)) {
      const element = sanitizeWhiteboardElement(candidate);
      if (element && !seen.has(element.id)) {
        seen.add(element.id);
        elements.push(element);
      }
    }
  }
  const legacy = typeof record.legacyImage === 'string' ? record.legacyImage : record.dataUrl;
  const legacyImage = typeof legacy === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(legacy) ? legacy : null;
  return { elements, legacyImage };
}

export function serializeWhiteboard(doc: WhiteboardDocument) {
  return { v: 2, elements: doc.elements, legacyImage: doc.legacyImage };
}

export function whiteboardStateBytes(doc: WhiteboardDocument) {
  return new TextEncoder().encode(JSON.stringify(serializeWhiteboard(doc))).length;
}

// Applies local unsaved operations on top of a (newer) remote board. Updated
// elements keep their remote stacking position; new ones go on top.
export function applyWhiteboardOps(base: WhiteboardDocument, ops: WhiteboardOps): WhiteboardDocument {
  if (ops.size === 0) return base;
  const elements = base.elements
    .filter((element) => !ops.has(element.id) || ops.get(element.id) !== null)
    .map((element) => (ops.has(element.id) ? ops.get(element.id) as WhiteboardElement : element));
  const present = new Set(elements.map((element) => element.id));
  for (const [id, value] of ops) {
    if (id === LEGACY_IMAGE_KEY || value === null || present.has(id)) continue;
    elements.push(value);
  }
  const legacyImage = ops.has(LEGACY_IMAGE_KEY) ? null : base.legacyImage;
  return { elements, legacyImage };
}

// Drops points closer than `minDistance` to the previous kept point and
// rounds to 0.1 units, which keeps long strokes well inside the save budget.
export function simplifyStrokePoints(points: number[], minDistance: number) {
  if (points.length <= 4) return points.map((value) => Math.round(value * 10) / 10);
  const kept: number[] = [points[0], points[1]];
  for (let index = 2; index < points.length - 2; index += 2) {
    const dx = points[index] - kept[kept.length - 2];
    const dy = points[index + 1] - kept[kept.length - 1];
    if (dx * dx + dy * dy >= minDistance * minDistance) kept.push(points[index], points[index + 1]);
  }
  kept.push(points[points.length - 2], points[points.length - 1]);
  return kept.map((value) => Math.round(value * 10) / 10);
}

// Smooth SVG path through the stroke points (quadratic curves via midpoints).
export function strokePath(points: number[]) {
  if (points.length < 2) return '';
  if (points.length <= 4) {
    const [x1, y1] = points;
    const x2 = points[2] ?? x1 + 0.01;
    const y2 = points[3] ?? y1;
    return `M${x1} ${y1}L${x2} ${y2}`;
  }
  let path = `M${points[0]} ${points[1]}`;
  for (let index = 2; index < points.length - 2; index += 2) {
    const midX = (points[index] + points[index + 2]) / 2;
    const midY = (points[index + 1] + points[index + 3]) / 2;
    path += `Q${points[index]} ${points[index + 1]} ${midX} ${midY}`;
  }
  path += `L${points[points.length - 2]} ${points[points.length - 1]}`;
  return path;
}

export type Bounds = { x: number; y: number; w: number; h: number };

export function elementBounds(element: WhiteboardElement): Bounds {
  switch (element.kind) {
    case 'stroke': {
      let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
      for (let index = 0; index < element.points.length; index += 2) {
        minX = Math.min(minX, element.points[index]); maxX = Math.max(maxX, element.points[index]);
        minY = Math.min(minY, element.points[index + 1]); maxY = Math.max(maxY, element.points[index + 1]);
      }
      const pad = element.width / 2;
      return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
    }
    case 'line':
    case 'arrow':
      return {
        x: Math.min(element.x1, element.x2) - element.width,
        y: Math.min(element.y1, element.y2) - element.width,
        w: Math.abs(element.x2 - element.x1) + element.width * 2,
        h: Math.abs(element.y2 - element.y1) + element.width * 2,
      };
    case 'text': {
      const lines = element.text.split('\n');
      const longest = Math.max(...lines.map((line) => line.length), 1);
      return { x: element.x, y: element.y, w: longest * element.size * 0.6, h: lines.length * element.size * 1.25 };
    }
    default:
      return { x: element.x, y: element.y, w: element.w, h: element.h };
  }
}

export function translateElement(element: WhiteboardElement, dx: number, dy: number): WhiteboardElement {
  const round = (value: number) => Math.round(value * 10) / 10;
  switch (element.kind) {
    case 'stroke':
      return { ...element, points: element.points.map((value, index) => round(value + (index % 2 === 0 ? dx : dy))) };
    case 'line':
    case 'arrow':
      return { ...element, x1: round(element.x1 + dx), y1: round(element.y1 + dy), x2: round(element.x2 + dx), y2: round(element.y2 + dy) };
    default:
      return { ...element, x: round(element.x + dx), y: round(element.y + dy) };
  }
}

// Wraps note text to the note width using an average glyph width. SVG has no
// native wrapping, and foreignObject would block PNG export in some browsers.
export function wrapText(text: string, width: number, size: number) {
  const maxChars = Math.max(4, Math.floor(width / (size * 0.56)));
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (!word) continue;
      let remaining = word;
      while (remaining.length > maxChars) {
        if (line) { lines.push(line); line = ''; }
        lines.push(remaining.slice(0, maxChars));
        remaining = remaining.slice(maxChars);
      }
      if (!line) line = remaining;
      else if (line.length + 1 + remaining.length <= maxChars) line += ` ${remaining}`;
      else { lines.push(line); line = remaining; }
    }
    lines.push(line);
  }
  return lines;
}
