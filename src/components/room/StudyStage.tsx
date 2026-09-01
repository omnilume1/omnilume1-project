'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent,
} from 'react';
import { deleteStudySubject, getStudyHistory, logStudySession, type StudyHistoryEntry } from '@/actions/study';
import StudySubTimer from '@/components/room/StudySubTimer';
import { useRoomRealtime } from '@/components/room/RoomRealtimeProvider';
import type { TimerState } from '@/hooks/useRoomSync';
import {
  FOCUS_LOCK_EVENT,
  activateFocusLock,
  formatCountdown,
  getRemainingSeconds,
  readFocusLock,
  type FocusLockState,
} from '@/lib/focus-lock';

type StudyTab = 'TIMER' | 'NOTES' | 'WHITEBOARD' | 'PDF';

interface StudyStageProps {
  roomId: string;
  focusRoomPath: string;
  timerNavigationRequest?: number;
}

interface StudyMiniTimerProps {
  timerState: TimerState;
  roomId?: string;
  focusLockExpiresAt?: number | null;
  onOpen: () => void;
}

const RECENT_SUBJECTS_KEY_PREFIX = 'omnilume_recent_subjects:';

function createId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function getTimerRemaining(timerState: TimerState, now = Date.now()) {
  if (timerState.completed) return 0;
  if (!timerState.isRunning || !timerState.endTime) return Math.max(0, Math.ceil(timerState.remaining));
  return Math.max(0, Math.ceil((timerState.endTime - now) / 1_000));
}

function getElapsedSeconds(timerState: TimerState, now = Date.now()) {
  const activeSeconds = timerState.isRunning && timerState.segmentStartedAt
    ? Math.max(0, (now - timerState.segmentStartedAt) / 1_000)
    : 0;
  return Math.max(0, timerState.elapsedSeconds + activeSeconds);
}

function formatStudyMinutes(minutes: number) {
  const roundedMinutes = Math.max(0, Math.round(minutes));
  const hours = Math.floor(roundedMinutes / 60);
  const remainder = roundedMinutes % 60;
  if (hours === 0) return `${remainder} min`;
  if (remainder === 0) return `${hours}h`;
  return `${hours}h ${remainder}m`;
}

function readRecentSubjects(roomId: string) {
  if (typeof window === 'undefined') return [];
  try {
    const saved = window.localStorage.getItem(`${RECENT_SUBJECTS_KEY_PREFIX}${roomId}`);
    const subjects = saved ? JSON.parse(saved) as unknown : [];
    return Array.isArray(subjects)
      ? subjects.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).slice(0, 3)
      : [];
  } catch {
    return [];
  }
}

function saveRecentSubject(roomId: string, subject: string) {
  if (typeof window === 'undefined') return;
  const cleanSubject = subject.trim();
  if (!cleanSubject) return;
  const next = [cleanSubject, ...readRecentSubjects(roomId).filter((item) => item.toLowerCase() !== cleanSubject.toLowerCase())].slice(0, 3);
  try {
    window.localStorage.setItem(`${RECENT_SUBJECTS_KEY_PREFIX}${roomId}`, JSON.stringify(next));
  } catch {
    // Local suggestions are optional; the timer remains usable if storage is unavailable.
  }
}

function readLoggedSeconds(roomId: string, sessionId: string) {
  if (typeof window === 'undefined') return 0;
  try {
    const saved = window.localStorage.getItem(`omnilume_study_logged:${roomId}:${sessionId}`);
    const value = saved ? Number(saved) : 0;
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  } catch {
    return 0;
  }
}

function writeLoggedSeconds(roomId: string, sessionId: string, seconds: number) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(`omnilume_study_logged:${roomId}:${sessionId}`, String(Math.max(0, Math.floor(seconds))));
  } catch {
    // The database history remains the source of truth when local storage is unavailable.
  }
}

