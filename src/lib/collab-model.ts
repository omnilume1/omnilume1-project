// Action 12 pure helpers (no imports): study history statistics, poll
// percentages, countdowns, the WebRTC "who offers" rule, YouTube ids and a
// throttle for ephemeral cursor events. Unit-tested in tests/collab.test.ts.

export type StudySessionRow = { subject: string; duration_minutes: number; created_at: string };

export type StudyStats = {
  totalMinutes: number;
  sessions: number;
  longestMinutes: number;
  todayMinutes: number;
  weekMinutes: number;
  currentStreakDays: number;
  bestStreakDays: number;
  bySubject: Array<{ subject: string; minutes: number; share: number }>;
};

function localDayKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

// Streaks count consecutive local calendar days with at least one session.
// The current streak still counts when today has no session yet but
// yesterday did (the day is not over).
export function studyStats(rows: StudySessionRow[], now = new Date()): StudyStats {
  const days = new Set<string>();
  const subjects = new Map<string, number>();
  let totalMinutes = 0;
  let longestMinutes = 0;
  let todayMinutes = 0;
  let weekMinutes = 0;
  const todayKey = localDayKey(now);
  const weekStart = addDays(now, -6);
  weekStart.setHours(0, 0, 0, 0);
  for (const row of rows) {
    const minutes = Number.isFinite(row.duration_minutes) ? Math.max(0, row.duration_minutes) : 0;
    const at = new Date(row.created_at);
    if (Number.isNaN(at.getTime())) continue;
    totalMinutes += minutes;
    longestMinutes = Math.max(longestMinutes, minutes);
    const key = localDayKey(at);
    days.add(key);
    if (key === todayKey) todayMinutes += minutes;
    if (at >= weekStart && at <= now) weekMinutes += minutes;
    const subject = row.subject.trim() || 'Untitled';
    subjects.set(subject, (subjects.get(subject) ?? 0) + minutes);
  }
  let currentStreakDays = 0;
  let cursor = days.has(todayKey) ? now : addDays(now, -1);
  while (days.has(localDayKey(cursor))) {
    currentStreakDays += 1;
    cursor = addDays(cursor, -1);
  }
  let bestStreakDays = 0;
  for (const key of days) {
    const [y, m, d] = key.split('-').map(Number);
    const start = new Date(y, m - 1, d);
    if (days.has(localDayKey(addDays(start, -1)))) continue; // not the first day of a run
    let length = 0;
    let day = start;
    while (days.has(localDayKey(day))) { length += 1; day = addDays(day, 1); }
    bestStreakDays = Math.max(bestStreakDays, length);
  }
  const bySubject = [...subjects.entries()]
    .map(([subject, minutes]) => ({ subject, minutes, share: totalMinutes > 0 ? minutes / totalMinutes : 0 }))
    .sort((a, b) => b.minutes - a.minutes || a.subject.localeCompare(b.subject));
  return { totalMinutes, sessions: rows.length, longestMinutes, todayMinutes, weekMinutes, currentStreakDays, bestStreakDays, bySubject };
}

// Whole percentages that always add up to 100 (largest remainder).
export function pollPercentages(counts: number[]): number[] {
  const total = counts.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (total === 0) return counts.map(() => 0);
  const exact = counts.map((value) => (Math.max(0, value) / total) * 100);
  const floors = exact.map(Math.floor);
  let remainder = 100 - floors.reduce((sum, value) => sum + value, 0);
  const order = exact.map((value, index) => ({ index, fraction: value - Math.floor(value) })).sort((a, b) => b.fraction - a.fraction);
  for (const { index } of order) {
    if (remainder <= 0) break;
    floors[index] += 1;
    remainder -= 1;
  }
  return floors;
}

export function countdownRemaining(endsAt: string, now = Date.now()) {
  const end = new Date(endsAt).getTime();
  if (Number.isNaN(end)) return 0;
  return Math.max(0, Math.ceil((end - now) / 1000));
}

// Exactly one side of every voice pair creates the offer, so two members who
// join at the same moment never both offer ("glare").
export function shouldInitiateOffer(myId: string, peerId: string) {
  return myId < peerId;
}

// A shared tab is encoded once per watcher (peer-to-peer mesh), so the host's
// video upload is capped in total (23 Mbps of video; with stereo tab sound
// and packet overhead about 25 Mbps on the wire) and split between the
// members actually watching: 10 Mbps each for one or two, 4.6 Mbps each for
// five. Resolution is never lowered to meet it.
export const SCREEN_UPLOAD_BUDGET = 23_000_000;
export const SCREEN_VIEWER_MAX_BITRATE = 10_000_000;
export function screenBitrate(watching: number) {
  return Math.floor(Math.min(SCREEN_VIEWER_MAX_BITRATE, SCREEN_UPLOAD_BUDGET / Math.max(1, watching)));
}

// Browsers send Opus in mono unless the receiving side asks for stereo, which
// flattens a film's sound. Marking the remote description's Opus as stereo
// lets this side send the tab's sound in stereo (a mono microphone stays
// effectively mono). Only the remote description is changed, which is allowed.
export function withStereoOpus(sdp: string) {
  const types = new Set([...sdp.matchAll(/a=rtpmap:(\d+) opus\/48000\/2/gi)].map((match) => match[1]));
  if (types.size === 0) return sdp;
  return sdp.replace(/^a=fmtp:(\d+) (.*)$/gm, (line, type: string, params: string) => {
    if (!types.has(type) || /(^|;)\s*stereo=1/.test(params)) return line;
    return `${line};stereo=1;sprop-stereo=1`;
  });
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
export function youTubeId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    const host = parsed.hostname.replace(/^(www|m)\./, '');
    let id: string | null = null;
    if (host === 'youtu.be') id = parsed.pathname.slice(1).split('/')[0] ?? null;
    else if (host === 'youtube.com') {
      if (parsed.pathname === '/watch') id = parsed.searchParams.get('v');
      else if (/^\/(embed|shorts|live)\//.test(parsed.pathname)) id = parsed.pathname.split('/')[2] ?? null;
    }
    return id && YOUTUBE_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

// Leading + trailing throttle: the first call goes out immediately, later
// calls within `waitMs` collapse into one trailing call with the last value.
export function createThrottle<T>(run: (value: T) => void, waitMs: number, timers: { now: () => number; set: (fn: () => void, ms: number) => unknown; clear: (id: unknown) => void } = {
  now: () => Date.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
}) {
  let last = -Infinity;
  let pending: { value: T } | null = null;
  let timer: unknown = null;
  const flush = () => {
    timer = null;
    if (!pending) return;
    last = timers.now();
    const { value } = pending;
    pending = null;
    run(value);
  };
  return {
    push(value: T) {
      const elapsed = timers.now() - last;
      if (elapsed >= waitMs && !timer) {
        last = timers.now();
        run(value);
        return;
      }
      pending = { value };
      if (!timer) timer = timers.set(flush, Math.max(0, waitMs - elapsed));
    },
    cancel() {
      if (timer) timers.clear(timer);
      timer = null;
      pending = null;
    },
  };
}

// `datetime-local` value for a time `minutes` from now in local time.
export function localDateTimeInput(minutesFromNow: number, now = new Date()) {
  const date = new Date(now.getTime() + minutesFromNow * 60_000);
  date.setSeconds(0, 0);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
