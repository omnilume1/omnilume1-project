'use client';

import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useRoomSync } from '@/hooks/useRoomSync';
import { logStudySession, getStudyHistory, deleteStudySubject } from '@/actions/study';

interface StudyStageProps {
  roomId: string;
  currentUserRole: string | null;
}

export default function StudyStage({ roomId, currentUserRole }: StudyStageProps) {
  const { timerState, broadcastEvent } = useRoomSync(roomId);
  
  const [activeTab, setActiveTab] = useState<'timer' | 'notes' | 'whiteboard' | 'pdf'>('timer');
  const [subject, setSubject] = useState('');
  const [subjectError, setSubjectError] = useState(false);
  
  const [inputH, setInputH] = useState('0');
  const [inputM, setInputM] = useState('25');
  const [inputS, setInputS] = useState('0');

  const [timeLeft, setTimeLeft] = useState(25 * 60);
  const [showFocusWarning, setShowFocusWarning] = useState(false);
  
  // Analytics State
  const [showHistory, setShowHistory] = useState(false);
  const [studyHistory, setStudyHistory] = useState<any[]>([]);

  // PERFECTED: Uses localStorage to sync with the GlobalFocusTrap in layout.tsx
  const [isFocusLocked, setIsFocusLocked] = useState(() => typeof window !== 'undefined' ? localStorage.getItem('omnilume_focus_lock') === roomId : false);
  
  useEffect(() => {
    const savedSubject = sessionStorage.getItem(`subject:${roomId}`);
    if (savedSubject) setSubject(savedSubject);
    loadHistory();
  }, [roomId]);

  const loadHistory = async () => {
    const res = await getStudyHistory(roomId);
    if (res.success && res.history) setStudyHistory(res.history);
  };

  // STRICT BROWSER TRAP: Blocks F5 and Back Button natively
  useEffect(() => {
    if (!isFocusLocked) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "Focus Lock is active. Leaving will disrupt your session.";
      return e.returnValue;
    };
    const handlePopState = (e: PopStateEvent) => {
      window.history.pushState(null, '', window.location.href);
      alert("Focus Lock active: You are locked in this room. Please unlock to leave.");
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    window.history.pushState(null, '', window.location.href);
    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('popstate', handlePopState);
    };
  }, [isFocusLocked]);

  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [hasCompleted, setHasCompleted] = useState(false);

  const isOwnerOrAdmin = currentUserRole === 'owner' || currentUserRole === 'admin';

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (timerState.isRunning && timerState.endTime) {
      interval = setInterval(() => {
        const remainingNow = Math.round((timerState.endTime! - Date.now()) / 1000);
        if (remainingNow <= 0) setTimeLeft(0);
        else { setTimeLeft(remainingNow); setHasCompleted(false); }
      }, 500);
    } else setTimeLeft(timerState.remaining);
    return () => clearInterval(interval);
  }, [timerState]);

  useEffect(() => {
    if (timeLeft === 0 && timerState.isRunning && !hasCompleted) {
      setHasCompleted(true);
      executeCompletion();
    }
  }, [timeLeft, timerState.isRunning, hasCompleted]);

  const executeCompletion = async () => {
    try { const audio = new Audio('/sounds/bell.mp3'); audio.play().catch(()=>{}); } catch (e) {}
    
    if (subject.trim() && timerState.duration > 0) {
      setIsSaving(true);
      setSaveMessage("Saving to analytics...");
      const result = await logStudySession(roomId, subject, Math.ceil(timerState.duration / 60));
      if (result.success) {
        setSaveMessage(`✓ Logged ${Math.ceil(timerState.duration / 60)} mins`);
        loadHistory(); 
      } else setSaveMessage("❌ Failed to save session.");
      setIsSaving(false);
      setTimeout(() => setSaveMessage(null), 4000);
    }
    broadcastEvent('timer_pause', { remaining: 0, duration: timerState.duration });
    toggleFocusLock(false);
  };

  const calculateInputSeconds = () => (parseInt(inputH) || 0) * 3600 + (parseInt(inputM) || 0) * 60 + (parseInt(inputS) || 0);

  const handleSubjectChange = (val: string) => {
    setSubject(val);
    setSubjectError(false);
    sessionStorage.setItem(`subject:${roomId}`, val);
  };

  const startFromHistory = (histSubject: string) => {
    handleSubjectChange(histSubject);
    setShowHistory(false);
  };

  const handleDeleteSubject = async (histSubject: string) => {
    if (!window.confirm(`Delete all study history for ${histSubject}?`)) return;
    await deleteStudySubject(roomId, histSubject);
    loadHistory();
  };

  const handleStart = () => {
    if (!subject.trim()) { setSubjectError(true); return; }
    const durationSeconds = calculateInputSeconds();
    if (durationSeconds <= 0) return;
    const endTime = Date.now() + durationSeconds * 1000;
    broadcastEvent('timer_start', { duration: durationSeconds, remaining: durationSeconds, endTime });
  };

  const handleResume = () => {
    const endTime = Date.now() + timerState.remaining * 1000;
    broadcastEvent('timer_start', { duration: timerState.duration, remaining: timerState.remaining, endTime });
  };

  const handlePause = () => broadcastEvent('timer_pause', { remaining: timeLeft, duration: timerState.duration });

  const handleReset = () => {
    const durationSeconds = calculateInputSeconds() || 25 * 60;
    broadcastEvent('timer_reset', { remaining: durationSeconds, duration: durationSeconds });
  };

  // PERFECTED: Uses localStorage so GlobalFocusTrap can intercept URL changes instantly
  const toggleFocusLock = (locked: boolean) => {
    setIsFocusLocked(locked);
    setShowFocusWarning(false);
    if (locked) {
      localStorage.setItem('omnilume_focus_lock', roomId);
    } else {
      localStorage.removeItem('omnilume_focus_lock');
    }
  };

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const formatDuration = (totalMins: number) => {
    if (totalMins < 60) return `${totalMins}m`;
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  };

  const WorkspaceUI = (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-3xl border border-neutral-800 bg-[#0a0a0a] shadow-2xl">
      <div className="absolute top-0 inset-x-0 border-b border-neutral-800 bg-[#0a0a0a] z-10 flex flex-col">
        <div className="p-4 flex justify-between items-center">
          <span className="text-white font-semibold text-sm">Study Room Workspace</span>
          <div className="flex items-center gap-3">
            {saveMessage && <span className="text-emerald-400 text-xs font-bold bg-emerald-500/10 px-3 py-1 rounded-full animate-in fade-in">{saveMessage}</span>}
            <button onClick={() => setShowHistory(true)} className="flex items-center gap-1.5 px-3 py-1.5 bg-neutral-900 border border-neutral-800 hover:bg-neutral-800 text-neutral-400 hover:text-white rounded-lg text-xs font-bold transition cursor-pointer">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
              History
            </button>
          </div>
        </div>
        
        <div className="flex px-4 gap-6 border-t border-neutral-800/50 bg-[#111] overflow-x-auto no-scrollbar">
          {['timer', 'notes', 'whiteboard', 'pdf'].map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab as any)} className={`py-3 text-xs font-bold uppercase tracking-wider transition border-b-2 cursor-pointer ${activeTab === tab ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-neutral-500 hover:text-neutral-300'}`}>
              {tab}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 flex flex-col mt-[105px] overflow-y-auto">
        {activeTab === 'timer' && (
          <div className="flex-1 flex flex-col items-center justify-center p-6">
            
            <div className="flex flex-wrap items-start justify-center gap-4 mb-4 w-full max-w-2xl">
              <div className="flex-1 min-w-[200px] flex flex-col gap-1.5 relative">
                <label className="text-[10px] text-neutral-500 uppercase tracking-widest font-bold ml-1">Subject</label>
                <input type="text" value={subject} onChange={(e) => handleSubjectChange(e.target.value)} disabled={timerState.isRunning || !isOwnerOrAdmin} placeholder="Mathematics..." className={`w-full bg-[#121212] border ${subjectError ? 'border-red-500/50' : 'border-neutral-800'} rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500 transition disabled:opacity-50`} />
                
                {!timerState.isRunning && studyHistory.length > 0 && (
                  <div className="flex gap-2 mt-2 absolute top-full left-0">
                    {studyHistory.slice(0, 3).map((hist, idx) => (
                      <button key={idx} onClick={() => handleSubjectChange(hist.subject)} className="px-2.5 py-1 bg-neutral-900 border border-neutral-800 text-neutral-400 hover:text-white rounded-full text-[10px] font-bold transition cursor-pointer">
                        {hist.subject}
                      </button>
                    ))}
                  </div>
                )}
                {subjectError && <span className="text-red-500 text-[10px] lowercase font-semibold ml-1 absolute top-full left-1 mt-1">please enter a subject</span>}
              </div>
              
              <div className="flex gap-2">
                <div className="w-16 flex flex-col gap-1.5">
                  <label className="text-[10px] text-neutral-500 uppercase font-bold text-center">Hrs</label>
                  <input type="number" value={inputH} onChange={(e) => setInputH(e.target.value)} disabled={timerState.isRunning || !isOwnerOrAdmin} min="0" max="23" className="w-full bg-[#121212] border border-neutral-800 rounded-xl px-2 py-3 text-white text-center focus:outline-none focus:border-indigo-500 transition disabled:opacity-50 font-mono" />
                </div>
                <div className="w-16 flex flex-col gap-1.5">
                  <label className="text-[10px] text-neutral-500 uppercase font-bold text-center">Min</label>
                  <input type="number" value={inputM} onChange={(e) => setInputM(e.target.value)} disabled={timerState.isRunning || !isOwnerOrAdmin} min="0" max="59" className="w-full bg-[#121212] border border-neutral-800 rounded-xl px-2 py-3 text-white text-center focus:outline-none focus:border-indigo-500 transition disabled:opacity-50 font-mono" />
                </div>
                <div className="w-16 flex flex-col gap-1.5">
                  <label className="text-[10px] text-neutral-500 uppercase font-bold text-center">Sec</label>
                  <input type="number" value={inputS} onChange={(e) => setInputS(e.target.value)} disabled={timerState.isRunning || !isOwnerOrAdmin} min="0" max="59" className="w-full bg-[#121212] border border-neutral-800 rounded-xl px-2 py-3 text-white text-center focus:outline-none focus:border-indigo-500 transition disabled:opacity-50 font-mono" />
                </div>
              </div>
            </div>

            <div className="text-8xl md:text-[10rem] font-mono font-bold text-white tracking-tight mt-6 mb-12 tabular-nums drop-shadow-[0_0_40px_rgba(99,102,241,0.15)]">
              {formatTime(timeLeft)}
            </div>

            <div className="flex flex-wrap items-center justify-center gap-4">
              {!timerState.isRunning && timerState.remaining === timerState.duration && (
                <button onClick={handleStart} disabled={!isOwnerOrAdmin} className="px-8 py-4 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl font-bold transition disabled:opacity-50 cursor-pointer shadow-lg shadow-indigo-500/20">Start Session</button>
              )}
              {!timerState.isRunning && timerState.remaining < timerState.duration && timerState.remaining > 0 && (
                <button onClick={handleResume} disabled={!isOwnerOrAdmin} className="px-8 py-4 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl font-bold transition disabled:opacity-50 cursor-pointer shadow-lg shadow-indigo-500/20">Resume</button>
              )}
              {timerState.isRunning && (
                <button onClick={handlePause} disabled={!isOwnerOrAdmin} className="px-8 py-4 bg-amber-600 hover:bg-amber-500 text-white rounded-2xl font-bold transition disabled:opacity-50 cursor-pointer">Pause</button>
              )}
              <button onClick={handleReset} disabled={!isOwnerOrAdmin} className="px-6 py-4 bg-neutral-900 border border-neutral-800 hover:bg-neutral-800 text-white rounded-2xl font-bold transition disabled:opacity-50 cursor-pointer">Reset</button>
              <button onClick={() => { if(!timerState.isRunning) return; setShowFocusWarning(true); }} disabled={!timerState.isRunning || isFocusLocked} className={`px-6 py-4 rounded-2xl font-bold transition flex items-center gap-2 border ${timerState.isRunning && !isFocusLocked ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20 cursor-pointer' : 'bg-neutral-900 border-neutral-800 text-neutral-600 cursor-not-allowed'}`}>
                Focus Lock
              </button>
            </div>
          </div>
        )}

        {activeTab === 'notes' && (<div className="flex-1 p-6 flex flex-col"><div className="flex-1 border border-neutral-800 rounded-xl bg-[#121212] flex items-center justify-center"><p className="text-sm text-neutral-500">Collaborative notes pending deployment (Phase 33).</p></div></div>)}
        {activeTab === 'whiteboard' && (<div className="flex-1 p-6 flex flex-col"><div className="flex-1 border border-neutral-800 rounded-xl bg-[#121212] flex items-center justify-center"><p className="text-sm text-neutral-500">Whiteboard pending deployment (Phase 36).</p></div></div>)}
        {activeTab === 'pdf' && (<div className="flex-1 p-6 flex flex-col"><div className="flex-1 border border-neutral-800 rounded-xl bg-[#121212] flex items-center justify-center"><p className="text-sm text-neutral-500">PDF reader pending deployment (Phase 34).</p></div></div>)}
      </div>
    </div>
  );

  return (
    <section className="relative flex min-h-0 flex-1 flex-col p-4">
      {/* 1. SOFT WARNING MODAL */}
      {showFocusWarning && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[9999] bg-black/80 backdrop-blur-md flex items-center justify-center">
          <div className="bg-[#121212] border border-neutral-800 p-8 rounded-3xl max-w-md w-full shadow-2xl">
            <h3 className="text-2xl font-bold text-white mb-3">Enable Focus Lock?</h3>
            <p className="text-neutral-400 text-sm mb-6 leading-relaxed">
              After accepting, you will be locked inside this Room. You can still use the Chat, Media, and Notes, but you cannot navigate to other parts of the website or leave the room.
            </p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowFocusWarning(false)} className="px-5 py-2.5 text-white font-bold hover:bg-neutral-800 rounded-xl transition cursor-pointer">Cancel</button>
              <button onClick={() => toggleFocusLock(true)} className="px-5 py-2.5 bg-emerald-600 text-white font-bold hover:bg-emerald-500 rounded-xl transition shadow-lg shadow-emerald-900/50 cursor-pointer">Accept & Lock</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 2. HISTORY MODAL */}
      {showHistory && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[9999] bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-[#121212] border border-neutral-800 rounded-3xl max-w-lg w-full shadow-2xl flex flex-col max-h-[80vh]">
            <div className="p-6 border-b border-neutral-800 flex justify-between items-center">
              <h3 className="text-xl font-bold text-white">Study Analytics History</h3>
              <button onClick={() => setShowHistory(false)} className="text-neutral-500 hover:text-white transition p-2 cursor-pointer">✕</button>
            </div>
            <div className="p-6 overflow-y-auto flex-1 flex flex-col gap-4">
              {studyHistory.length === 0 ? (
                <p className="text-neutral-500 text-center py-8 text-sm">No study history recorded in this room yet.</p>
              ) : (
                studyHistory.map((hist, idx) => (
                  <div key={idx} className="bg-neutral-900 border border-neutral-800 p-4 rounded-2xl flex items-center justify-between group">
                    <div className="flex flex-col">
                      <span className="text-white font-bold text-lg">{hist.subject}</span>
                      <span className="text-neutral-500 text-xs">Total: <strong className="text-indigo-400">{formatDuration(hist.totalMinutes)}</strong> · Last: {new Date(hist.lastStudied).toLocaleDateString()}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => startFromHistory(hist.subject)} className="px-3 py-1.5 bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600/30 rounded-lg text-xs font-bold transition cursor-pointer">Load</button>
                      <button onClick={() => handleDeleteSubject(hist.subject)} className="px-3 py-1.5 bg-red-500/10 text-red-500 hover:bg-red-500/20 rounded-lg text-xs font-bold transition opacity-0 group-hover:opacity-100 cursor-pointer">Delete</button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 3. INVISIBLE FOCUS LOCK LAYER */}
      {isFocusLocked && typeof document !== 'undefined' && createPortal(
        <>
          <style dangerouslySetInnerHTML={{__html: `
            /* This disables the sidebar and global header natively */
            aside, header, nav, .global-leave-btn { 
              pointer-events: none !important; 
              opacity: 0.3 !important; 
            }
          `}} />
          <div className="fixed left-0 top-1/3 -rotate-90 origin-left translate-x-4 bg-emerald-600 text-white px-6 py-1.5 font-black text-[10px] tracking-[0.3em] uppercase z-[9999] rounded-t-md shadow-2xl pointer-events-none">
            Focus Mode Active
          </div>
          <button onClick={() => toggleFocusLock(false)} className="fixed bottom-6 left-6 z-[9999] px-5 py-2.5 bg-neutral-900 border border-neutral-700 text-neutral-300 hover:text-white hover:bg-neutral-800 rounded-full text-xs font-bold transition shadow-2xl cursor-pointer">
            Unlock Room
          </button>
        </>,
        document.body
      )}

      {/* 4. FLOATING MINI-TIMER */}
      {timerState.isRunning && activeTab !== 'timer' && typeof document !== 'undefined' && createPortal(
        <div onClick={() => setActiveTab('timer')} className="fixed bottom-6 right-6 bg-[#121212] border border-neutral-800 text-white px-5 py-3 rounded-2xl shadow-2xl cursor-pointer hover:border-indigo-500 transition-all z-[9999] flex items-center gap-4 group">
          <div className="flex flex-col">
            <span className="text-[10px] text-neutral-500 font-bold uppercase tracking-widest leading-none mb-1">{subject || 'Studying'}</span>
            <span className="font-mono font-bold text-xl leading-none text-indigo-400">{formatTime(timeLeft)}</span>
          </div>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5 text-neutral-600 group-hover:text-indigo-400 transition"><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>
        </div>,
        document.body
      )}

      {WorkspaceUI}
    </section>
  );
}