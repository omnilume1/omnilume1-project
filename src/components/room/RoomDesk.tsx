'use client';

import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type Ref } from 'react';
import { OmniIcon, type OmniIconName } from '@/components/ui/OmniIcon';
import {
  DESK_PAD,
  arrangeBoxes,
  clampBox,
  findDividers,
  fromFractions,
  moveDivider,
  resizeBox,
  snapBox,
  tileBoxes,
  toFractions,
  type Box,
  type Divider,
  type Edge,
  type Size,
} from '@/lib/desk-layout';
import type { RoomLayout } from '@/lib/room-layout';

export type DeskWindow = {
  id: string;
  title: string;
  icon: OmniIconName;
  open: boolean;
  // Stays in the DOM while closed (media keeps playing, the timer keeps running).
  keepMounted?: boolean;
  extra?: ReactNode;
  children: ReactNode;
};

// Called from the room header and rail event handlers.
export type DeskHandle = { tile: () => void; reset: () => void; focus: () => void; raise: (id: string) => void };

const LIMITS = { minW: 280, minH: 200 };
const EDGES: Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const STACKED = '(max-width: 767px)';

type Gesture =
  | { kind: 'move' | 'resize'; id: string; edge?: Edge; pointer: number; sx: number; sy: number; start: Box; box: Box; frame: number }
  | { kind: 'divider'; divider: Divider; pointer: number; sx: number; sy: number; start: Record<string, Box>; boxes: Record<string, Box>; frame: number };

type Stored = { v: 1; preset?: RoomLayout; boxes: Record<string, [number, number, number, number]> };

function readStored(key: string | null): Stored | null {
  if (!key) return null;
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? 'null') as Stored | null;
    return value && value.v === 1 && value.boxes && typeof value.boxes === 'object' ? value : null;
  } catch {
    return null;
  }
}

const styleFor = (box: Box) => `translate3d(${box.x}px, ${box.y}px, 0)`;

