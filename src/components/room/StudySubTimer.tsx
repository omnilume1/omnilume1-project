'use client';

import { useEffect, useState } from 'react';
import { formatCountdown } from '@/lib/focus-lock';

type SubTimerState = {
  subject: string;
  duration: number;
  remaining: number;
  endTime: number | null;
  isRunning: boolean;
  hasSession: boolean;
  completed: boolean;
};

interface StudySubTimerProps {
  roomId: string;
  currentUserId: string | null;
  slot: 1 | 2;
}

const DEFAULT_SUB_TIMER: SubTimerState = {
  subject: '',
  duration: 5 * 60,
  remaining: 5 * 60,
  endTime: null,
  isRunning: false,
  hasSession: false,
  completed: false,
};

function storageKey(roomId: string, currentUserId: string | null, slot: number) {
  return `omnilume_sub_timer:${roomId}:${currentUserId ?? 'guest'}:${slot}`;
}

function readState(key: string): SubTimerState {
  if (typeof window === 'undefined') return DEFAULT_SUB_TIMER;

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return DEFAULT_SUB_TIMER;
    const value = JSON.parse(raw) as Partial<SubTimerState>;
    const duration = typeof value.duration === 'number' && Number.isFinite(value.duration)
      ? Math.max(0, value.duration)
      : DEFAULT_SUB_TIMER.duration;
    const remaining = typeof value.remaining === 'number' && Number.isFinite(value.remaining)
      ? Math.max(0, value.remaining)
      : duration;

    return {
      subject: typeof value.subject === 'string' ? value.subject : '',
      duration,
      remaining,
      endTime: typeof value.endTime === 'number' && Number.isFinite(value.endTime) ? value.endTime : null,
      isRunning: Boolean(value.isRunning),
      hasSession: Boolean(value.hasSession),
      completed: Boolean(value.completed),
    };
  } catch {
    return DEFAULT_SUB_TIMER;
  }
}

function getRemaining(state: SubTimerState, now: number) {
  if (!state.isRunning || !state.endTime) return Math.max(0, Math.ceil(state.remaining));
  return Math.max(0, Math.ceil((state.endTime - now) / 1_000));
}

function splitDuration(totalSeconds: number) {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  return {
    hours: Math.min(99, Math.floor(safeSeconds / 3_600)),
    minutes: Math.floor((safeSeconds % 3_600) / 60),
    seconds: safeSeconds % 60,
  };
}

