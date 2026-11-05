'use client';

import { unwrapAction } from '@/lib/action-result';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { getRoomWhiteboard, saveRoomWhiteboard, type RoomWhiteboard } from '@/actions/study-collaboration';
import { useRoomRealtime } from '@/components/room/RoomRealtimeProvider';
import { useWhiteboardCursors } from '@/components/room/WhiteboardCursors';
import {
  LEGACY_IMAGE_KEY,
  WHITEBOARD_MAX_ELEMENTS,
  WHITEBOARD_SAVE_BUDGET_BYTES,
  WHITEBOARD_TEXT_MAX_CHARS,
  applyWhiteboardOps,
  elementBounds,
  parseWhiteboardState,
  serializeWhiteboard,
  simplifyStrokePoints,
  strokePath,
  translateElement,
  whiteboardStateBytes,
  wrapText,
  type Bounds,
  type WhiteboardDocument,
  type WhiteboardElement,
  type WhiteboardOps,
  type WhiteboardTool,
} from '@/lib/whiteboard-model';

// Shared room whiteboard (Action 10). Vector elements are saved through the
// study-capability RPC with an optimistic version. Other members learn about
// a save only through a version-only Broadcast hint (whiteboard_changed) and
// re-read the board through getRoomWhiteboard under their own authorization.
// Unsaved local operations are merged onto a newer board instead of lost.

type Viewport = { x: number; y: number; zoom: number };
type HistoryEntry = Array<{ id: string; before: WhiteboardElement | null; after: WhiteboardElement | null }>;
type SaveStatus = 'loading' | 'saved' | 'unsaved' | 'saving' | 'conflict' | 'error';
type Interaction =
  | { type: 'pan'; startX: number; startY: number; origin: Viewport }
  | { type: 'draw'; element: WhiteboardElement }
  | { type: 'move'; startX: number; startY: number; originals: WhiteboardElement[]; moved: boolean }
  | { type: 'resize'; original: WhiteboardElement; anchorX: number; anchorY: number }
  | { type: 'erase'; removed: Map<string, WhiteboardElement> };
type TextEditor = { id: string; kind: 'text' | 'note'; x: number; y: number; w: number; h: number; value: string; size: number; isNew: boolean };

const COLORS = ['#f4f4f5', '#818cf8', '#38bdf8', '#34d399', '#fbbf24', '#f87171', '#e879f9', '#18181b'];
const NOTE_COLORS = ['#fde68a', '#fbcfe8', '#bbf7d0', '#bae6fd', '#ddd6fe'];
const WIDTHS = [2, 4, 8, 14];
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;
const SAVE_DELAY_MS = 450;

const TOOLS: Array<{ tool: WhiteboardTool; label: string; key: string; icon: string }> = [
  { tool: 'select', label: 'Select and move', key: 'V', icon: 'M5 3l13 7-6 1.5L9.5 18z' },
  { tool: 'hand', label: 'Pan', key: 'H', icon: 'M8 13V5.5a1.5 1.5 0 0 1 3 0V12m0-6.5V4a1.5 1.5 0 0 1 3 0v8m0-6a1.5 1.5 0 0 1 3 0v6m0-3a1.5 1.5 0 0 1 3 0v4a7 7 0 0 1-7 7h-1a7 7 0 0 1-6-3.5L3 13.5a1.5 1.5 0 0 1 2.5-1.6L8 15' },
  { tool: 'pen', label: 'Pen', key: 'P', icon: 'M4 20l4-1L19 8l-3-3L5 16zM14 6l3 3' },
  { tool: 'highlighter', label: 'Highlighter', key: 'M', icon: 'M9 15l-4 4h6l2-2M8 14l7-9 4 4-9 7zM12 7l5 5' },
  { tool: 'eraser', label: 'Eraser', key: 'E', icon: 'M7 20h12M5 14l8-8 6 6-6 6H9z' },
  { tool: 'line', label: 'Line', key: 'L', icon: 'M5 19L19 5' },
  { tool: 'arrow', label: 'Arrow', key: 'A', icon: 'M5 19L19 5M10 5h9v9' },
  { tool: 'rect', label: 'Rectangle', key: 'R', icon: 'M4 6h16v12H4z' },
  { tool: 'ellipse', label: 'Ellipse', key: 'O', icon: 'M12 5c4.4 0 8 3.1 8 7s-3.6 7-8 7-8-3.1-8-7 3.6-7 8-7z' },
  { tool: 'text', label: 'Text', key: 'T', icon: 'M5 6V4h14v2M12 4v16M9 20h6' },
  { tool: 'note', label: 'Sticky note', key: 'N', icon: 'M5 4h14v10l-6 6H5zM13 20v-6h6' },
];

const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Unable to update the whiteboard.';
const isConflict = (message: string) => message.includes('expected version');
const newId = () => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
const isEditableTarget = (target: EventTarget | null) => target instanceof HTMLElement
  && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');

function normalizeBox(x1: number, y1: number, x2: number, y2: number) {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.max(1, Math.abs(x2 - x1)), h: Math.max(1, Math.abs(y2 - y1)) };
}