// A room is a desk of glass windows: drag by the title bar, resize from any
// edge or corner, snap to edges and neighbours, tile, and drag the divider
// where tiles meet. Gestures write styles once per animation frame and only
// commit to React state when the pointer is released.
export default function RoomDesk({ ref, windows, preset, storageKey, onClose, emptyHint }: {
  ref?: Ref<DeskHandle>;
  windows: DeskWindow[];
  preset: RoomLayout;
  storageKey: string | null;
  onClose: (id: string) => void;
  emptyHint: ReactNode;
}) {
  const deskRef = useRef<HTMLDivElement>(null);
  const winRefs = useRef(new Map<string, HTMLElement>());
  const gestureRef = useRef<Gesture | null>(null);
  const flipRef = useRef<Record<string, Box> | null>(null);
  const [area, setArea] = useState<Size | null>(null);
  const [boxes, setBoxes] = useState<Record<string, Box>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [maxId, setMaxId] = useState<string | null>(null);
  const [active, setActive] = useState<{ id: string; kind: 'move' | 'resize' } | null>(null);
  const [draggingDivider, setDraggingDivider] = useState<string | null>(null);
  const loadedKeyRef = useRef<string | null | undefined>(undefined);
  const areaRef = useRef<Size | null>(null);
  const presetRef = useRef(preset);

  const openIds = useMemo(() => windows.filter((w) => w.open).map((w) => w.id), [windows]);
  const openKey = openIds.join(',');

  const persist = useCallback((next: Record<string, Box>) => {
    const size = areaRef.current;
    if (!storageKey || !size) return;
    const stored: Stored = { v: 1, preset: presetRef.current, boxes: {} };
    for (const [id, box] of Object.entries(next)) stored.boxes[id] = toFractions(box, size);
    try { window.localStorage.setItem(storageKey, JSON.stringify(stored)); } catch { /* storage full or blocked: layout stays in memory */ }
  }, [storageKey]);

  // Measure before paint so windows never flash at the wrong size.
  useLayoutEffect(() => {
    const desk = deskRef.current;
    if (!desk) return;
    const measure = () => {
      const rect = desk.getBoundingClientRect();
      const next = { w: Math.round(rect.width), h: Math.round(rect.height) };
      const previous = areaRef.current;
      if (previous && previous.w === next.w && previous.h === next.h) return;
      areaRef.current = next;
      setArea(next);
      // Keep the arrangement when the desk itself changes size.
      if (previous && previous.w > 0 && previous.h > 0) {
        setBoxes((current) => Object.fromEntries(Object.entries(current).map(([id, b]) => [id, clampBox({ x: b.x * next.w / previous.w, y: b.y * next.h / previous.h, w: b.w * next.w / previous.w, h: b.h * next.h / previous.h }, next, LIMITS)])));
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(desk);
    return () => observer.disconnect();
  }, []);

  // First layout for this room and user: what they left, else the preset.
  useLayoutEffect(() => {
    if (!area || loadedKeyRef.current === storageKey) return;
    loadedKeyRef.current = storageKey;
    const stored = readStored(storageKey);
    // Remember which preset the saved desk was made under, so the room's
    // preferences resolving a moment later don't wipe it.
    if (stored?.preset) presetRef.current = stored.preset;
    const preset0 = arrangeBoxes(presetRef.current, openIds, area);
    const next: Record<string, Box> = {};
    // Every saved box, not just the windows open right now: the saved list of
    // open windows can arrive a moment later and must find its boxes here.
    for (const [id, value] of Object.entries(stored?.boxes ?? {})) { const box = fromFractions(value, area, LIMITS); if (box) next[id] = box; }
    for (const id of openIds) next[id] ??= preset0[id];
    setBoxes(next);
    setOrder(openIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the desk or its storage key first becomes known
  }, [area, storageKey]);

  // A window that opens gets the slot the preset would give it, on top.
  useLayoutEffect(() => {
    if (!area || loadedKeyRef.current === undefined) return;
    setBoxes((current) => {
      const missing = openIds.filter((id) => !current[id]);
      if (!missing.length) return current;
      const slots = arrangeBoxes(presetRef.current, openIds, area);
      return { ...current, ...Object.fromEntries(missing.map((id) => [id, slots[id]])) };
    });
    setOrder((current) => {
      const kept = current.filter((id) => openIds.includes(id));
      const added = openIds.filter((id) => !kept.includes(id));
      return added.length || kept.length !== current.length ? [...kept, ...added] : current;
    });
    if (maxId && !openIds.includes(maxId)) setMaxId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the open set only
  }, [openKey, area]);

  const animateTo = useCallback((next: Record<string, Box>) => {
    flipRef.current = boxes;
    setMaxId(null);
    setBoxes(next);
    persist(next);
  }, [boxes, persist]);

  // A new preset (personal choice or the owner's locked default) re-arranges,
  // unless the desk is already laid out for it (a saved desk made under it).
  const lastPresetProp = useRef(preset);
  useEffect(() => {
    if (lastPresetProp.current === preset) return;
    lastPresetProp.current = preset;
    if (presetRef.current === preset || !areaRef.current || loadedKeyRef.current === undefined) return;
    presetRef.current = preset;
    const next = arrangeBoxes(preset, openIds, areaRef.current);
    setMaxId(null);
    setBoxes(next);
    persist(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the preset changes
  }, [preset]);

  // Layout menu commands from the room header.
  useImperativeHandle(ref, () => ({
    tile: () => {
      if (!area) return;
      const ordered = ['watch', 'whiteboard', 'study', 'home', 'chat', 'members', 'voice', 'collab', 'files'].filter((id) => openIds.includes(id));
      animateTo(tileBoxes(ordered, area, preset === 'chat' ? 0.5 : 0.26));
    },
    reset: () => { if (area) animateTo(arrangeBoxes(preset, openIds, area)); },
    focus: () => { const top = order[order.length - 1]; if (top) setMaxId((current) => (current === top ? null : top)); },
    raise: (id: string) => setOrder((current) => [...current.filter((k) => k !== id), id]),
  }), [animateTo, area, openIds, order, preset]);

  // FLIP: windows jump to their new box, then glide there from the old one
  // with transform only (scale stands in for the size change while it moves).
  useLayoutEffect(() => {
    const from = flipRef.current;
    if (!from) return;
    flipRef.current = null;
    let index = 0;
    for (const [id, to] of Object.entries(boxes)) {
      const el = winRefs.current.get(id);
      const old = from[id];
      if (!el || !old || (old.x === to.x && old.y === to.y && old.w === to.w && old.h === to.h)) continue;
      el.style.transition = 'none';
      el.style.transform = `translate3d(${old.x}px, ${old.y}px, 0) scale(${old.w / to.w}, ${old.h / to.h})`;
      void el.offsetWidth;
      el.style.transition = `transform 520ms cubic-bezier(.22,1,.36,1) ${index++ * 50}ms`;
      el.style.transform = `${styleFor(to)} scale(1, 1)`;
      el.addEventListener('transitionend', () => { el.style.transition = ''; }, { once: true });
    }
  }, [boxes]);

  const raise = (id: string) => setOrder((current) => (current[current.length - 1] === id ? current : [...current.filter((k) => k !== id), id]));
  const others = (id: string) => openIds.filter((k) => k !== id && boxes[k]).map((k) => boxes[k]);

  const startGesture = (event: PointerEvent<HTMLElement>, id: string, kind: 'move' | 'resize', edge?: Edge) => {
    if (event.button !== 0 || !area || window.matchMedia(STACKED).matches || maxId === id) return;
    const start = boxes[id];
    if (!start) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const el = winRefs.current.get(id);
    if (el) el.style.transition = 'none';
    gestureRef.current = { kind, id, edge, pointer: event.pointerId, sx: event.clientX, sy: event.clientY, start, box: start, frame: 0 };
    raise(id);
    setActive({ id, kind });
  };

  const paintWindow = (id: string, box: Box, resizing: boolean) => {
    const el = winRefs.current.get(id);
    if (!el) return;
    el.style.transform = styleFor(box);
    if (resizing) {
      el.style.width = `${box.w}px`;
      el.style.height = `${box.h}px`;
      const tag = el.querySelector<HTMLElement>('[data-size-tag]');
      if (tag) tag.textContent = `${box.w} × ${box.h}`;
    }
  };

  const onGestureMove = (event: PointerEvent<HTMLElement>) => {
    const g = gestureRef.current;
    if (!g || g.pointer !== event.pointerId || !area) return;
    const dx = event.clientX - g.sx;
    const dy = event.clientY - g.sy;
    if (g.kind === 'divider') {
      g.boxes = moveDivider(g.start, g.divider, g.divider.axis === 'x' ? dx : dy, LIMITS);
      if (!g.frame) g.frame = requestAnimationFrame(() => {
        g.frame = 0;
        for (const id of [...g.divider.before, ...g.divider.after]) if (g.boxes[id]) paintWindow(id, g.boxes[id], true);
        const line = deskRef.current?.querySelector<HTMLElement>(`[data-divider="${g.divider.axis}${g.divider.at}"]`);
        if (line) line.style.transform = g.divider.axis === 'x' ? `translateX(${g.boxes[g.divider.before[0]].w - g.start[g.divider.before[0]].w}px)` : `translateY(${g.boxes[g.divider.before[0]].h - g.start[g.divider.before[0]].h}px)`;
      });
      return;
    }
    g.box = g.kind === 'move'
      ? snapBox(clampBox({ ...g.start, x: g.start.x + dx, y: g.start.y + dy }, area, LIMITS), others(g.id), area)
      : resizeBox(g.start, g.edge ?? 'se', dx, dy, area, LIMITS);
    if (!g.frame) g.frame = requestAnimationFrame(() => { g.frame = 0; paintWindow(g.id, g.box, g.kind === 'resize'); });
  };

  const onGestureEnd = (event: PointerEvent<HTMLElement>) => {
    const g = gestureRef.current;
    if (!g || g.pointer !== event.pointerId) return;
    cancelAnimationFrame(g.frame);
    gestureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (g.kind === 'divider') {
      setDraggingDivider(null);
      const line = deskRef.current?.querySelector<HTMLElement>(`[data-divider="${g.divider.axis}${g.divider.at}"]`);
      if (line) line.style.transform = '';
      const next = { ...boxes, ...g.boxes };
      setBoxes(next);
      persist(next);
      return;
    }
    setActive(null);
    const el = winRefs.current.get(g.id);
    if (el) el.style.transition = '';
    const next = { ...boxes, [g.id]: g.box };
    setBoxes(next);
    persist(next);
  };

  const startDivider = (event: PointerEvent<HTMLElement>, divider: Divider) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current = { kind: 'divider', divider, pointer: event.pointerId, sx: event.clientX, sy: event.clientY, start: boxes, boxes, frame: 0 };
    setDraggingDivider(`${divider.axis}${divider.at}`);
  };

  const nudge = (id: string, dx: number, dy: number, resize: boolean) => {
    if (!area || !boxes[id]) return;
    setMaxId(null);
    const box = resize ? resizeBox(boxes[id], 'se', dx, dy, area, LIMITS) : clampBox({ ...boxes[id], x: boxes[id].x + dx, y: boxes[id].y + dy }, area, LIMITS);
    const next = { ...boxes, [id]: box };
    setBoxes(next);
    persist(next);
  };
  const keyNudge = (id: string, resize: boolean) => (event: KeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? 64 : 16;
    const delta = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, number[]>)[event.key];
    if (!delta) return;
    event.preventDefault();
    raise(id);
    nudge(id, delta[0], delta[1], resize);
  };
  const dividerKeys = (divider: Divider) => (event: KeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? 64 : 16;
    const d = divider.axis === 'x' ? ({ ArrowLeft: -step, ArrowRight: step } as Record<string, number>)[event.key] : ({ ArrowUp: -step, ArrowDown: step } as Record<string, number>)[event.key];
    if (!d) return;
    event.preventDefault();
    const next = { ...boxes, ...moveDivider(boxes, divider, d, LIMITS) };
    setBoxes(next);
    persist(next);
  };

  const inner = area ? { x: DESK_PAD, y: DESK_PAD, w: area.w - DESK_PAD * 2, h: area.h - DESK_PAD * 2 } : null;
  const shown = Object.fromEntries(openIds.filter((id) => boxes[id]).map((id) => [id, boxes[id]]));
  const dividers = maxId || !area ? [] : findDividers(shown);

  return (
    <div className="room-desk" ref={deskRef} data-ready={area ? '' : undefined}>
      {/* Title buttons are named by their visible title; how to move them is the description. */}
      <span id="desk-move-hint" className="sr-only">Arrow keys move this window; hold Shift to move it further.</span>
      {openIds.length === 0 && <div className="room-desk-empty">{emptyHint}</div>}
      {windows.filter((w) => w.open || w.keepMounted).map((w) => {
        // A kept-mounted window that was never opened still gets a real size,
        // so players and canvases inside it start up normally while hidden.
        const box = (maxId === w.id && inner) || boxes[w.id] || (w.keepMounted ? inner : null);
        const isActive = active?.id === w.id;
        return (
          <section
            key={w.id}
            ref={(el) => { if (el) winRefs.current.set(w.id, el); else winRefs.current.delete(w.id); }}
            className={`desk-win ${isActive && active?.kind === 'move' ? 'is-lifted' : ''} ${isActive && active?.kind === 'resize' ? 'is-resizing' : ''} ${maxId === w.id ? 'is-max' : ''}`}
            data-win={w.id}
            data-open={w.open && boxes[w.id] ? 'true' : 'false'}
            aria-hidden={!w.open}
            aria-label={`${w.title} window`}
            style={box ? { transform: styleFor(box), width: box.w, height: box.h, zIndex: order.indexOf(w.id) + 1 } : undefined}
            onPointerDownCapture={() => { if (order[order.length - 1] !== w.id) raise(w.id); }}
          >
            <header className="desk-bar" onPointerDown={(event) => startGesture(event, w.id, 'move')} onPointerMove={onGestureMove} onPointerUp={onGestureEnd} onPointerCancel={onGestureEnd} onDoubleClick={() => setMaxId((current) => (current === w.id ? null : w.id))}>
              <span className="desk-dots">
                <button type="button" className="desk-dot" aria-label={`Close the ${w.title} window`} title="Close" onPointerDown={(event) => event.stopPropagation()} onClick={() => onClose(w.id)}><OmniIcon name="close" size={11} strokeWidth={2.4} /></button>
                <i aria-hidden="true" />
                <button type="button" className="desk-dot" aria-label={`Fill the desk with the ${w.title} window`} aria-pressed={maxId === w.id} title={maxId === w.id ? 'Restore' : 'Focus'} onPointerDown={(event) => event.stopPropagation()} onClick={() => setMaxId((current) => (current === w.id ? null : w.id))}><OmniIcon name="maximize" size={11} strokeWidth={2.4} /></button>
              </span>
              <button type="button" className="desk-title" aria-describedby="desk-move-hint" aria-roledescription="movable window title" onKeyDown={keyNudge(w.id, false)}>
                <OmniIcon name={w.icon} size={14} />{w.title}
              </button>
              <span className="desk-extra">{w.extra}</span>
            </header>
            <div className="desk-body">{w.children}</div>
            {EDGES.map((edge) => <span key={edge} className={`desk-edge desk-edge-${edge}`} aria-hidden="true" onPointerDown={(event) => startGesture(event, w.id, 'resize', edge)} onPointerMove={onGestureMove} onPointerUp={onGestureEnd} onPointerCancel={onGestureEnd} />)}
            <button type="button" className="desk-grip" aria-label={`Resize the ${w.title} window. Arrow keys change its size.`} onPointerDown={(event) => startGesture(event, w.id, 'resize', 'se')} onPointerMove={onGestureMove} onPointerUp={onGestureEnd} onPointerCancel={onGestureEnd} onKeyDown={keyNudge(w.id, true)} />
            <span className="desk-size mono" data-size-tag aria-hidden="true">{box ? `${box.w} × ${box.h}` : ''}</span>
          </section>
        );
      })}
      {dividers.map((divider) => {
        const id = `${divider.axis}${divider.at}`;
        const vertical = divider.axis === 'x';
        return (
          <div
            key={id}
            role="separator"
            tabIndex={0}
            aria-orientation={vertical ? 'vertical' : 'horizontal'}
            aria-label={vertical ? 'Resize the windows on both sides of this divider' : 'Resize the windows above and below this divider'}
            className={`desk-divider ${vertical ? 'is-x' : 'is-y'} ${draggingDivider === id ? 'is-dragging' : ''}`}
            data-divider={id}
            style={vertical ? { left: divider.at, top: divider.from, height: divider.to - divider.from } : { top: divider.at, left: divider.from, width: divider.to - divider.from }}
            onPointerDown={(event) => startDivider(event, divider)}
            onPointerMove={onGestureMove}
            onPointerUp={onGestureEnd}
            onPointerCancel={onGestureEnd}
            onKeyDown={dividerKeys(divider)}
          />
        );
      })}
    </div>
  );
}
