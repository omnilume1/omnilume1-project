export const FOCUS_LOCK_STORAGE_KEY = 'omnilume_focus_lock';
export const FOCUS_LOCK_EVENT = 'omnilume-focus-lock-change';
export const FOCUS_LOCK_DURATION_MS = 60 * 60 * 1_000;

export type FocusLockState = {
  roomPath: string;
  roomId: string;
  expiresAt: number;
};

function notifyFocusLockChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(FOCUS_LOCK_EVENT));
}

export function readFocusLock(): FocusLockState | null {
  if (typeof window === 'undefined') return null;

  try {
    const raw = window.localStorage.getItem(FOCUS_LOCK_STORAGE_KEY);
    if (!raw) return null;
    const lock = JSON.parse(raw) as Partial<FocusLockState>;
    if (
      typeof lock.roomPath !== 'string'
      || typeof lock.roomId !== 'string'
      || typeof lock.expiresAt !== 'number'
      || !Number.isFinite(lock.expiresAt)
    ) {
      window.localStorage.removeItem(FOCUS_LOCK_STORAGE_KEY);
      return null;
    }

    if (lock.expiresAt <= Date.now()) {
      window.localStorage.removeItem(FOCUS_LOCK_STORAGE_KEY);
      return null;
    }

    return {
      roomPath: lock.roomPath,
      roomId: lock.roomId,
      expiresAt: lock.expiresAt,
    };
  } catch {
    return null;
  }
}

export function activateFocusLock(roomId: string, roomPath: string) {
  if (typeof window === 'undefined') return null;

  const lock: FocusLockState = {
    roomId,
    roomPath,
    expiresAt: Date.now() + FOCUS_LOCK_DURATION_MS,
  };
  window.localStorage.setItem(FOCUS_LOCK_STORAGE_KEY, JSON.stringify(lock));
  notifyFocusLockChanged();
  return lock;
}

export function clearFocusLock() {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(FOCUS_LOCK_STORAGE_KEY);
  notifyFocusLockChanged();
}

export function formatCountdown(totalSeconds: number) {
  const safeSeconds = Math.max(0, Math.ceil(totalSeconds));
  const hours = Math.floor(safeSeconds / 3_600);
  const minutes = Math.floor((safeSeconds % 3_600) / 60);
  const seconds = safeSeconds % 60;
  return [hours, minutes, seconds].map((part) => part.toString().padStart(2, '0')).join(':');
}

export function getRemainingSeconds(expiresAt: number, now = Date.now()) {
  return Math.max(0, Math.ceil((expiresAt - now) / 1_000));
}
