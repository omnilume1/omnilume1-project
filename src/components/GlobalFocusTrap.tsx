'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  FOCUS_LOCK_EVENT,
  clearFocusLock,
  getRemainingSeconds,
  readFocusLock,
  type FocusLockState,
} from '@/lib/focus-lock';

function hideLeaveControls(hidden: boolean) {
  if (typeof document === 'undefined') return;

  document.querySelectorAll<HTMLElement>('[data-room-leave]').forEach((element) => {
    element.hidden = hidden;
    element.setAttribute('aria-hidden', hidden ? 'true' : 'false');
  });
}

export default function GlobalFocusTrap() {
  const router = useRouter();
  const pathname = usePathname();
  // Read localStorage after hydration so the server and browser produce the
  // same initial markup.
  const [lock, setLock] = useState<FocusLockState | null>(null);

  const refreshLock = useCallback(() => {
    setLock(readFocusLock());
  }, []);

  useEffect(() => {
    const initialRefresh = window.setTimeout(refreshLock, 0);
    const refreshInterval = window.setInterval(refreshLock, 1_000);
    const handleStorage = () => refreshLock();
    window.addEventListener('storage', handleStorage);
    window.addEventListener(FOCUS_LOCK_EVENT, handleStorage);

    return () => {
      window.clearInterval(refreshInterval);
      window.clearTimeout(initialRefresh);
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(FOCUS_LOCK_EVENT, handleStorage);
    };
  }, [refreshLock]);

  useEffect(() => {
    if (!lock || !pathname) return;
    if (pathname !== lock.roomPath) router.replace(lock.roomPath);
  }, [lock, pathname, router]);

  useEffect(() => {
    if (!lock) {
      hideLeaveControls(false);
      return;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = 'Focus Lock is active. You will return to this room until the lock expires.';
    };

    const handlePopState = () => {
      const currentLock = readFocusLock();
      if (currentLock) router.replace(currentLock.roomPath);
    };

    hideLeaveControls(true);
    const observer = new MutationObserver(() => hideLeaveControls(true));
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('popstate', handlePopState);

    return () => {
      observer.disconnect();
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('popstate', handlePopState);
      hideLeaveControls(false);
    };
  }, [lock, router]);

  useEffect(() => {
    if (lock && getRemainingSeconds(lock.expiresAt) === 0) clearFocusLock();
  }, [lock]);

  // The active lock is intentionally represented by the room's mini timer.
  return null;
}