export default function StudySubTimer({ roomId, currentUserId, slot }: StudySubTimerProps) {
  const key = storageKey(roomId, currentUserId, slot);
  const [timer, setTimer] = useState<SubTimerState>(DEFAULT_SUB_TIMER);
  const [hours, setHours] = useState(0);
  const [minutes, setMinutes] = useState(5);
  const [seconds, setSeconds] = useState(0);
  const [now, setNow] = useState<number | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const restoreTimer = window.setTimeout(() => {
      const restored = readState(key);
      const draft = splitDuration(restored.duration);
      setTimer(restored);
      setHours(draft.hours);
      setMinutes(draft.minutes);
      setSeconds(draft.seconds);
      setLoadedKey(key);
      setError(null);
    }, 0);

    return () => window.clearTimeout(restoreTimer);
  }, [key]);

  useEffect(() => {
    if (loadedKey !== key || typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(key, JSON.stringify(timer));
    } catch {
      // The sub-timer remains usable when browser storage is unavailable.
    }
  }, [key, loadedKey, timer]);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const interval = window.setInterval(() => {
      const currentTime = Date.now();
      setNow(currentTime);
      setTimer((current) => {
        if (!current.isRunning || getRemaining(current, currentTime) > 0) return current;
        return {
          ...current,
          isRunning: false,
          endTime: null,
          remaining: 0,
          hasSession: false,
          completed: true,
        };
      });
    }, 250);

    return () => window.clearInterval(interval);
  }, []);

  const hasPausedSession = timer.hasSession && !timer.completed;
  const draftDuration = (hours * 3_600) + (minutes * 60) + seconds;
  const displayedRemaining = now === null ? timer.remaining : getRemaining(timer, now);
  const canUseTimer = Boolean(currentUserId);

  const updatePart = (part: 'hours' | 'minutes' | 'seconds', value: string) => {
    const parsed = Math.max(0, Number.parseInt(value, 10) || 0);
    if (part === 'hours') setHours(Math.min(99, parsed));
    if (part === 'minutes') setMinutes(Math.min(59, parsed));
    if (part === 'seconds') setSeconds(Math.min(59, parsed));
    setError(null);
  };

  const start = () => {
    if (!canUseTimer || timer.isRunning) return;

    const subject = timer.subject.trim();
    if (!subject) {
      setError('Add a subject first.');
      return;
    }

    const isResume = hasPausedSession;
    const duration = isResume ? timer.remaining : draftDuration;
    if (duration <= 0) {
      setError('Set a duration longer than zero.');
      return;
    }

    setError(null);
    setTimer((current) => ({
      ...current,
      subject,
      duration: isResume ? current.duration : duration,
      remaining: duration,
      endTime: Date.now() + (duration * 1_000),
      isRunning: true,
      hasSession: true,
      completed: false,
    }));
  };

  const pause = () => {
    if (!timer.isRunning) return;
    const remaining = getRemaining(timer, Date.now());
    setTimer((current) => ({
      ...current,
      remaining,
      endTime: null,
      isRunning: false,
      hasSession: remaining > 0,
    }));
  };

  const reset = () => {
    const duration = Math.max(0, draftDuration);
    setError(null);
    setTimer((current) => ({
      ...current,
      duration,
      remaining: duration,
      endTime: null,
      isRunning: false,
      hasSession: false,
      completed: false,
    }));
  };

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        aria-expanded={false}
        className="flex min-h-16 w-full items-center justify-between gap-3 rounded-xl border border-neutral-800 bg-[#111] px-4 py-3 text-left shadow-lg shadow-black/10 transition hover:border-indigo-500/60 hover:bg-[#151515]"
      >
        <span className="shrink-0 text-[10px] font-bold uppercase tracking-widest text-indigo-300">Sub timer {slot}</span>
        <span className="flex-1 text-center text-xs font-bold text-white">Add sub timer</span>
        <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-neutral-500">
          {timer.isRunning ? formatCountdown(displayedRemaining) : timer.completed ? 'Done' : 'Open'}
        </span>
      </button>
    );
  }

  return (
    <article className="w-full rounded-2xl border border-neutral-800 bg-[#111] p-4 shadow-xl shadow-black/20 sm:col-span-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-indigo-300">Sub timer {slot}</p>
          <p className="mt-1 text-[10px] text-neutral-500">Personal auxiliary timer</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded-full px-2 py-1 text-[9px] font-bold uppercase tracking-wider ${timer.isRunning ? 'bg-emerald-500/10 text-emerald-300' : timer.completed ? 'bg-indigo-500/10 text-indigo-300' : 'bg-neutral-900 text-neutral-500'}`}>
            {timer.isRunning ? 'Running' : timer.completed ? 'Done' : hasPausedSession ? 'Paused' : 'Ready'}
          </span>
          <button type="button" onClick={() => setIsOpen(false)} className="rounded-md border border-neutral-700 px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-neutral-400 transition hover:border-neutral-500 hover:text-white">Collapse</button>
        </div>
      </div>

      <label htmlFor={`sub-timer-${slot}-subject`} className="mt-4 block text-[9px] font-bold uppercase tracking-widest text-neutral-500">Subject</label>
      <input
        id={`sub-timer-${slot}-subject`}
        type="text"
        value={timer.subject}
        onChange={(event) => {
          setTimer((current) => ({ ...current, subject: event.target.value }));
          setError(null);
        }}
        placeholder="e.g. Revision"
        disabled={!canUseTimer || timer.isRunning || hasPausedSession}
        className="mt-2 w-full rounded-lg border border-neutral-800 bg-[#0a0a0a] px-3 py-2 text-xs text-white outline-none transition placeholder:text-neutral-600 focus:border-indigo-500 disabled:cursor-not-allowed disabled:text-neutral-500"
      />

      {!hasPausedSession && !timer.isRunning && (
        <div className="mt-3 grid grid-cols-3 gap-2">
          {([
            ['Hrs', hours, 'hours'],
            ['Min', minutes, 'minutes'],
            ['Sec', seconds, 'seconds'],
          ] as const).map(([label, value, part]) => (
            <label key={part} className="text-center">
              <span className="text-[9px] font-bold uppercase tracking-wider text-neutral-600">{label}</span>
              <input
                type="number"
                value={value}
                onChange={(event) => updatePart(part, event.target.value)}
                min="0"
                max={part === 'hours' ? 99 : 59}
                className="mt-1 h-9 w-full rounded-lg border border-neutral-800 bg-[#0a0a0a] text-center text-sm font-bold text-white outline-none focus:border-indigo-500"
              />
            </label>
          ))}
        </div>
      )}

      <div className={`mt-4 text-center font-mono text-3xl font-black tabular-nums tracking-tight ${timer.isRunning ? 'text-white' : timer.completed ? 'text-indigo-300' : 'text-neutral-200'}`}>
        {formatCountdown(displayedRemaining)}
      </div>
      <p className="mt-1 text-center text-[10px] text-neutral-500">
        {timer.isRunning ? 'Counting down' : timer.completed ? 'Sub-session complete' : hasPausedSession ? 'Paused — resume when ready' : 'Ready to start'}
      </p>

      <div className="mt-4 flex gap-2">
        {!timer.isRunning ? (
          <button type="button" onClick={start} disabled={!canUseTimer} className="flex-1 rounded-lg bg-indigo-600 px-3 py-2 text-[10px] font-bold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50">
            {hasPausedSession ? 'Resume' : 'Start'}
          </button>
        ) : (
          <button type="button" onClick={pause} className="flex-1 rounded-lg bg-amber-500 px-3 py-2 text-[10px] font-bold text-black transition hover:bg-amber-400">Pause</button>
        )}
        <button type="button" onClick={reset} disabled={!canUseTimer} className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-[10px] font-bold text-neutral-300 transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50">Reset</button>
      </div>
      {error && <p className="mt-2 text-center text-[10px] text-amber-300">{error}</p>}
    </article>
  );
}
