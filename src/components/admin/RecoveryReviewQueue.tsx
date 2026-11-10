'use client';

import { useCallback, useEffect, useState } from 'react';
import { getRecoveryReviewQueue, reviewRoomRecovery, type RecoveryReviewItem } from '@/actions/recovery';
import { recoveryRequestLapsesAt } from '@/lib/room-deletion-policy';

type Decision = 'approved' | 'rejected';

function formatDate(value: string | null) {
  if (!value) return 'Unknown';
  return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function timeLeft(until: number, now: number) {
  const hours = Math.floor((until - now) / 3_600_000);
  const days = Math.floor(hours / 24);
  return days >= 1 ? `${days}d ${hours % 24}h` : `${Math.max(1, hours)}h`;
}

// Time left in the 7-day window; a request filed in time keeps the room held
// (and reviewable) after the window ends, until the request itself lapses.
function windowLabel(windowEndsAt: string | null, now: number) {
  if (!windowEndsAt) return 'Unknown';
  const end = new Date(windowEndsAt).getTime();
  return end <= now ? 'Window ended — held by this request' : `${timeLeft(end, now)} left`;
}

// An unanswered request lapses 7 days after it was filed; the room is then
// deleted at the next daily cleanup.
function lapseLabel(requestedAt: string, now: number) {
  const lapse = recoveryRequestLapsesAt(requestedAt).getTime();
  return lapse <= now ? 'Lapsed — the room will be deleted' : `in ${timeLeft(lapse, now)}, then the room is deleted`;
}

export default function RecoveryReviewQueue({ initialRequests, initialError }: { initialRequests: RecoveryReviewItem[]; initialError: string | null }) {
  const [requests, setRequests] = useState(initialRequests);
  const [error, setError] = useState<string | null>(initialError);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ id: string; decision: Decision } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    const result = await getRecoveryReviewQueue();
    if (result.success) { setRequests(result.requests); setError(null); }
    else setError(result.error ?? 'Unable to load recovery requests.');
    setLoading(false);
  }, []);

  const decide = async (item: RecoveryReviewItem, decision: Decision) => {
    setWorking(item.request_id);
    setNotice(null);
    setError(null);
    const result = await reviewRoomRecovery(item.request_id, decision);
    setWorking(null);
    setConfirming(null);
    if (!result.success) {
      setError(result.error ?? 'Unable to review this request.');
      return;
    }
    setNotice(decision === 'approved'
      ? `"${item.room_name}" was reopened for 7 days. The requester${item.other_pending ? 's were' : ' was'} notified.`
      : `The request for "${item.room_name}" was rejected and the requester was notified.`);
    await reload();
  };

  return (
    <section className="glass-card-ambient space-y-4 p-5" aria-labelledby="recovery-queue-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="recovery-queue-heading" className="text-lg font-semibold text-white">Pending recovery requests</h2>
          <p className="text-xs text-neutral-400">Only recoverable rooms appear here. Irreversible rooms can never be restored.</p>
        </div>
        <button type="button" onClick={() => void reload()} disabled={loading} className="omni-button omni-button-ghost !min-h-0 !px-3 !py-2 text-xs">
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div aria-live="polite">
        {notice && <p className="rounded-lg border border-emerald-700/40 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300">{notice}</p>}
      </div>
      {error && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-300">
          <span>{error}</span>
          <button type="button" onClick={() => void reload()} className="font-bold underline">Retry</button>
        </div>
      )}

      {requests.length === 0 && !error ? (
        <p className="rounded-xl border border-dashed border-neutral-800 px-4 py-8 text-center text-sm text-neutral-500">No pending recovery requests.</p>
      ) : (
        <ul className="space-y-3">
          {requests.map((item) => {
            const isConfirming = confirming?.id === item.request_id;
            const busy = working === item.request_id;
            return (
              <li key={item.request_id} className="rounded-xl border border-neutral-800 bg-black/30 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-white" title={item.room_name}>{item.room_name}</p>
                    <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-neutral-400 sm:grid-cols-2">
                      <div><dt className="inline text-neutral-500">Expired: </dt><dd className="inline">{formatDate(item.room_expired_at)}</dd></div>
                      <div><dt className="inline text-neutral-500">Requested by: </dt><dd className="inline">{item.requester_label}</dd></div>
                      <div><dt className="inline text-neutral-500">Recovery window: </dt><dd className="inline">{windowLabel(item.window_ends_at, now)}</dd></div>
                      <div><dt className="inline text-neutral-500">Requested: </dt><dd className="inline">{formatDate(item.requested_at)}</dd></div>
                      <div className="sm:col-span-2"><dt className="inline text-neutral-500">Lapses if unanswered: </dt><dd className="inline text-amber-300">{lapseLabel(item.requested_at, now)}</dd></div>
                    </dl>
                    {item.other_pending > 0 && <p className="mt-2 text-[11px] text-indigo-300">{item.other_pending} other member{item.other_pending === 1 ? '' : 's'} also asked for this room. Approving answers all of them.</p>}
                  </div>
                  {isConfirming ? (
                    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirm decision">
                      <span className="text-xs text-neutral-300">{confirming.decision === 'approved' ? 'Reopen this room for 7 days?' : 'Reject this request?'}</span>
                      <button type="button" disabled={busy} onClick={() => void decide(item, confirming.decision)} className={`rounded-lg px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50 ${confirming.decision === 'approved' ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-red-600 hover:bg-red-500'}`}>
                        {busy ? 'Saving…' : 'Confirm'}
                      </button>
                      <button type="button" disabled={busy} onClick={() => setConfirming(null)} className="rounded-lg px-3 py-1.5 text-xs font-bold text-neutral-300 hover:bg-white/5">Cancel</button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <button type="button" disabled={Boolean(working)} onClick={() => setConfirming({ id: item.request_id, decision: 'approved' })} className="rounded-lg bg-emerald-700/80 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-600 disabled:opacity-50">Approve</button>
                      <button type="button" disabled={Boolean(working)} onClick={() => setConfirming({ id: item.request_id, decision: 'rejected' })} className="rounded-lg bg-red-800/70 px-3 py-1.5 text-xs font-bold text-white hover:bg-red-700 disabled:opacity-50">Reject</button>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