export function StudyMiniTimer({ timerState, roomId, focusLockExpiresAt, onOpen }: StudyMiniTimerProps) {
  const [now, setNow] = useState<number | null>(null);
  const [detectedFocusLock, setDetectedFocusLock] = useState<FocusLockState | null>(null);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const interval = window.setInterval(tick, 1_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (focusLockExpiresAt !== undefined) return;

    const refreshFocusLock = () => setDetectedFocusLock(readFocusLock());
    refreshFocusLock();
    const interval = window.setInterval(refreshFocusLock, 1_000);
    window.addEventListener('storage', refreshFocusLock);
    window.addEventListener(FOCUS_LOCK_EVENT, refreshFocusLock);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener('storage', refreshFocusLock);
      window.removeEventListener(FOCUS_LOCK_EVENT, refreshFocusLock);
    };
  }, [focusLockExpiresAt]);

  if (!timerState.isRunning) return null;

  const timerRemaining = now === null ? timerState.remaining : getTimerRemaining(timerState, now);
  const detectedExpiry = detectedFocusLock && (!roomId || detectedFocusLock.roomId === roomId)
    ? detectedFocusLock.expiresAt
    : null;
  const effectiveFocusLockExpiresAt = focusLockExpiresAt === undefined ? detectedExpiry : focusLockExpiresAt;
  const focusRemaining = effectiveFocusLockExpiresAt && now !== null
    ? getRemainingSeconds(effectiveFocusLockExpiresAt, now)
    : 0;
  const focusLockActive = focusRemaining > 0;

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`fixed bottom-5 right-5 z-40 w-56 cursor-pointer rounded-2xl border p-3 text-left shadow-2xl backdrop-blur-md transition ${focusLockActive ? 'border-red-500/60 bg-red-950/90 hover:border-red-400 hover:bg-red-950' : 'border-white/15 bg-[#121212]/95 hover:border-indigo-500/60 hover:bg-[#181818]'}`}
      aria-label="Open the study timer"
    >
      <div className="flex items-center justify-between gap-3">
        <span className={`truncate text-[10px] font-bold uppercase tracking-widest ${focusLockActive ? 'text-red-300' : 'text-indigo-300'}`}>{focusLockActive ? 'Focus locked' : 'Study timer'}</span>
        <span className={`text-[10px] ${focusLockActive ? 'text-red-200/70' : 'text-neutral-500'}`}>Open</span>
      </div>
      <p className={`mt-1 truncate text-xs font-semibold ${focusLockActive ? 'text-red-50' : 'text-white'}`}>{timerState.subject || 'Study session'}</p>
      <p className={`mt-1 font-mono text-2xl font-black tabular-nums ${focusLockActive ? 'text-red-100' : 'text-white'}`}>{formatCountdown(timerRemaining)}</p>
      {focusRemaining > 0 && <p className="mt-1 text-[10px] font-bold uppercase tracking-wider text-red-400">Focus lock · {formatCountdown(focusRemaining)}</p>}
    </button>
  );
}

