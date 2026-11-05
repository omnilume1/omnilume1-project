'use client';

import { useEffect, useRef, useState } from 'react';
import { convertRoomToGroup } from '@/actions/rooms';

export type ConversionResult = { groupId: string; name: string; alreadyConverted: boolean; memberCount: number };

// Room-to-group conversion (Action 14). The decision is the owner's; the
// database re-checks everything and either converts everything or nothing.
// Failures are shown as text with Retry, and a repeated confirm is safe
// (the conversion is idempotent).
export default function RoomConversionDialog({ roomId, roomName, onClose, onConverted }: {
  roomId: string;
  roomName: string;
  onClose: () => void;
  onConverted: (result: ConversionResult) => void;
}) {
  const [state, setState] = useState<'confirm' | 'working' | 'done'>('confirm');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ConversionResult | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);

  useEffect(() => { cancelRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && state !== 'working') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, state]);

  const confirm = async () => {
    // A ref, not state: two clicks in the same tick must send one request.
    if (inFlight.current || state === 'working') return;
    inFlight.current = true;
    setState('working'); setError(null);
    const outcome = await convertRoomToGroup(roomId);
    inFlight.current = false;
    if (!outcome.ok) { setError(outcome.error); setState('confirm'); return; }
    setResult(outcome.data); setState('done');
    onConverted(outcome.data);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && state !== 'working') onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="convert-title" aria-describedby="convert-desc" className="w-full max-w-md rounded-2xl border border-indigo-900/50 bg-[#0a0a0a] p-6 shadow-2xl">
        {state === 'done' && result ? (
          <>
            <h2 id="convert-title" className="text-lg font-bold text-white">{result.alreadyConverted ? 'Already a group' : 'Converted to a group'}</h2>
            <p id="convert-desc" className="mt-2 text-sm text-neutral-300" role="status">“{result.name}” is now a group with {result.memberCount} member{result.memberCount === 1 ? '' : 's'}. Everyone was notified.</p>
            <button type="button" className="omni-button omni-button-primary mt-5 w-full" onClick={onClose} autoFocus>Done</button>
          </>
        ) : (
          <>
            <h2 id="convert-title" className="text-lg font-bold text-white">Convert “{roomName}” to a group?</h2>
            <p id="convert-desc" className="mt-2 text-sm text-neutral-400">This keeps the room and makes it a permanent group with the same name.</p>
            <ul className="convert-dialog-list">
              <li><strong>Kept:</strong> approved members and their roles, chat history, files, notes and room permissions.</li>
              <li><strong>Changes:</strong> the self-destruct timer stops, the room becomes private and closed to new joins, invites are revoked, and its custom link is removed. A group has no public username or link.</li>
              <li>Guests, banned or blocked people and pending requests are not carried over.</li>
              <li>Encrypted messages are not touched.</li>
            </ul>
            {error && <p role="alert" className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</p>}
            <div className="flex gap-3">
              <button ref={cancelRef} type="button" className="omni-button omni-button-ghost flex-1" onClick={onClose} disabled={state === 'working'}>Cancel</button>
              <button type="button" className="omni-button omni-button-primary flex-1" onClick={() => void confirm()} disabled={state === 'working'} aria-busy={state === 'working'}>{state === 'working' ? 'Converting…' : error ? 'Retry' : 'Convert to group'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
