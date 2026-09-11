'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefCallback,
} from 'react';

interface RoomPanelResizeOptions {
  minHeight: number;
  maxHeight?: number;
}

interface RoomPanelResizeResult {
  panelRef: RefCallback<HTMLDivElement>;
  panelHeight: number | null;
  isResizing: boolean;
  handlePointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  handlePointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  handlePointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  handleKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}

function isMobileLayout() {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 700px)').matches;
}

export function useRoomPanelResize(
  roomId: string,
  storageKey: string,
  { minHeight, maxHeight }: RoomPanelResizeOptions,
): RoomPanelResizeResult {
  const panelNodeRef = useRef<HTMLDivElement>(null);
  const panelRef = useCallback((node: HTMLDivElement | null) => {
    panelNodeRef.current = node;
  }, []);
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const [panelHeight, setPanelHeight] = useState<number | null>(null);
  const [isResizing, setIsResizing] = useState(false);

  const clampHeight = useCallback((height: number) => {
    const parentHeight = panelNodeRef.current?.parentElement?.clientHeight ?? window.innerHeight;
    const viewportLimit = Math.max(minHeight, window.innerHeight - 132);
    const upperBound = Math.max(minHeight, Math.min(maxHeight ?? viewportLimit, parentHeight || viewportLimit, viewportLimit));
    return Math.round(Math.min(upperBound, Math.max(minHeight, height)));
  }, [maxHeight, minHeight]);

  const setClampedHeight = useCallback((height: number) => {
    setPanelHeight(clampHeight(height));
  }, [clampHeight]);

  useEffect(() => {
    if (!roomId) return;
    const timer = window.setTimeout(() => {
      const saved = window.localStorage.getItem(`omnilume:room:${roomId}:${storageKey}`);
      const parsed = saved ? Number(saved) : NaN;
      if (Number.isFinite(parsed)) setPanelHeight(clampHeight(parsed));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [clampHeight, roomId, storageKey]);

  useEffect(() => {
    if (!roomId || panelHeight === null) return;
    window.localStorage.setItem(`omnilume:room:${roomId}:${storageKey}`, String(panelHeight));
  }, [panelHeight, roomId, storageKey]);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (isMobileLayout() || !panelNodeRef.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: panelNodeRef.current.getBoundingClientRect().height,
    };
    setIsResizing(true);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setClampedHeight(drag.startHeight + event.clientY - drag.startY);
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setIsResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isMobileLayout()) return;
    const currentHeight = panelNodeRef.current?.getBoundingClientRect().height ?? panelHeight ?? minHeight;
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setClampedHeight(currentHeight - 40);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setClampedHeight(currentHeight + 40);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setClampedHeight(minHeight);
    } else if (event.key === 'End') {
      event.preventDefault();
      setClampedHeight(maxHeight ?? window.innerHeight - 132);
    }
  };

  return {
    panelRef,
    panelHeight,
    isResizing,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handleKeyDown,
  };
}
