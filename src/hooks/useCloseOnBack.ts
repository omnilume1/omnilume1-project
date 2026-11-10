'use client';

import { useEffect, useRef } from 'react';

interface CloseWatcherLike { onclose: (() => void) | null; destroy(): void }

/**
 * Android back closes an open popover, sheet or full-screen player instead of leaving the page.
 * Uses the platform's CloseWatcher (Chrome 120+, so every phone the Android app runs on): no
 * history entries, so links inside the surface still navigate normally. Touch devices only,
 * because on a desktop the same API would add an Esc shortcut that is not there today.
 */
export function useCloseOnBack(open: boolean, close: () => void) {
  const closeRef = useRef(close);
  useEffect(() => { closeRef.current = close; });
  useEffect(() => {
    if (!open) return;
    const Watcher = (window as unknown as { CloseWatcher?: new () => CloseWatcherLike }).CloseWatcher;
    if (!Watcher || !window.matchMedia('(pointer: coarse)').matches) return;
    let watcher: CloseWatcherLike;
    try { watcher = new Watcher(); } catch { return; }
    watcher.onclose = () => closeRef.current();
    return () => watcher.destroy();
  }, [open]);
}
