// Six chairs (hostel phase 14): who holds a seat in voice. Pure, so it is unit tested.
//
// Voice is a full mesh (voice-mesh.ts): every member in voice, with a mic or
// watch-only, holds one peer connection to every other member. A shared tab
// rides on the same mesh, so this one cap covers voice and tab-share viewers.

// Full-mesh limit: 7+ phones in one mesh break the call. Raising it needs the
// parked SFU relay (roadmap tripwire: birthday rooms needing more than 6 mics).
export const VOICE_CHAIRS = 6;

export type SeatMember = { id: string; at?: number };

export const chairsTakenMessage = (cap: number) =>
  `All ${cap} chairs are taken. You're on the floor: chat along, and you'll get a chair when one frees up.`;
export const screenFullMessage = (cap: number) => `Screen is full (${cap} watching).`;

// The first `cap` members by join time (`at`, ms) hold the chairs. A member
// without `at` is an older client and is treated as already seated, so it
// sorts first; ties break by id, so every member computes the same set.
export function seatedIds(members: SeatMember[], cap: number): Set<string> {
  const order = [...members].sort((x, y) => {
    const ax = x.at ?? -Infinity;
    const ay = y.at ?? -Infinity;
    if (ax !== ay) return ax < ay ? -1 : 1;
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  });
  return new Set(order.slice(0, Math.max(0, cap)).map((member) => member.id));
}

export function isFull(count: number, cap: number) {
  return count >= cap;
}

// "Take the next chair" on the floor, when the members in voice change:
// - 'give-up': waiting to watch a share that has since ended; nothing left to wait for;
// - 'wait': still full;
// - 'ask': looks free, but nobody was heard lately (our own connection may be
//   down, so silence is not a free chair): ask `who` again instead of joining;
// - 'join': a chair is free and the room is known to be live.
export function nextChairStep(view: { count: number; cap: number; watchOnly: boolean; shareLive: boolean; connected: boolean; heardAgoMs: number; timeoutMs: number }) {
  if (view.watchOnly && !view.shareLive) return 'give-up' as const;
  if (isFull(view.count, view.cap)) return 'wait' as const;
  if (!view.connected || view.heardAgoMs > view.timeoutMs) return 'ask' as const;
  return 'join' as const;
}

// Drops members whose last `hello` is older than `timeoutMs`; true when any went.
export function pruneSeen(seen: Map<string, { at?: number; seen: number }>, now: number, timeoutMs: number) {
  let changed = false;
  for (const [id, entry] of seen) if (now - entry.seen > timeoutMs) { seen.delete(id); changed = true; }
  return changed;
}