export default function StudyStage({ roomId, focusRoomPath, timerNavigationRequest = 0 }: StudyStageProps) {
  const { timerState, broadcastEvent, currentUserId } = useRoomRealtime();
  const [activeTab, setActiveTab] = useState<StudyTab>('TIMER');
  const [subject, setSubject] = useState('');
  const [inputHrs, setInputHrs] = useState(0);
  const [inputMin, setInputMin] = useState(25);
  const [inputSec, setInputSec] = useState(0);
  const [now, setNow] = useState<number | null>(null);
  const [recentSubjects, setRecentSubjects] = useState<string[]>([]);
  const [studyHistory, setStudyHistory] = useState<StudyHistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [isSavingSession, setIsSavingSession] = useState(false);
  const [focusLock, setFocusLock] = useState<FocusLockState | null>(null);
  const [showFocusWarning, setShowFocusWarning] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [ctx, setCtx] = useState<CanvasRenderingContext2D | null>(null);
  const completionSessionRef = useRef<string | null>(null);
  const loggingSessionRef = useRef(new Set<string>());
  const previousTimerSessionRef = useRef<string | null>(timerState.sessionId);
  const [notesContent, setNotesContent] = useState('');
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);

  const draftDurationSeconds = (inputHrs * 3_600) + (inputMin * 60) + inputSec;
  const hasSession = Boolean(timerState.sessionId);
  const canManageTimer = !timerState.ownerId || timerState.ownerId === currentUserId;
  const displayedRemaining = timerState.completed
    ? 0
    : hasSession || timerState.isRunning
      ? now === null ? timerState.remaining : getTimerRemaining(timerState, now)
      : draftDurationSeconds;
  const focusLockActive = Boolean(focusLock && focusLock.roomId === roomId);
  const focusLockRemaining = focusLockActive && focusLock && now !== null ? getRemainingSeconds(focusLock.expiresAt, now) : 0;
  const displayedSubject = timerState.subject || subject;

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    const result = await getStudyHistory(roomId);
    if (result.success && result.history) {
      setStudyHistory(result.history);
      setHistoryError(null);
    } else {
      setHistoryError(result.error ?? 'Unable to load study history.');
    }
    setHistoryLoading(false);
  }, [roomId]);

  const refreshFocusLock = useCallback(() => {
    const lock = readFocusLock();
    setFocusLock(lock?.roomId === roomId ? lock : null);
  }, [roomId]);

  const persistStudyProgress = useCallback(async (state: TimerState, elapsedSeconds: number) => {
    if (!state.sessionId || !state.subject.trim() || !currentUserId || state.ownerId !== currentUserId) return;

    const totalSeconds = Math.floor(Math.max(0, elapsedSeconds));
    const loggedSeconds = readLoggedSeconds(roomId, state.sessionId);
    const newSeconds = totalSeconds - loggedSeconds;
    if (newSeconds < 1 || loggingSessionRef.current.has(state.sessionId)) return;

    loggingSessionRef.current.add(state.sessionId);
    setIsSavingSession(true);
    try {
      const result = await logStudySession(roomId, state.subject, Math.max(1, Math.round(newSeconds / 60)));
      if (!result.success) {
        setHistoryError(result.error ?? 'The session could not be saved.');
        return;
      }
      writeLoggedSeconds(roomId, state.sessionId, totalSeconds);
      await loadHistory();
    } finally {
      loggingSessionRef.current.delete(state.sessionId);
      setIsSavingSession(false);
    }
  }, [currentUserId, loadHistory, roomId]);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const interval = window.setInterval(tick, 1_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => {
      setRecentSubjects(readRecentSubjects(roomId));
      void loadHistory();
    }, 0);
    return () => window.clearTimeout(initialLoad);
  }, [loadHistory, roomId]);

  useEffect(() => {
    const initialRefresh = window.setTimeout(refreshFocusLock, 0);
    const interval = window.setInterval(refreshFocusLock, 1_000);
    window.addEventListener('storage', refreshFocusLock);
    window.addEventListener(FOCUS_LOCK_EVENT, refreshFocusLock);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(initialRefresh);
      window.removeEventListener('storage', refreshFocusLock);
      window.removeEventListener(FOCUS_LOCK_EVENT, refreshFocusLock);
    };
  }, [refreshFocusLock]);

  useEffect(() => {
    if (timerNavigationRequest <= 0) return;
    const navigation = window.setTimeout(() => setActiveTab('TIMER'), 0);
    return () => window.clearTimeout(navigation);
  }, [timerNavigationRequest]);

  useEffect(() => {
    if (timerState.subject && timerState.sessionId && timerState.sessionId !== previousTimerSessionRef.current) {
      const subjectUpdate = window.setTimeout(() => setSubject(timerState.subject), 0);
      previousTimerSessionRef.current = timerState.sessionId;
      return () => window.clearTimeout(subjectUpdate);
    }
    previousTimerSessionRef.current = timerState.sessionId;
  }, [timerState.sessionId, timerState.subject]);

  useEffect(() => {
    if (!timerState.isRunning || !timerState.endTime || !timerState.sessionId) return;

    const interval = window.setInterval(() => {
      const remaining = getTimerRemaining(timerState, Date.now());
      setNow(Date.now());
      if (remaining > 0 || completionSessionRef.current === timerState.sessionId) return;
      if (timerState.ownerId && timerState.ownerId !== currentUserId) return;

      completionSessionRef.current = timerState.sessionId;
      const elapsedSeconds = getElapsedSeconds(timerState);
      void persistStudyProgress(timerState, elapsedSeconds);
      broadcastEvent('timer_pause', {
        remaining: 0,
        duration: timerState.duration,
        subject: timerState.subject,
        sessionId: timerState.sessionId,
        ownerId: timerState.ownerId,
        startedAt: timerState.startedAt,
        elapsedSeconds,
        completed: true,
      });
    }, 250);

    return () => window.clearInterval(interval);
  }, [broadcastEvent, currentUserId, persistStudyProgress, timerState]);

  useEffect(() => {
    if (!focusLockActive || !focusLock || focusLockRemaining !== 0) return;
    const expiryRefresh = window.setTimeout(refreshFocusLock, 0);
    return () => window.clearTimeout(expiryRefresh);
  }, [focusLock, focusLockActive, focusLockRemaining, refreshFocusLock]);

  useEffect(() => {
    if (activeTab !== 'WHITEBOARD' || !canvasRef.current || ctx) return;
    const canvas = canvasRef.current;
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    const context = canvas.getContext('2d');
    if (context) {
      context.lineCap = 'round';
      context.lineWidth = 3;
      context.strokeStyle = '#6366f1';
      setCtx(context);
    }
  }, [activeTab, ctx]);

  useEffect(() => () => {
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
  }, [pdfUrl]);

  const rememberSubject = (value: string) => {
    saveRecentSubject(roomId, value);
    setRecentSubjects(readRecentSubjects(roomId));
  };

  const makeTimerPayload = (remaining: number, elapsedSeconds: number) => ({
    remaining,
    duration: timerState.duration,
    subject: timerState.subject || subject.trim(),
    sessionId: timerState.sessionId,
    ownerId: timerState.ownerId || currentUserId,
    startedAt: timerState.startedAt,
    elapsedSeconds,
  });

  const startTimer = () => {
    if (timerState.isRunning || !canManageTimer || !currentUserId) return;
    const cleanSubject = (timerState.sessionId ? timerState.subject : subject).trim();
    if (!cleanSubject) {
      setHistoryError('Enter a subject before starting the timer.');
      return;
    }

    const isResume = Boolean(timerState.sessionId && !timerState.completed);
    const duration = isResume ? timerState.remaining : draftDurationSeconds;
    if (duration <= 0) {
      setHistoryError('Set a timer longer than zero.');
      return;
    }

    const startedAt = isResume ? timerState.startedAt : Date.now();
    const sessionId = isResume && timerState.sessionId ? timerState.sessionId : createId();
    const elapsedSeconds = isResume ? timerState.elapsedSeconds : 0;
    completionSessionRef.current = null;
    setHistoryError(null);
    setSubject(cleanSubject);
    rememberSubject(cleanSubject);
    broadcastEvent('timer_start', {
      endTime: Date.now() + duration * 1_000,
      remaining: duration,
      duration: isResume ? timerState.duration : duration,
      subject: cleanSubject,
      sessionId,
      ownerId: isResume ? timerState.ownerId : currentUserId,
      startedAt: startedAt ?? Date.now(),
      segmentStartedAt: Date.now(),
      elapsedSeconds,
    });
  };

  const pauseTimer = async () => {
    if (!timerState.isRunning || !timerState.sessionId || !canManageTimer) return;
    const elapsedSeconds = getElapsedSeconds(timerState);
    const remaining = getTimerRemaining(timerState);
    await persistStudyProgress(timerState, elapsedSeconds);
    broadcastEvent('timer_pause', {
      ...makeTimerPayload(remaining, elapsedSeconds),
      subject: timerState.subject || subject.trim(),
      sessionId: timerState.sessionId,
      ownerId: timerState.ownerId || currentUserId,
      startedAt: timerState.startedAt,
      completed: false,
    });
  };

  const resetTimer = async () => {
    if (!canManageTimer || isSavingSession) return;
    if (timerState.isRunning && timerState.sessionId) {
      await persistStudyProgress(timerState, getElapsedSeconds(timerState));
    }
    const duration = Math.max(0, draftDurationSeconds);
    completionSessionRef.current = null;
    broadcastEvent('timer_reset', { remaining: duration, duration, subject: subject.trim() });
  };

  const updateTimeInput = (type: 'hrs' | 'min' | 'sec', value: string) => {
    const parsed = Math.max(0, Number.parseInt(value, 10) || 0);
    if (type === 'hrs') setInputHrs(Math.min(99, parsed));
    if (type === 'min') setInputMin(Math.min(59, parsed));
    if (type === 'sec') setInputSec(Math.min(59, parsed));
  };

  const confirmFocusLock = () => {
    const lock = activateFocusLock(roomId, focusRoomPath);
    setFocusLock(lock);
    setShowFocusWarning(false);
  };

  const startDraw = (event: MouseEvent<HTMLCanvasElement>) => {
    if (!ctx) return;
    ctx.beginPath();
    ctx.moveTo(event.nativeEvent.offsetX, event.nativeEvent.offsetY);
    setIsDrawing(true);
  };

  const draw = (event: MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !ctx) return;
    ctx.lineTo(event.nativeEvent.offsetX, event.nativeEvent.offsetY);
    ctx.stroke();
  };

  const stopDraw = () => {
    if (!ctx) return;
    ctx.closePath();
    setIsDrawing(false);
  };

  const handlePdfUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    setPdfUrl(URL.createObjectURL(file));
  };

  const selectHistorySubject = (historySubject: string) => {
    if (timerState.isRunning) return;
    setSubject(historySubject);
    setShowHistory(false);
  };

  const removeHistorySubject = async (historySubject: string) => {
    const result = await deleteStudySubject(roomId, historySubject);
    if (!result.success) {
      setHistoryError(result.error ?? 'Unable to remove this subject.');
      return;
    }
    await loadHistory();
  };

  const renderHistoryPanel = showHistory && (
    <div className="absolute right-6 top-20 z-30 w-[min(25rem,calc(100%-3rem))] overflow-hidden rounded-2xl border border-neutral-700 bg-[#111]/95 shadow-2xl backdrop-blur-md">
      <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
        <div>
          <h3 className="text-sm font-bold text-white">Study history</h3>
          <p className="mt-0.5 text-[10px] text-neutral-500">Your completed and paused focus time in this room</p>
        </div>
        <button type="button" onClick={() => setShowHistory(false)} className="cursor-pointer text-lg text-neutral-500 hover:text-white" aria-label="Close study history">×</button>
      </div>
      <div className="max-h-80 overflow-y-auto p-3">
        {historyLoading && <p className="px-2 py-4 text-xs text-neutral-500">Loading history...</p>}
        {!historyLoading && studyHistory.length === 0 && <p className="px-2 py-6 text-center text-xs text-neutral-500">No study sessions recorded yet.</p>}
        <div className="flex flex-col gap-2">
          {studyHistory.map((entry) => (
            <div key={entry.subject} className="rounded-xl border border-neutral-800 bg-[#171717] p-3">
              <div className="flex items-center justify-between gap-3">
                <button type="button" onClick={() => selectHistorySubject(entry.subject)} className="min-w-0 cursor-pointer truncate text-left text-sm font-bold text-white hover:text-indigo-300" title="Load this subject">
                  {entry.subject}
                </button>
                <span className="shrink-0 text-sm font-black text-indigo-300">{formatStudyMinutes(entry.totalMinutes)}</span>
              </div>
              <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-neutral-500">
                <span>Last studied {new Date(entry.lastStudied).toLocaleDateString()}</span>
                <button type="button" onClick={() => void removeHistorySubject(entry.subject)} className="cursor-pointer text-neutral-600 hover:text-red-300">Remove</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  const focusWarning = showFocusWarning && (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-red-500/30 bg-[#111] p-6 shadow-2xl">
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-red-500/15 text-xl text-red-400">⏱</div>
        <h3 className="text-lg font-bold text-white">Turn on Focus Lock?</h3>
        <p className="mt-3 text-sm leading-6 text-neutral-400">
          After turning on Focus Lock, you will be locked in this room for 1 hour. You can continue using this room’s casting, study, chat, members, and files features, but leaving the room or changing its URL will bring you back here.
        </p>
        <p className="mt-3 text-xs text-neutral-500">Focus Lock is separate from your main study timer. It will expire after one hour even if you pause or reset the main timer.</p>
        <div className="mt-6 flex gap-3">
          <button type="button" onClick={() => setShowFocusWarning(false)} className="flex-1 cursor-pointer rounded-xl border border-neutral-700 bg-neutral-900 px-4 py-3 text-sm font-bold text-neutral-300 transition hover:bg-neutral-800">Cancel</button>
          <button type="button" onClick={confirmFocusLock} className="flex-1 cursor-pointer rounded-xl bg-red-500 px-4 py-3 text-sm font-bold text-black transition hover:bg-red-400">Agree & lock for 1 hour</button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col rounded-2xl border border-neutral-800 bg-[#0a0a0a] p-4 transition-all duration-300 sm:p-6">
      {renderHistoryPanel}
      {focusWarning}

      <div className="mb-5 flex items-center justify-between gap-4 border-b border-neutral-800 pb-4">
        <h2 className="hidden text-lg font-bold text-white sm:block">Study Workspace</h2>
        <div className="flex min-w-0 gap-1 overflow-x-auto rounded-xl bg-[#121212] p-1">
          {(['TIMER', 'NOTES', 'WHITEBOARD', 'PDF'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`shrink-0 cursor-pointer rounded-lg px-3 py-2 text-[10px] font-bold tracking-wider transition sm:px-4 ${activeTab === tab ? 'bg-indigo-600 text-white shadow-lg' : 'text-neutral-500 hover:bg-white/5 hover:text-white'}`}
            >
              {tab}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => { setShowHistory((visible) => !visible); if (!showHistory) void loadHistory(); }} className="shrink-0 cursor-pointer rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-neutral-300 transition hover:border-neutral-500 hover:text-white">
          History
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className={activeTab === 'TIMER' ? 'min-h-0 flex-1 overflow-y-auto px-1 py-4' : 'hidden'}>
          <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col items-center">
            <div className="w-full max-w-md">
              <label htmlFor="study-subject" className="mb-2 block text-center text-[10px] font-bold uppercase tracking-widest text-neutral-500">Current subject</label>
              <input
                id="study-subject"
                type="text"
                value={displayedSubject}
                onChange={(event) => setSubject(event.target.value)}
                placeholder="What are you focusing on?"
                disabled={timerState.isRunning || hasSession}
                className="w-full border-b-2 border-neutral-800 bg-transparent pb-2 text-center text-sm text-white outline-none transition placeholder:text-neutral-600 focus:border-indigo-500 disabled:cursor-not-allowed disabled:text-neutral-400"
              />
              {recentSubjects.length > 0 && !timerState.isRunning && !hasSession && (
                <div className="mt-3 flex flex-wrap justify-center gap-2">
                  <span className="self-center text-[10px] uppercase tracking-wider text-neutral-600">Recent</span>
                  {recentSubjects.map((recentSubject) => (
                    <button key={recentSubject} type="button" onClick={() => setSubject(recentSubject)} className="cursor-pointer rounded-full border border-neutral-700 bg-neutral-900 px-3 py-1 text-xs text-neutral-300 transition hover:border-indigo-500/60 hover:text-white">
                      {recentSubject}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {!hasSession && !timerState.isRunning && (
              <div className="mt-8 flex gap-3 sm:gap-5">
                <label className="flex flex-col items-center gap-2"><span className="text-[10px] font-bold uppercase tracking-widest text-neutral-500">Hrs</span><input type="number" value={inputHrs} onChange={(event) => updateTimeInput('hrs', event.target.value)} min="0" max="99" className="h-12 w-16 rounded-xl border border-neutral-800 bg-[#121212] text-center text-lg font-bold text-white outline-none focus:border-indigo-500" /></label>
                <label className="flex flex-col items-center gap-2"><span className="text-[10px] font-bold uppercase tracking-widest text-neutral-500">Min</span><input type="number" value={inputMin} onChange={(event) => updateTimeInput('min', event.target.value)} min="0" max="59" className="h-12 w-16 rounded-xl border border-neutral-800 bg-[#121212] text-center text-lg font-bold text-white outline-none focus:border-indigo-500" /></label>
                <label className="flex flex-col items-center gap-2"><span className="text-[10px] font-bold uppercase tracking-widest text-neutral-500">Sec</span><input type="number" value={inputSec} onChange={(event) => updateTimeInput('sec', event.target.value)} min="0" max="59" className="h-12 w-16 rounded-xl border border-neutral-800 bg-[#121212] text-center text-lg font-bold text-white outline-none focus:border-indigo-500" /></label>
              </div>
            )}

            <div className={`mt-8 font-mono text-6xl font-black tabular-nums tracking-tighter transition-colors sm:text-8xl ${focusLockActive ? 'text-red-400' : 'text-white'}`}>
              {formatCountdown(displayedRemaining)}
            </div>
            <p className="mt-3 text-xs text-neutral-500">
              {timerState.isRunning ? `Studying ${displayedSubject || 'your subject'}` : timerState.completed ? 'Session complete' : hasSession ? 'Paused — resume when ready' : 'Ready to focus'}
            </p>
            {focusLockRemaining > 0 && <p className="mt-2 text-[10px] font-bold uppercase tracking-widest text-red-400">Focus lock · {formatCountdown(focusLockRemaining)} remaining</p>}

            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              {!timerState.isRunning && (
                <button type="button" onClick={startTimer} disabled={!canManageTimer || !currentUserId || isSavingSession} className="cursor-pointer rounded-xl bg-indigo-600 px-6 py-3 text-sm font-bold text-white shadow-[0_0_20px_rgba(79,70,229,0.25)] transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50">
                  {hasSession && !timerState.completed ? 'Resume' : 'Start session'}
                </button>
              )}
              {timerState.isRunning && (
                <button type="button" onClick={() => void pauseTimer()} disabled={!canManageTimer || isSavingSession} className="cursor-pointer rounded-xl bg-amber-500 px-6 py-3 text-sm font-bold text-black transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50">
                  {isSavingSession ? 'Saving…' : 'Pause'}
                </button>
              )}
              <button type="button" onClick={() => void resetTimer()} disabled={!canManageTimer || isSavingSession} className="cursor-pointer rounded-xl border border-neutral-700 bg-neutral-900 px-5 py-3 text-sm font-bold text-neutral-200 transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50">Reset</button>
              <button type="button" onClick={() => { if (!focusLockActive) setShowFocusWarning(true); }} disabled={focusLockActive} className={`cursor-pointer rounded-xl border px-5 py-3 text-sm font-bold transition disabled:cursor-not-allowed ${focusLockActive ? 'border-red-500/40 bg-red-500/10 text-red-300' : 'border-neutral-700 bg-neutral-900 text-neutral-300 hover:border-red-500/50 hover:text-red-300'}`}>
                {focusLockActive ? `Locked · ${formatCountdown(focusLockRemaining)}` : 'Focus lock'}
              </button>
            </div>

            {!canManageTimer && timerState.isRunning && <p className="mt-4 text-center text-[10px] text-neutral-500">This room timer is controlled by another student.</p>}
            {historyError && <p className="mt-4 max-w-md text-center text-xs text-amber-300">{historyError}</p>}

            <div className="mt-8 grid w-full grid-cols-1 gap-3 pb-4 sm:grid-cols-2">
              <StudySubTimer roomId={roomId} currentUserId={currentUserId} slot={1} />
              <StudySubTimer roomId={roomId} currentUserId={currentUserId} slot={2} />
            </div>
          </div>
        </div>

        {activeTab === 'NOTES' && <textarea value={notesContent} onChange={(event) => setNotesContent(event.target.value)} placeholder="Type your private study notes here..." className="min-h-0 flex-1 w-full resize-none rounded-xl border border-neutral-800 bg-[#121212] p-6 text-white shadow-inner outline-none focus:border-indigo-500" />}
        {activeTab === 'WHITEBOARD' && <div className="relative min-h-0 flex-1 w-full cursor-crosshair overflow-hidden rounded-xl border border-neutral-800 bg-[#121212]"><canvas ref={canvasRef} onMouseDown={startDraw} onMouseMove={draw} onMouseUp={stopDraw} onMouseLeave={stopDraw} className="block h-full w-full" /></div>}
        {activeTab === 'PDF' && (
          <div className="relative flex min-h-0 flex-1 w-full flex-col overflow-hidden rounded-xl border border-neutral-800 bg-[#121212]">
            {!pdfUrl ? <div className="flex flex-1 flex-col items-center justify-center gap-4"><label className="cursor-pointer rounded-lg bg-indigo-600 px-6 py-3 font-bold text-white shadow-lg transition hover:bg-indigo-500">Upload PDF<input type="file" accept="application/pdf" className="hidden" onChange={handlePdfUpload} /></label></div> : <iframe src={pdfUrl} className="h-full w-full flex-1 border-none bg-white" title="PDF Viewer" />}
          </div>
        )}
      </div>

      {activeTab !== 'TIMER' && timerState.isRunning && <StudyMiniTimer timerState={timerState} focusLockExpiresAt={focusLockActive && focusLock ? focusLock.expiresAt : null} onOpen={() => setActiveTab('TIMER')} />}
    </div>
  );
}
