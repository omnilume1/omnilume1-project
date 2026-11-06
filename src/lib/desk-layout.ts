// Pure window math for movable, resizable desks (the room desk and the
// landing demo). No imports, no DOM: every function takes and returns plain
// numbers so it can be unit tested.

export type Point = { x: number; y: number };
export type Size = { w: number; h: number };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

// Keep a window of `size` fully inside `area`, `margin` px from every edge.
// A window larger than the area pins to the top-left margin.
export function clampPoint(point: Point, size: Size, area: Size, margin = 0): Point {
  return {
    x: Math.round(clamp(point.x, margin, Math.max(margin, area.w - size.w - margin))),
    y: Math.round(clamp(point.y, margin, Math.max(margin, area.h - size.h - margin))),
  };
}
