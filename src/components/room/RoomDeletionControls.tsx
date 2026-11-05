'use client';

import { useState } from 'react';
import { cancelRoomDeletion, scheduleRoomDeletion } from '@/actions/recovery';

// Master plan §9, permanent rooms: they never expire on their own; the owner
// schedules deletion with a 7–14 day grace period and can cancel it. The RPCs
// enforce owner-only, permanent-only and the grace bounds.
export default function RoomDeletionControls({
  roomId,
  expirationType,
  deletionScheduledAt,
  isOwner,
  onChanged,
}: {
  roomId: string;
  expirationType: string;
  deletionScheduledAt: string | null;
  isOwner: boolean;
  onChanged: (deletionScheduledAt: string | null) => void;
}) {
  const [graceDays, setGraceDays] = useState(7);
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (expirationType !== 'permanent') return null;

  const schedule = async () => {
    setWorking(true);
    setError(null);
    const result = await scheduleRoomDeletion(roomId, graceDays);
    setWorking(false);
    setConfirming(false);
    if (!result.success) { setError(result.error ?? 'Unable to schedule deletion.'); return; }
    onChanged(result.deletionScheduledAt ?? null);
  };

  const cancel = async () => {
    setWorking(true);
    setError(null);
    const result = await cancelRoomDeletion(roomId);
    setWorking(false);
    if (!result.success) { setError(result.error ?? 'Unable to cancel deletion.'); return; }
    onChanged(null);
  };

  const scheduledLabel = deletionScheduledAt
    ? new Date(deletionScheduledAt).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' })
    : null;

  return (
    <section className="rounded-2xl border border-red-500/20 bg-red-500/[0.04] p-4" aria-labelledby="room-deletion-heading">
      <h3 id="room-deletion-heading" className="font-semibold text-white">Delete this room</h3>
      {scheduledLabel ? (
        <p className="mt-1 text-sm text-red-200">Scheduled for deletion on {scheduledLabel}. Members were notified.</p>
      ) : (
        <p className="mt-1 text-sm text-neutral-500">Permanent rooms never expire. Scheduling deletion gives members a grace period before all chats and files are permanently deleted.</p>
      )}
      {!isOwner ? (
        <p className="mt-3 text-xs text-neutral-500">Only the room owner can schedule or cancel deletion.</p>
      ) : scheduledLabel ? (
        <button type="button" onClick={() => void cancel()} disabled={working} className="omni-button omni-button-ghost mt-3 !min-h-0 !px-3 !py-2 text-xs">
          {working ? 'Cancelling…' : 'Cancel deletion'}
        </button>
      ) : confirming ? (
        <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label="Confirm deletion schedule">
          <span className="text-xs text-red-200">Delete everything after {graceDays} days unless cancelled?</span>
          <button type="button" onClick={() => void schedule()} disabled={working} className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-red-500 disabled:opacity-50">{working ? 'Scheduling…' : 'Confirm'}</button>
          <button type="button" onClick={() => setConfirming(false)} disabled={working} className="rounded-lg px-3 py-1.5 text-xs font-bold text-neutral-300 hover:bg-white/5">Back</button>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label htmlFor="room-deletion-grace" className="text-xs text-neutral-400">Grace period</label>
          <select id="room-deletion-grace" value={graceDays} onChange={(event) => setGraceDays(Number(event.target.value))} className="omni-select !min-h-0 !w-auto !py-1.5 text-xs">
            <option value={7}>7 days</option>
            <option value={10}>10 days</option>
            <option value={14}>14 days</option>
          </select>
          <button type="button" onClick={() => setConfirming(true)} className="rounded-lg border border-red-500/50 px-3 py-1.5 text-xs font-bold text-red-200 hover:bg-red-500/10">Schedule deletion</button>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-red-300">{error}</p>}
    </section>
  );
}