function unionBounds(list: Bounds[]): Bounds | null {
  if (list.length === 0) return null;
  const minX = Math.min(...list.map((b) => b.x));
  const minY = Math.min(...list.map((b) => b.y));
  const maxX = Math.max(...list.map((b) => b.x + b.w));
  const maxY = Math.max(...list.map((b) => b.y + b.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function ElementShape({ element, zoom }: { element: WhiteboardElement; zoom: number }) {
  const hitWidth = Math.max(element.width, 14 / zoom);
  switch (element.kind) {
    case 'stroke': {
      const d = strokePath(element.points);
      return <>
        <path d={d} fill="none" stroke="transparent" strokeWidth={hitWidth + (element.highlighter ? element.width : 0)} strokeLinecap="round" strokeLinejoin="round" />
        <path d={d} fill="none" stroke={element.color} strokeWidth={element.highlighter ? element.width * 3 : element.width} strokeOpacity={element.highlighter ? 0.35 : 1} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
      </>;
    }
    case 'line':
    case 'arrow': {
      const angle = Math.atan2(element.y2 - element.y1, element.x2 - element.x1);
      const head = Math.max(10, element.width * 3.5);
      const left = `${element.x2 - head * Math.cos(angle - Math.PI / 7)},${element.y2 - head * Math.sin(angle - Math.PI / 7)}`;
      const right = `${element.x2 - head * Math.cos(angle + Math.PI / 7)},${element.y2 - head * Math.sin(angle + Math.PI / 7)}`;
      return <>
        <line x1={element.x1} y1={element.y1} x2={element.x2} y2={element.y2} stroke="transparent" strokeWidth={hitWidth} strokeLinecap="round" />
        <line x1={element.x1} y1={element.y1} x2={element.x2} y2={element.y2} stroke={element.color} strokeWidth={element.width} strokeLinecap="round" pointerEvents="none" />
        {element.kind === 'arrow' && <polygon points={`${element.x2},${element.y2} ${left} ${right}`} fill={element.color} stroke={element.color} strokeWidth={element.width / 2} strokeLinejoin="round" pointerEvents="none" />}
      </>;
    }
    case 'rect':
      return <>
        {!element.fill && <rect x={element.x} y={element.y} width={element.w} height={element.h} fill="none" stroke="transparent" strokeWidth={hitWidth} />}
        <rect x={element.x} y={element.y} width={element.w} height={element.h} rx={Math.min(12, element.w / 4, element.h / 4)} fill={element.fill ? element.color : 'transparent'} fillOpacity={element.fill ? 0.22 : 1} stroke={element.color} strokeWidth={element.width} strokeLinejoin="round" pointerEvents={element.fill ? 'all' : 'none'} />
      </>;
    case 'ellipse':
      return <>
        {!element.fill && <ellipse cx={element.x + element.w / 2} cy={element.y + element.h / 2} rx={element.w / 2} ry={element.h / 2} fill="none" stroke="transparent" strokeWidth={hitWidth} />}
        <ellipse cx={element.x + element.w / 2} cy={element.y + element.h / 2} rx={element.w / 2} ry={element.h / 2} fill={element.fill ? element.color : 'transparent'} fillOpacity={element.fill ? 0.22 : 1} stroke={element.color} strokeWidth={element.width} pointerEvents={element.fill ? 'all' : 'none'} />
      </>;
    case 'text': {
      const lines = element.text.split('\n');
      const bounds = elementBounds(element);
      return <>
        <rect x={bounds.x} y={bounds.y} width={bounds.w} height={bounds.h} fill="transparent" />
        <text x={element.x} y={element.y} fill={element.color} fontSize={element.size} fontFamily="ui-sans-serif, system-ui, sans-serif" fontWeight={600} pointerEvents="none">
          {lines.map((line, index) => <tspan key={index} x={element.x} dy={index === 0 ? element.size : element.size * 1.25}>{line || ' '}</tspan>)}
        </text>
      </>;
    }
    case 'note': {
      const padding = 12;
      const lines = wrapText(element.text, element.w - padding * 2, element.size);
      const visible = Math.max(1, Math.floor((element.h - padding * 2) / (element.size * 1.3)));
      return <>
        <rect x={element.x + 3} y={element.y + 4} width={element.w} height={element.h} rx={6} fill="#000" opacity={0.35} pointerEvents="none" />
        <rect x={element.x} y={element.y} width={element.w} height={element.h} rx={6} fill={element.color} />
        <text x={element.x + padding} y={element.y + padding} fill="#18181b" fontSize={element.size} fontFamily="ui-sans-serif, system-ui, sans-serif" pointerEvents="none">
          {lines.slice(0, visible).map((line, index) => <tspan key={index} x={element.x + padding} dy={index === 0 ? element.size : element.size * 1.3}>{line || ' '}</tspan>)}
        </text>
      </>;
    }
  }
}

export default function StudyWhiteboardPanel({ roomId }: { roomId: string }) {
  const { whiteboardVersion, broadcastEvent } = useRoomRealtime();
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const [doc, setDoc] = useState<WhiteboardDocument>({ elements: [], legacyImage: null });
  const docRef = useRef(doc);
  const remoteRef = useRef<WhiteboardDocument>({ elements: [], legacyImage: null });
  const pendingOpsRef = useRef<WhiteboardOps>(new Map());
  const [expectedVersion, setExpectedVersion] = useState(0);
  const expectedVersionRef = useRef(0);
  const [status, setStatus] = useState<SaveStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const saveAgainRef = useRef(false);
  const [saveTick, setSaveTick] = useState(0);

  const [tool, setTool] = useState<WhiteboardTool>('pen');
  const [color, setColor] = useState(COLORS[1]);
  const [noteColor, setNoteColor] = useState(NOTE_COLORS[0]);
  const [strokeWidth, setStrokeWidth] = useState(WIDTHS[1]);
  const [fillShapes, setFillShapes] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const viewportRef = useRef(viewport);
  const cursors = useWhiteboardCursors(roomId, viewport);
  const [selection, setSelection] = useState<string[]>([]);
  const [draft, setDraft] = useState<WhiteboardElement | null>(null);
  const [editor, setEditor] = useState<TextEditor | null>(null);
  const interactionRef = useRef<Interaction | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ distance: number; zoom: number; midX: number; midY: number; origin: Viewport } | null>(null);
  const spaceHeldRef = useRef(false);
  const [panning, setPanning] = useState(false);
  const undoRef = useRef<HistoryEntry[]>([]);
  const redoRef = useRef<HistoryEntry[]>([]);
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  const [remoteNotice, setRemoteNotice] = useState(false);
  const remoteDeferredRef = useRef(false);

  const setViewportBoth = useCallback((next: Viewport | ((current: Viewport) => Viewport)) => {
    setViewport((current) => {
      const value = typeof next === 'function' ? next(current) : next;
      viewportRef.current = value;
      return value;
    });
  }, []);

  const commitDoc = useCallback((next: WhiteboardDocument) => {
    docRef.current = next;
    setDoc(next);
  }, []);

  const syncHistoryState = useCallback(() => {
    setHistoryState({ canUndo: undoRef.current.length > 0, canRedo: redoRef.current.length > 0 });
  }, []);

  // Records local changes as unsaved operations and schedules a save.
  const applyLocal = useCallback((changes: HistoryEntry, recordHistory = true) => {
    if (changes.length === 0) return;
    const ops = new Map<string, WhiteboardElement | null>();
    for (const change of changes) {
      ops.set(change.id, change.after);
      pendingOpsRef.current.set(change.id, change.after);
    }
    commitDoc(applyWhiteboardOps(docRef.current, ops));
    if (recordHistory) {
      undoRef.current = [...undoRef.current.slice(-99), changes];
      redoRef.current = [];
      syncHistoryState();
    }
    setStatus('unsaved');
    setSaveTick((tick) => tick + 1);
  }, [commitDoc, syncHistoryState]);

  const adoptRemote = useCallback((board: RoomWhiteboard | null) => {
    const remote = parseWhiteboardState(board?.state);
    const version = board?.version ?? 0;
    remoteRef.current = remote;
    expectedVersionRef.current = version;
    setExpectedVersion(version);
    commitDoc(applyWhiteboardOps(remote, pendingOpsRef.current));
    setSelection((current) => current.filter((id) => docRef.current.elements.some((element) => element.id === id)));
  }, [commitDoc]);

  const load = useCallback(async (reason: 'initial' | 'remote' | 'manual') => {
    // Applying a newer board mid-drag would move elements under the pointer;
    // finishInteraction re-runs the deferred load.
    if (reason === 'remote' && interactionRef.current) { remoteDeferredRef.current = true; return; }
    try {
      const board = await getRoomWhiteboard(roomId).then(unwrapAction);
      if ((board?.version ?? 0) < expectedVersionRef.current && reason !== 'manual') return;
      adoptRemote(board);
      setError(null);
      setStatus(pendingOpsRef.current.size > 0 ? 'unsaved' : 'saved');
      if (reason === 'remote') {
        setRemoteNotice(true);
        window.setTimeout(() => setRemoteNotice(false), 1800);
      }
    } catch (loadError) {
      setStatus('error');
      setError(errorMessage(loadError));
    }
  }, [adoptRemote, roomId]);

  const save = useCallback(async () => {
    if (savingRef.current) { saveAgainRef.current = true; return; }
    if (pendingOpsRef.current.size === 0) return;
    savingRef.current = true;
    setStatus('saving');
    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const ops = new Map(pendingOpsRef.current);
        const next = applyWhiteboardOps(remoteRef.current, ops);
        if (whiteboardStateBytes(next) > WHITEBOARD_SAVE_BUDGET_BYTES || next.elements.length > WHITEBOARD_MAX_ELEMENTS) {
          throw new Error('The whiteboard is full. Erase or clear some items before adding more.');
        }
        try {
          const board = await saveRoomWhiteboard(roomId, expectedVersionRef.current, serializeWhiteboard(next)).then(unwrapAction);
          remoteRef.current = next;
          expectedVersionRef.current = board.version;
          setExpectedVersion(board.version);
          // Keep operations made while this save was in flight.
          for (const [id, value] of ops) {
            if (pendingOpsRef.current.get(id) === value) pendingOpsRef.current.delete(id);
          }
          broadcastEvent('whiteboard_changed', { version: board.version });
          setError(null);
          setStatus(pendingOpsRef.current.size > 0 ? 'unsaved' : 'saved');
          return;
        } catch (saveError) {
          const message = errorMessage(saveError);
          if (!isConflict(message) || attempt === 3) throw saveError;
          // Someone else saved first: merge our operations onto their board.
          const latest = await getRoomWhiteboard(roomId).then(unwrapAction);
          adoptRemote(latest);
        }
      }
    } catch (saveError) {
      const message = errorMessage(saveError);
      setStatus(isConflict(message) ? 'conflict' : 'error');
      setError(isConflict(message) ? 'Conflict detected. Your changes are kept locally; select Retry to merge them again.' : message);
    } finally {
      savingRef.current = false;
      if (saveAgainRef.current) {
        saveAgainRef.current = false;
        setSaveTick((tick) => tick + 1);
      }
    }
  }, [adoptRemote, broadcastEvent, roomId]);

  useEffect(() => {
    const timeout = window.setTimeout(() => { void load('initial'); }, 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  // A member saved a newer version: re-read it through the protected action.
  useEffect(() => {
    if (whiteboardVersion <= expectedVersionRef.current) return;
    const timeout = window.setTimeout(() => { void load('remote'); }, 0);
    return () => window.clearTimeout(timeout);
  }, [load, whiteboardVersion]);

  useEffect(() => {
    if (saveTick === 0 || interactionRef.current) return;
    const timeout = window.setTimeout(() => { void save(); }, SAVE_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [save, saveTick]);

  // Warn before leaving with unsaved strokes.
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (pendingOpsRef.current.size > 0) event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  const toWorld = useCallback((clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    const view = viewportRef.current;
    const sx = clientX - (rect?.left ?? 0);
    const sy = clientY - (rect?.top ?? 0);
    return { x: (sx - view.x) / view.zoom, y: (sy - view.y) / view.zoom };
  }, []);

  const zoomAt = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    const sx = clientX !== undefined && rect ? clientX - rect.left : (rect?.width ?? 0) / 2;
    const sy = clientY !== undefined && rect ? clientY - rect.top : (rect?.height ?? 0) / 2;
    setViewportBoth((current) => {
      const zoom = clampZoom(current.zoom * factor);
      const worldX = (sx - current.x) / current.zoom;
      const worldY = (sy - current.y) / current.zoom;
      return { zoom, x: sx - worldX * zoom, y: sy - worldY * zoom };
    });
  }, [setViewportBoth]);

  const fitToContent = useCallback(() => {
    const rect = svgRef.current?.getBoundingClientRect();
    const bounds = unionBounds(docRef.current.elements.map(elementBounds));
    if (!rect || !bounds) { setViewportBoth({ x: 0, y: 0, zoom: 1 }); return; }
    const zoom = clampZoom(Math.min((rect.width - 80) / Math.max(bounds.w, 1), (rect.height - 80) / Math.max(bounds.h, 1), 2));
    setViewportBoth({ zoom, x: rect.width / 2 - (bounds.x + bounds.w / 2) * zoom, y: rect.height / 2 - (bounds.y + bounds.h / 2) * zoom });
  }, [setViewportBoth]);

  // Wheel pans; Ctrl/Cmd + wheel (and trackpad pinch) zooms at the cursor.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) zoomAt(Math.exp(-event.deltaY * 0.0025), event.clientX, event.clientY);
      else setViewportBoth((current) => ({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [setViewportBoth, zoomAt]);

  const elementAt = (clientX: number, clientY: number) => {
    const target = document.elementFromPoint(clientX, clientY);
    const group = target instanceof Element ? target.closest('[data-el-id]') : null;
    return group?.getAttribute('data-el-id') ?? null;
  };

  const findElement = (id: string) => docRef.current.elements.find((element) => element.id === id) ?? null;

  const eraseAt = (clientX: number, clientY: number, removed: Map<string, WhiteboardElement>) => {
    const id = elementAt(clientX, clientY);
    if (!id || removed.has(id)) return;
    const element = findElement(id);
    if (!element) return;
    removed.set(id, element);
    applyLocal([{ id, before: element, after: null }], false);
  };

  const openEditor = (element: WhiteboardElement & { kind: 'text' | 'note' }, isNew: boolean) => {
    const bounds = elementBounds(element);
    setEditor({ id: element.id, kind: element.kind, x: element.x, y: element.y, w: element.kind === 'note' ? element.w : Math.max(220, bounds.w + 40), h: element.kind === 'note' ? element.h : Math.max(element.size * 1.6, bounds.h + 8), value: element.text, size: element.size, isNew });
  };

  const commitEditor = () => {
    if (!editor) return;
    const existing = findElement(editor.id);
    const text = editor.value.slice(0, WHITEBOARD_TEXT_MAX_CHARS);
    setEditor(null);
    if (editor.kind === 'text') {
      if (!text.trim()) {
        if (existing) applyLocal([{ id: editor.id, before: existing, after: null }]);
        return;
      }
      const next: WhiteboardElement = existing && existing.kind === 'text'
        ? { ...existing, text }
        : { id: editor.id, kind: 'text', x: editor.x, y: editor.y, text, size: editor.size, color, width: 1 };
      if (existing && existing.kind === 'text' && existing.text === text) return;
      applyLocal([{ id: editor.id, before: existing, after: next }]);
      return;
    }
    if (existing && existing.kind === 'note') {
      if (existing.text !== text) applyLocal([{ id: editor.id, before: existing, after: { ...existing, text } }]);
    }
  };

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (editor) { commitEditor(); return; }
    containerRef.current?.focus({ preventScroll: true });
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A pointer the browser no longer treats as active (some assistive or
      // synthesized input) cannot be captured; drawing still works without it.
    }
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointersRef.current.size === 2) {
      // Second finger: switch to pinch zoom and drop the in-progress action.
      const [a, b] = [...pointersRef.current.values()];
      interactionRef.current = null;
      setDraft(null);
      pinchRef.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom: viewportRef.current.zoom, midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2, origin: viewportRef.current };
      return;
    }

    const point = toWorld(event.clientX, event.clientY);
    if (tool === 'hand' || spaceHeldRef.current || event.button === 1) {
      interactionRef.current = { type: 'pan', startX: event.clientX, startY: event.clientY, origin: viewportRef.current };
      setPanning(true);
      return;
    }
    if (event.button !== 0) return;

    if (tool === 'select') {
      const handle = (event.target as Element).closest?.('[data-resize-handle]');
      if (handle && selection.length === 1) {
        const original = findElement(selection[0]);
        if (original) {
          const bounds = elementBounds(original);
          interactionRef.current = { type: 'resize', original, anchorX: bounds.x, anchorY: bounds.y };
          return;
        }
      }
      const id = elementAt(event.clientX, event.clientY);
      if (!id) {
        setSelection([]);
        interactionRef.current = { type: 'pan', startX: event.clientX, startY: event.clientY, origin: viewportRef.current };
        setPanning(true);
        return;
      }
      const nextSelection = event.shiftKey
        ? (selection.includes(id) ? selection.filter((item) => item !== id) : [...selection, id])
        : (selection.includes(id) ? selection : [id]);
      setSelection(nextSelection);
      const originals = nextSelection.map(findElement).filter((element): element is WhiteboardElement => Boolean(element));
      interactionRef.current = { type: 'move', startX: point.x, startY: point.y, originals, moved: false };
      return;
    }

    if (tool === 'eraser') {
      const removed = new Map<string, WhiteboardElement>();
      interactionRef.current = { type: 'erase', removed };
      eraseAt(event.clientX, event.clientY, removed);
      return;
    }

    if (tool === 'text') {
      const size = Math.max(16, strokeWidth * 5);
      setEditor({ id: newId(), kind: 'text', x: point.x, y: point.y - size * 0.2, w: 260, h: size * 1.6, value: '', size, isNew: true });
      return;
    }

    if (tool === 'note') {
      const note: WhiteboardElement = { id: newId(), kind: 'note', x: Math.round(point.x - 90), y: Math.round(point.y - 70), w: 180, h: 150, text: '', size: 16, color: noteColor, width: 1 };
      applyLocal([{ id: note.id, before: null, after: note }]);
      setSelection([note.id]);
      openEditor(note, true);
      return;
    }

    const base = { id: newId(), color, width: strokeWidth };
    const element: WhiteboardElement = tool === 'pen' || tool === 'highlighter'
      ? { ...base, kind: 'stroke', points: [point.x, point.y], ...(tool === 'highlighter' ? { highlighter: true } : {}) }
      : tool === 'line' || tool === 'arrow'
        ? { ...base, kind: tool, x1: point.x, y1: point.y, x2: point.x, y2: point.y }
        : { ...base, kind: tool === 'ellipse' ? 'ellipse' : 'rect', x: point.x, y: point.y, w: 1, h: 1, ...(fillShapes ? { fill: true } : {}) };
    interactionRef.current = { type: 'draw', element };
    setDraft(element);
  };

  const shapeOrigins = useRef(new Map<string, { x: number; y: number }>());

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const canvasRect = event.currentTarget.getBoundingClientRect();
    cursors.trackPointer(event.clientX - canvasRect.left, event.clientY - canvasRect.top);
    if (pointersRef.current.has(event.pointerId)) pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pinch = pinchRef.current;
    if (pinch && pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      const rect = svgRef.current?.getBoundingClientRect();
      const zoom = clampZoom(pinch.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / Math.max(pinch.distance, 1)));
      const sx = pinch.midX - (rect?.left ?? 0);
      const sy = pinch.midY - (rect?.top ?? 0);
      const worldX = (sx - pinch.origin.x) / pinch.origin.zoom;
      const worldY = (sy - pinch.origin.y) / pinch.origin.zoom;
      const midX = (a.x + b.x) / 2 - (rect?.left ?? 0);
      const midY = (a.y + b.y) / 2 - (rect?.top ?? 0);
      setViewportBoth({ zoom, x: midX - worldX * zoom, y: midY - worldY * zoom });
      return;
    }

    const interaction = interactionRef.current;
    if (!interaction) return;
    if (interaction.type === 'pan') {
      setViewportBoth({ ...interaction.origin, x: interaction.origin.x + event.clientX - interaction.startX, y: interaction.origin.y + event.clientY - interaction.startY });
      return;
    }
    if (interaction.type === 'erase') { eraseAt(event.clientX, event.clientY, interaction.removed); return; }

    const point = toWorld(event.clientX, event.clientY);
    if (interaction.type === 'move') {
      const dx = point.x - interaction.startX;
      const dy = point.y - interaction.startY;
      if (!interaction.moved && Math.hypot(dx, dy) * viewportRef.current.zoom < 3) return;
      interaction.moved = true;
      const ops = new Map(interaction.originals.map((original) => [original.id, translateElement(original, dx, dy)] as const));
      commitDoc(applyWhiteboardOps(docRef.current, ops));
      return;
    }
    if (interaction.type === 'resize') {
      const original = interaction.original;
      if (original.kind === 'rect' || original.kind === 'ellipse' || original.kind === 'note') {
        const minimum = original.kind === 'note' ? 80 : 4;
        const resized = { ...original, w: Math.max(minimum, Math.round(point.x - original.x)), h: Math.max(minimum, Math.round(point.y - original.y)) };
        commitDoc(applyWhiteboardOps(docRef.current, new Map([[original.id, resized]])));
      } else if (original.kind === 'text') {
        const bounds = elementBounds(original);
        const scale = Math.max(0.2, (point.y - original.y) / Math.max(bounds.h, 1));
        const resized = { ...original, size: Math.min(400, Math.max(8, Math.round(original.size * scale))) };
        commitDoc(applyWhiteboardOps(docRef.current, new Map([[original.id, resized]])));
      }
      return;
    }
    if (interaction.type === 'draw') {
      const element = interaction.element;
      let next: WhiteboardElement = element;
      if (element.kind === 'stroke') {
        const events = typeof event.nativeEvent.getCoalescedEvents === 'function' ? event.nativeEvent.getCoalescedEvents() : [];
        const extra = events.length > 0 ? events.flatMap((coalesced) => { const p = toWorld(coalesced.clientX, coalesced.clientY); return [p.x, p.y]; }) : [point.x, point.y];
        next = { ...element, points: [...element.points, ...extra] };
      } else if (element.kind === 'line' || element.kind === 'arrow') {
        let x2 = point.x; let y2 = point.y;
        if (event.shiftKey) {
          const angle = Math.round(Math.atan2(y2 - element.y1, x2 - element.x1) / (Math.PI / 4)) * (Math.PI / 4);
          const length = Math.hypot(x2 - element.x1, y2 - element.y1);
          x2 = element.x1 + Math.cos(angle) * length; y2 = element.y1 + Math.sin(angle) * length;
        }
        next = { ...element, x2, y2 };
      } else if (element.kind === 'rect' || element.kind === 'ellipse') {
        const origin = shapeOrigins.current.get(element.id) ?? { x: element.x, y: element.y };
        shapeOrigins.current.set(element.id, origin);
        let x2 = point.x; let y2 = point.y;
        if (event.shiftKey) {
          const side = Math.max(Math.abs(x2 - origin.x), Math.abs(y2 - origin.y));
          x2 = origin.x + Math.sign(x2 - origin.x || 1) * side; y2 = origin.y + Math.sign(y2 - origin.y || 1) * side;
        }
        next = { ...element, ...normalizeBox(origin.x, origin.y, x2, y2) };
      }
      interaction.element = next;
      setDraft(next);
    }
  };

  const finishInteraction = (event: ReactPointerEvent<SVGSVGElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    const interaction = interactionRef.current;
    interactionRef.current = null;
    setPanning(false);
    if (remoteDeferredRef.current) {
      remoteDeferredRef.current = false;
      window.setTimeout(() => { void load('remote'); }, 0);
    }
    if (!interaction) return;

    if (interaction.type === 'erase') {
      const removed = [...interaction.removed.values()];
      if (removed.length > 0) {
        undoRef.current = [...undoRef.current.slice(-99), removed.map((element) => ({ id: element.id, before: element, after: null }))];
        redoRef.current = [];
        syncHistoryState();
      }
      setSaveTick((tick) => tick + 1);
      return;
    }
    if (interaction.type === 'move') {
      if (!interaction.moved) return;
      const changes = interaction.originals.map((original) => ({ id: original.id, before: original, after: findElement(original.id) }))
        .filter((change): change is { id: string; before: WhiteboardElement; after: WhiteboardElement } => Boolean(change.after));
      applyLocal(changes);
      return;
    }
    if (interaction.type === 'resize') {
      const after = findElement(interaction.original.id);
      if (after && after !== interaction.original) applyLocal([{ id: after.id, before: interaction.original, after }]);
      return;
    }
    if (interaction.type === 'draw') {
      setDraft(null);
      shapeOrigins.current.delete(interaction.element.id);
      let element = interaction.element;
      if (element.kind === 'stroke') {
        element = { ...element, points: simplifyStrokePoints(element.points.length === 2 ? [...element.points, element.points[0] + 0.1, element.points[1]] : element.points, 1.2 / viewportRef.current.zoom) };
      } else if ((element.kind === 'line' || element.kind === 'arrow') && Math.hypot(element.x2 - element.x1, element.y2 - element.y1) < 3) {
        return;
      } else if ((element.kind === 'rect' || element.kind === 'ellipse') && (element.w < 3 || element.h < 3)) {
        return;
      }
      if (element.kind === 'line' || element.kind === 'arrow') {
        element = { ...element, x1: Math.round(element.x1 * 10) / 10, y1: Math.round(element.y1 * 10) / 10, x2: Math.round(element.x2 * 10) / 10, y2: Math.round(element.y2 * 10) / 10 };
      }
      applyLocal([{ id: element.id, before: null, after: element }]);
    }
  };

  const handleDoubleClick = (event: React.MouseEvent<SVGSVGElement>) => {
    const id = elementAt(event.clientX, event.clientY);
    const element = id ? findElement(id) : null;
    if (element && (element.kind === 'text' || element.kind === 'note')) {
      setSelection([element.id]);
      openEditor(element, false);
    } else if (!element && tool === 'select') {
      const point = toWorld(event.clientX, event.clientY);
      setEditor({ id: newId(), kind: 'text', x: point.x, y: point.y, w: 260, h: 32, value: '', size: 20, isNew: true });
    }
  };

  const undo = useCallback(() => {
    const entry = undoRef.current.pop();
    if (!entry) return;
    redoRef.current.push(entry);
    applyLocal(entry.map((change) => ({ id: change.id, before: change.after, after: change.before })), false);
    syncHistoryState();
  }, [applyLocal, syncHistoryState]);

  const redo = useCallback(() => {
    const entry = redoRef.current.pop();
    if (!entry) return;
    undoRef.current.push(entry);
    applyLocal(entry, false);
    syncHistoryState();
  }, [applyLocal, syncHistoryState]);

  const deleteSelection = useCallback(() => {
    const changes = selection.map((id) => ({ id, before: docRef.current.elements.find((element) => element.id === id) ?? null, after: null }))
      .filter((change) => change.before);
    setSelection([]);
    applyLocal(changes);
  }, [applyLocal, selection]);

  const duplicateSelection = useCallback(() => {
    const copies = selection
      .map((id) => docRef.current.elements.find((element) => element.id === id))
      .filter((element): element is WhiteboardElement => Boolean(element))
      .map((element) => ({ ...translateElement(element, 24, 24), id: newId() }));
    applyLocal(copies.map((copy) => ({ id: copy.id, before: null, after: copy })));
    setSelection(copies.map((copy) => copy.id));
  }, [applyLocal, selection]);

  const restyleSelection = useCallback((patch: { color?: string; width?: number }) => {
    const changes = selection
      .map((id) => docRef.current.elements.find((element) => element.id === id))
      .filter((element): element is WhiteboardElement => Boolean(element))
      .map((element) => {
        const nextColor = element.kind === 'note' ? element.color : (patch.color ?? element.color);
        return { id: element.id, before: element, after: { ...element, color: nextColor, width: patch.width ?? element.width } as WhiteboardElement };
      });
    applyLocal(changes);
  }, [applyLocal, selection]);

  const clearBoard = () => {
    if (!window.confirm('Clear the whole whiteboard for everyone in this room?')) return;
    const changes: HistoryEntry = docRef.current.elements.map((element) => ({ id: element.id, before: element, after: null }));
    const hadLegacyImage = Boolean(docRef.current.legacyImage);
    setSelection([]);
    if (changes.length > 0) applyLocal(changes);
    if (hadLegacyImage) {
      // The legacy raster background is cleared for good (not undoable).
      pendingOpsRef.current.set(LEGACY_IMAGE_KEY, null);
      commitDoc({ ...docRef.current, legacyImage: null });
      setStatus('unsaved');
      setSaveTick((tick) => tick + 1);
    }
  };

  const exportPng = async () => {
    const svg = svgRef.current;
    const bounds = unionBounds(docRef.current.elements.map(elementBounds)) ?? { x: 0, y: 0, w: 800, h: 600 };
    const content = svg?.querySelector('[data-board-content]');
    if (!svg || !content) return;
    const pad = 40;
    const width = Math.ceil(bounds.w + pad * 2);
    const height = Math.ceil(bounds.h + pad * 2);
    const clone = content.cloneNode(true) as SVGGElement;
    clone.setAttribute('transform', `translate(${pad - bounds.x} ${pad - bounds.y})`);
    clone.querySelectorAll('[data-ui-only]').forEach((node) => node.remove());
    const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#0d0d0d"/>${new XMLSerializer().serializeToString(clone)}</svg>`;
    const image = new Image();
    const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
    try {
      await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('Export failed.')); image.src = url; });
      const scale = Math.min(2, 8000 / Math.max(width, height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Export failed.');
      context.scale(scale, scale);
      context.drawImage(image, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('Export failed.');
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'omnilume-whiteboard.png';
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } catch (exportError) {
      setError(errorMessage(exportError));
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isEditableTarget(event.target)) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
    if (mod && key === 'y') { event.preventDefault(); redo(); return; }
    if (mod && key === 'd') { event.preventDefault(); duplicateSelection(); return; }
    if (mod && key === 'a') { event.preventDefault(); setTool('select'); setSelection(docRef.current.elements.map((element) => element.id)); return; }
    if (mod) return;
    if (event.key === 'Delete' || event.key === 'Backspace') { if (selection.length > 0) { event.preventDefault(); deleteSelection(); } return; }
    if (event.key === 'Escape') { setSelection([]); setDraft(null); interactionRef.current = null; return; }
    if (event.key === ' ') { event.preventDefault(); spaceHeldRef.current = true; setPanning(true); return; }
    if (event.key === '+' || event.key === '=') { zoomAt(1.2); return; }
    if (event.key === '-') { zoomAt(1 / 1.2); return; }
    if (event.key === '0') { setViewportBoth({ x: 0, y: 0, zoom: 1 }); return; }
    if (event.key === '1' && event.shiftKey) { fitToContent(); return; }
    if (event.key.startsWith('Arrow') && selection.length > 0) {
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
      const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
      applyLocal(selection.map((id) => findElement(id)).filter((element): element is WhiteboardElement => Boolean(element)).map((element) => ({ id: element.id, before: element, after: translateElement(element, dx, dy) })));
      return;
    }
    const match = TOOLS.find((entry) => entry.key.toLowerCase() === key);
    if (match) { setTool(match.tool); if (match.tool !== 'select') setSelection([]); }
  };

  const handleKeyUp = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === ' ') { spaceHeldRef.current = false; if (!interactionRef.current) setPanning(false); }
  };

  const selectedElements = useMemo(() => doc.elements.filter((element) => selection.includes(element.id)), [doc.elements, selection]);
  const selectionBounds = useMemo(() => unionBounds(selectedElements.map(elementBounds)), [selectedElements]);
  const resizable = selectedElements.length === 1 && ['rect', 'ellipse', 'note', 'text'].includes(selectedElements[0].kind);
  const editingId = editor?.id ?? null;
  const gridSize = 32 * viewport.zoom;
  const cursor = panning ? 'grabbing' : tool === 'hand' ? 'grab' : tool === 'select' ? 'default' : tool === 'text' ? 'text' : tool === 'eraser' ? 'cell' : 'crosshair';
  const statusLabel = status === 'loading' ? 'Loading whiteboard…'
    : status === 'saving' ? 'Saving…'
      : status === 'unsaved' ? 'Unsaved changes'
        : status === 'conflict' || status === 'error' ? (error ?? 'Unable to save.')
          : remoteNotice ? 'Updated by another member' : 'All changes saved';

  return (
    <section
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-neutral-800 bg-[#121212] outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60"
      aria-label="Shared room whiteboard"
      data-expected-version={expectedVersion}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-800 px-3 py-2">
        <div role="toolbar" aria-label="Whiteboard tools" className="flex flex-wrap items-center gap-1 rounded-lg bg-neutral-900/80 p-1">
          {TOOLS.map((entry) => (
            <button
              key={entry.tool}
              type="button"
              onClick={() => { setTool(entry.tool); if (entry.tool !== 'select') setSelection([]); }}
              aria-pressed={tool === entry.tool}
              title={`${entry.label} (${entry.key})`}
              aria-label={entry.label}
              className={`flex h-8 w-8 items-center justify-center rounded-md transition ${tool === entry.tool ? 'bg-indigo-600 text-white shadow' : 'text-neutral-400 hover:bg-neutral-800 hover:text-white'}`}
            >
              <svg aria-hidden="true" width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"><path d={entry.icon} /></svg>
            </button>
          ))}
        </div>

        <div role="group" aria-label="Color" className="flex items-center gap-1 rounded-lg bg-neutral-900/80 p-1">
          {(tool === 'note' ? NOTE_COLORS : COLORS).map((value) => {
            const active = tool === 'note' ? noteColor === value : color === value;
            return (
              <button
                key={value}
                type="button"
                aria-label={`Color ${value}`}
                aria-pressed={active}
                onClick={() => { if (tool === 'note') setNoteColor(value); else { setColor(value); if (selection.length > 0) restyleSelection({ color: value }); } }}
                className={`h-6 w-6 rounded-full border-2 transition ${active ? 'scale-110 border-white' : 'border-transparent hover:border-neutral-500'}`}
                style={{ backgroundColor: value }}
              />
            );
          })}
        </div>

        <div role="group" aria-label="Stroke width" className="flex items-center gap-1 rounded-lg bg-neutral-900/80 p-1">
          {WIDTHS.map((value) => (
            <button
              key={value}
              type="button"
              aria-label={`Stroke width ${value}`}
              aria-pressed={strokeWidth === value}
              onClick={() => { setStrokeWidth(value); if (selection.length > 0) restyleSelection({ width: value }); }}
              className={`flex h-7 w-7 items-center justify-center rounded-md ${strokeWidth === value ? 'bg-neutral-700' : 'hover:bg-neutral-800'}`}
            >
              <span className="rounded-full bg-neutral-200" style={{ width: Math.min(18, value + 2), height: Math.min(18, value + 2) }} />
            </button>
          ))}
          <button type="button" aria-pressed={fillShapes} onClick={() => setFillShapes((value) => !value)} title="Fill shapes" className={`ml-1 rounded-md px-2 py-1 text-[11px] font-bold ${fillShapes ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:bg-neutral-800'}`}>Fill</button>
        </div>

        {selection.length > 0 && (
          <div role="group" aria-label="Selection" className="flex items-center gap-1 rounded-lg bg-neutral-900/80 p-1 text-[11px] font-bold">
            <button type="button" onClick={duplicateSelection} className="rounded-md px-2 py-1 text-neutral-300 hover:bg-neutral-800" title="Duplicate (Ctrl+D)">Duplicate</button>
            <button type="button" onClick={deleteSelection} className="rounded-md px-2 py-1 text-red-300 hover:bg-red-500/10" title="Delete (Del)">Delete</button>
          </div>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-1">
          <button type="button" onClick={undo} disabled={!historyState.canUndo} title="Undo (Ctrl+Z)" aria-label="Undo" className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-800 disabled:opacity-30"><svg aria-hidden="true" width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></svg></button>
          <button type="button" onClick={redo} disabled={!historyState.canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo" className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-800 disabled:opacity-30"><svg aria-hidden="true" width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="m15 14 5-5-5-5" /><path d="M20 9H10a6 6 0 0 0 0 12h3" /></svg></button>
          <span className="mx-1 h-5 w-px bg-neutral-800" />
          <button type="button" onClick={() => zoomAt(1 / 1.2)} aria-label="Zoom out" className="h-8 w-8 rounded-md text-lg leading-none text-neutral-300 hover:bg-neutral-800">−</button>
          <button type="button" onClick={() => setViewportBoth({ x: 0, y: 0, zoom: 1 })} title="Reset zoom (0)" className="min-w-[3.25rem] rounded-md px-1 py-1 text-[11px] font-bold tabular-nums text-neutral-300 hover:bg-neutral-800">{Math.round(viewport.zoom * 100)}%</button>
          <button type="button" onClick={() => zoomAt(1.2)} aria-label="Zoom in" className="h-8 w-8 rounded-md text-lg leading-none text-neutral-300 hover:bg-neutral-800">+</button>
          <button type="button" onClick={fitToContent} title="Fit to content (Shift+1)" className="rounded-md px-2 py-1 text-[11px] font-bold text-neutral-300 hover:bg-neutral-800">Fit</button>
          <button type="button" aria-pressed={showGrid} onClick={() => setShowGrid((value) => !value)} className={`rounded-md px-2 py-1 text-[11px] font-bold ${showGrid ? 'text-white' : 'text-neutral-500'} hover:bg-neutral-800`}>Grid</button>
          <span className="mx-1 h-5 w-px bg-neutral-800" />
          <button type="button" onClick={() => void exportPng()} className="rounded-md px-2 py-1 text-[11px] font-bold text-neutral-300 hover:bg-neutral-800">Export PNG</button>
          <button type="button" onClick={clearBoard} className="rounded-md px-2 py-1 text-[11px] font-bold text-red-300 hover:bg-red-500/10">Clear</button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-[#0d0d0d]">
        <svg
          ref={svgRef}
          className="absolute inset-0 h-full w-full touch-none select-none"
          style={{ cursor }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishInteraction}
          onPointerCancel={finishInteraction}
          onDoubleClick={handleDoubleClick}
          role="application"
          aria-label="Whiteboard canvas. Use the toolbar or keyboard shortcuts to draw."
        >
          {showGrid && (
            <>
              <defs>
                <pattern id={`wb-grid-${roomId}`} width={gridSize} height={gridSize} patternUnits="userSpaceOnUse" x={viewport.x % gridSize} y={viewport.y % gridSize}>
                  <circle cx={1} cy={1} r={1} fill="#2a2a2a" />
                </pattern>
              </defs>
              <rect width="100%" height="100%" fill={`url(#wb-grid-${roomId})`} pointerEvents="none" />
            </>
          )}
          <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}>
            <g data-board-content>
              {doc.legacyImage && <image href={doc.legacyImage} x={0} y={0} width={960} height={600} preserveAspectRatio="xMinYMin meet" pointerEvents="none" />}
              {doc.elements.map((element) => (
                <g key={element.id} data-el-id={element.id} opacity={editingId === element.id && element.kind === 'text' ? 0 : 1}>
                  <ElementShape element={element} zoom={viewport.zoom} />
                </g>
              ))}
              {draft && <g pointerEvents="none"><ElementShape element={draft} zoom={viewport.zoom} /></g>}
            </g>
            {selectionBounds && (
              <g data-ui-only pointerEvents="none">
                <rect x={selectionBounds.x - 6 / viewport.zoom} y={selectionBounds.y - 6 / viewport.zoom} width={selectionBounds.w + 12 / viewport.zoom} height={selectionBounds.h + 12 / viewport.zoom} fill="none" stroke="#818cf8" strokeWidth={1.5 / viewport.zoom} strokeDasharray={`${6 / viewport.zoom} ${4 / viewport.zoom}`} rx={4 / viewport.zoom} />
                {resizable && (
                  <rect data-resize-handle pointerEvents="all" x={selectionBounds.x + selectionBounds.w + 6 / viewport.zoom - 6 / viewport.zoom} y={selectionBounds.y + selectionBounds.h + 6 / viewport.zoom - 6 / viewport.zoom} width={12 / viewport.zoom} height={12 / viewport.zoom} rx={3 / viewport.zoom} fill="#818cf8" stroke="#0d0d0d" strokeWidth={2 / viewport.zoom} style={{ cursor: 'nwse-resize' }} />
                )}
              </g>
            )}
          </g>
        </svg>
        {cursors.overlay}
        {cursors.activeCount > 0 && <p className="wb-cursor-count" aria-live="polite">{cursors.activeCount} other{cursors.activeCount === 1 ? '' : 's'} on the board</p>}

        {editor && (
          <textarea
            autoFocus
            value={editor.value}
            maxLength={WHITEBOARD_TEXT_MAX_CHARS}
            aria-label={editor.kind === 'note' ? 'Sticky note text' : 'Whiteboard text'}
            placeholder={editor.kind === 'note' ? 'Write a note…' : 'Type text…'}
            onChange={(event) => setEditor((current) => current ? { ...current, value: event.target.value } : current)}
            onBlur={commitEditor}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Escape') { if (editor.isNew && editor.kind === 'text') setEditor(null); else commitEditor(); }
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) commitEditor();
            }}
            className="absolute z-20 resize-none overflow-hidden rounded-md border border-indigo-500/60 p-0 leading-tight outline-none"
            style={{
              left: viewport.x + editor.x * viewport.zoom,
              top: viewport.y + editor.y * viewport.zoom,
              width: editor.w * viewport.zoom,
              height: editor.h * viewport.zoom,
              fontSize: editor.size * viewport.zoom,
              padding: editor.kind === 'note' ? 12 * viewport.zoom : 2,
              color: editor.kind === 'note' ? '#18181b' : color,
              background: editor.kind === 'note' ? (doc.elements.find((element) => element.id === editor.id)?.color ?? noteColor) : 'rgba(13,13,13,0.85)',
              fontWeight: editor.kind === 'text' ? 600 : 400,
            }}
          />
        )}

        {status !== 'loading' && doc.elements.length === 0 && !doc.legacyImage && !draft && !editor && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm font-bold text-neutral-400">This board is empty</p>
            <p className="max-w-xs text-xs text-neutral-600">Pick a tool and start drawing. Everyone in the room sees your changes. Press V to select, Space to pan and Ctrl + scroll to zoom.</p>
          </div>
        )}

        <div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-2 rounded-full border border-neutral-800 bg-black/70 px-3 py-1.5 text-[11px] backdrop-blur" aria-live="polite">
          <span className={`h-2 w-2 rounded-full ${status === 'saved' ? 'bg-emerald-400' : status === 'error' || status === 'conflict' ? 'bg-amber-400' : 'bg-indigo-400 animate-pulse'}`} />
          <span className={status === 'error' || status === 'conflict' ? 'text-amber-300' : 'text-neutral-400'}>{statusLabel}</span>
        </div>
        {(status === 'error' || status === 'conflict') && (
          <button type="button" onClick={() => { void load('manual').then(() => setSaveTick((tick) => tick + 1)); }} className="absolute bottom-3 right-3 rounded-full bg-amber-500/20 px-3 py-1.5 text-[11px] font-bold text-amber-200 hover:bg-amber-500/30">Retry</button>
        )}
      </div>
    </section>
  );
}
