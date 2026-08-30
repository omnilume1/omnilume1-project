'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  FOCUS_LOCK_EVENT,
  clearFocusLock,
  formatCountdown,
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
  const [lock, setLock] = useState<FocusLockState | null>(() => readFocusLock());

  const refreshLock = useCallback(() => {
    const nextLock = readFocusLock();
    setLock(nextLock);
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

  if (!lock) return null;

  return (
    <div className="pointer-events-none fixed left-0 top-1/2 z-[9999] -translate-y-1/2 select-none">
      <div
        className="flex items-center justify-center rounded-r-xl border border-red-400/30 bg-red-500 px-2 py-6 text-[10px] font-black uppercase tracking-widest text-black shadow-[4px_0_20px_rgba(239,68,68,0.3)]"
        style={{ writingMode: 'vertical-lr', transform: 'rotate(180deg)' }}
      >
        Focus Lock · {formatCountdown(getRemainingSeconds(lock.expiresAt))}
      </div>
    </div>
  );
}
