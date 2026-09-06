export type MinimizedRoom = {
  id: string;
  name: string;
  username: string | null;
};

const STORAGE_KEY = 'omnilume:minimized-room-ids';

function readIds() {
  if (typeof window === 'undefined') return [] as string[];
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function minimizeRoom(roomId: string) {
  const ids = readIds();
  if (!ids.includes(roomId)) window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids, roomId]));
}

export function restoreMinimizedRoom(roomId: string) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(readIds().filter((id) => id !== roomId)));
}

export function getMinimizedRoomIds() {
  return readIds();
}
