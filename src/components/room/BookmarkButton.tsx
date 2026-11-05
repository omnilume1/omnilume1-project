'use client';

import { useCallback, useEffect, useState } from 'react';
import { listBookmarkedIds, setBookmark, type BookmarkKind } from '@/lib/management-data';

// Saved content (Action 13). The saved set is the caller's own rows (RLS);
// saving is validated again by set_room_bookmark (room access + capability +
// the item really belongs to this room).
export function useBookmarks(kind: BookmarkKind, roomId?: string) {
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void listBookmarkedIds(kind, roomId).then((result) => { if (active && result.ok) setSaved(new Set(result.data)); });
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [kind, roomId]);

  const toggle = useCallback(async (room: string, entityId: string) => {
    const next = !saved.has(entityId);
    setBusy(entityId); setError(null);
    const result = await setBookmark(room, kind, entityId, next);
    setBusy(null);
    if (!result.ok) { setError(result.error); return false; }
    setSaved((current) => { const copy = new Set(current); if (next) copy.add(entityId); else copy.delete(entityId); return copy; });
    return true;
  }, [kind, saved]);

  return { saved, busy, error, toggle };
}

export function BookmarkToggle({ roomId, kind, entityId, className = 'omni-button omni-button-ghost', labels = ['Save', 'Saved'], subject = 'item' }: {
  roomId: string; kind: BookmarkKind; entityId: string; className?: string; labels?: [string, string]; subject?: string;
}) {
  const { saved, busy, error, toggle } = useBookmarks(kind, kind === 'room' ? undefined : roomId);
  const isSaved = saved.has(entityId);
  return (
    <>
      <button type="button" className={className} aria-pressed={isSaved} disabled={busy === entityId}
        aria-label={isSaved ? `Remove this ${subject} from saved` : `Save this ${subject}`}
        onClick={() => void toggle(roomId, entityId)}>
        {isSaved ? labels[1] : labels[0]}
      </button>
      {error && <span role="alert" className="sr-only">{error}</span>}
    </>
  );
}
