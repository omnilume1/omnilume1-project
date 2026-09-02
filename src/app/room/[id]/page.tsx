'use client';

import { useState, use, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import RoomChat from '@/components/room/RoomChat';
import MembersTab from '@/components/room/MembersTab';
import FilesTab from '@/components/room/FilesTab';
import MediaStage from '@/components/room/MediaStage'; 
import StudyStage, { StudyMiniTimer } from '@/components/room/StudyStage';
import { getRoomAccess } from '@/actions/members';
import { convertRoomToGroup } from '@/actions/rooms';
import {
  getPermanentRoomRequests,
  getRecoveryRequestStatus,
  getRoomRecoveryRequests,
  requestPermanentRoom,
  requestRoomRecovery,
  reviewPermanentRoomRequest,
  reviewRoomRecovery,
  type PermanentRoomRequest,
  type RecoveryRequest,
  type RecoveryRequestStatus,
} from '@/actions/recovery';
import RoomRealtimeProvider from '@/components/room/RoomRealtimeProvider';
import RoomNotifications from '@/components/room/RoomNotifications';
import { useRoomSync } from '@/hooks/useRoomSync';
import { useRoomPresence } from '@/hooks/useRoomPresence';
import { clearFocusLock } from '@/lib/focus-lock';
import { isRoomExpired } from '@/lib/room-lifecycle';

type AccessStatus = 'loading' | 'approved' | 'pending' | 'expired' | 'not_found' | 'unauthorized' | 'public_not_joined' | 'private_not_joined';

type RoomData = {
  id: string;
  name: string;
  is_private: boolean;
  created_by: string;
  username: string | null;
  expiration_type: string;
  expires_at: string | null;
  reopened_until?: string | null;
  is_group?: boolean;
};

export default function RoomPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params);
  const identifier = resolvedParams.id;
  const router = useRouter();

  const [accessStatus, setAccessStatus] = useState<AccessStatus>('loading');
  const [userRole, setUserRole] = useState<string | null>(null);
  const [roomData, setRoomData] = useState<RoomData | null>(null);

  const [timeLeft, setTimeLeft] = useState<string>('');
  const [isExpired, setIsExpired] = useState(false);
  const [recoveryStatus, setRecoveryStatus] = useState<RecoveryRequestStatus | 'none'>('none');
  const [recoverySubmitting, setRecoverySubmitting] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoveryRequests, setRecoveryRequests] = useState<RecoveryRequest[]>([]);
  const [permanentRequests, setPermanentRequests] = useState<PermanentRoomRequest[]>([]);
  const [permanentSubmitting, setPermanentSubmitting] = useState(false);
  const [lifecycleActionError, setLifecycleActionError] = useState<string | null>(null);

  const [showConvertModal, setShowConvertModal] = useState(false);
  const [groupUsername, setGroupUsername] = useState('');
  const [converting, setConverting] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);

  // ==========================================
  // DRAGGABLE SIDEBAR STATE
  // ==========================================
  const [sidebarWidth, setSidebarWidth] = useState(320); // Default 320px
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const newWidth = document.body.clientWidth - e.clientX;
      if (newWidth > 280 && newWidth < 600) {
        setSidebarWidth(newWidth);
      }
    };

    const handleMouseUp = () => setIsDragging(false);

    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = 'none'; 
    } else {
      document.body.style.userSelect = 'auto';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  const handleConvert = async () => {
    if (!groupUsername.trim()) return alert("Please provide a group username.");
    if (!roomData) return;
    setConverting(true);
    try {
      await convertRoomToGroup(roomData.id, groupUsername);
      setConverting(false);
      setShowConvertModal(false);
      setCountdown(5);

      const timer = setInterval(() => {
        setCountdown((prev) => {
          if (prev === null || prev <= 1) {
            clearInterval(timer);
            router.push(`/room/${groupUsername.toLowerCase()}`);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } catch (error: unknown) {
      alert(error instanceof Error ? error.message : 'Unable to upgrade this room.');
      setConverting(false);
    }
  };

  useEffect(() => {
    async function checkAccess() {
      try {
        const { status, role, room } = await getRoomAccess(identifier);
        setAccessStatus(status as AccessStatus);
        setUserRole(role);
        if (room) {
          setRoomData(room);
          setIsExpired(isRoomExpired(room));
        }
      } catch {
        setAccessStatus('not_found');
      }
    }
    checkAccess();
  }, [identifier]);

  useEffect(() => {
    if (!roomData || roomData.expiration_type === 'permanent') return;
    const expiresAt = roomData.reopened_until || roomData.expires_at;
    if (!expiresAt) return;

    const interval = setInterval(() => {
      const now = new Date().getTime();
      const expiry = new Date(expiresAt).getTime();
      const distance = expiry - now;

      if (distance <= 0) {
        setIsExpired(true);
        setTimeLeft('00:00:00');
        clearInterval(interval);
      } else {
        const h = Math.floor(distance / (1000 * 60 * 60));
        const m = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
        const s = Math.floor((distance % (1000 * 60)) / 1000);
        const format = (num: number) => num.toString().padStart(2, '0');
        setTimeLeft(`${h}h ${format(m)}m ${format(s)}s`);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [roomData]);

  useEffect(() => {
    if (accessStatus === 'not_found' || accessStatus === 'pending' || accessStatus === 'expired' || accessStatus === 'unauthorized' || accessStatus === 'public_not_joined' || accessStatus === 'private_not_joined' || isExpired) {
      clearFocusLock();
    }
  }, [accessStatus, isExpired]);

  useEffect(() => {
    if (!roomData || roomData.expiration_type !== 'recoverable' || (!isExpired && accessStatus !== 'expired')) return;

    let cancelled = false;
    void getRecoveryRequestStatus(roomData.id).then((result) => {
      if (cancelled) return;
      if (result.success) {
        setRecoveryStatus(result.request?.status ?? 'none');
        setRecoveryError(null);
      } else {
        setRecoveryStatus('none');
        setRecoveryError(result.error ?? 'Unable to load recovery status.');
      }
    });

    return () => {
      cancelled = true;
    };
  }, [accessStatus, isExpired, roomData]);

  useEffect(() => {
    if (!roomData || !['owner', 'admin'].includes(userRole ?? '') || (!isExpired && accessStatus !== 'expired')) return;

    let cancelled = false;
    void getRoomRecoveryRequests(roomData.id).then((result) => {
      if (!cancelled && result.success) setRecoveryRequests(result.requests ?? []);
    });
    return () => { cancelled = true; };
  }, [accessStatus, isExpired, roomData, userRole]);

  useEffect(() => {
    if (!roomData?.reopened_until || isExpired || accessStatus === 'expired') return;

    let cancelled = false;
    void getPermanentRoomRequests(roomData.id).then((result) => {
      if (!cancelled && result.success) setPermanentRequests(result.requests ?? []);
    });
    return () => { cancelled = true; };
  }, [accessStatus, isExpired, roomData]);

  const handleRecoveryRequest = async () => {
    if (!roomData || recoverySubmitting || recoveryStatus === 'pending') return;

    setRecoverySubmitting(true);
    setRecoveryError(null);
    const result = await requestRoomRecovery(roomData.id);
    if (result.success) {
      setRecoveryStatus(result.request?.status ?? 'pending');
    } else {
      setRecoveryError(result.error ?? 'Unable to submit recovery request.');
    }
    setRecoverySubmitting(false);
  };

  const handleRecoveryReview = async (requestId: string, decision: 'approved' | 'rejected') => {
    setLifecycleActionError(null);
    const result = await reviewRoomRecovery(requestId, decision);
    if (!result.success) {
      setLifecycleActionError(result.error ?? 'Unable to review recovery request.');
      return;
    }
    window.location.reload();
  };

  const handlePermanentRequest = async () => {
    if (!roomData || permanentSubmitting) return;
    setPermanentSubmitting(true);
    setLifecycleActionError(null);
    const result = await requestPermanentRoom(roomData.id);
    if (result.success && result.request) {
      setPermanentRequests((current) => [...current.filter((request) => request.id !== result.request?.id), result.request as PermanentRoomRequest]);
    } else {
      setLifecycleActionError(result.error ?? 'Unable to submit permanence request.');
    }
    setPermanentSubmitting(false);
  };

  const handlePermanentReview = async (requestId: string, decision: 'approved' | 'rejected') => {
    setLifecycleActionError(null);
    const result = await reviewPermanentRoomRequest(requestId, decision);
    if (!result.success) {
      setLifecycleActionError(result.error ?? 'Unable to review permanence request.');
      return;
    }
    window.location.reload();
  };

  const [mainActivity, setMainActivity] = useState<'watch' | 'study' | 'whiteboard'>('watch');
  const [activeTool, setActiveTool] = useState<'chat' | 'members' | 'files' | 'notes' | 'timer'>('chat');
  const [timerNavigationRequest, setTimerNavigationRequest] = useState(0);
  const roomIsExpired = accessStatus === 'expired' || isExpired;
  const roomSync = useRoomSync(roomIsExpired ? '' : (roomData?.id ?? ''), userRole === 'owner' || userRole === 'admin');
  const roomPresence = useRoomPresence(roomData?.id ?? '');
  const focusRoomPath = `/room/${encodeURIComponent(identifier)}`;

  if (accessStatus === 'loading') return <div className="h-screen bg-[#050505] text-neutral-500 flex items-center justify-center text-sm animate-pulse">Verifying secure access...</div>;
  if (accessStatus === 'not_found') return <div className="h-screen bg-black text-white flex flex-col items-center justify-center p-6 text-center"><h2 className="text-xl">❌ Space Not Found</h2><Link href="/explore" className="mt-4 px-5 py-2.5 bg-white text-black rounded font-semibold text-sm">Return to Explore</Link></div>;
  if (accessStatus === 'pending') return <div className="h-screen bg-black text-white flex flex-col items-center justify-center p-6 text-center"><h2 className="text-xl text-amber-500">⏳ Waiting for Approval</h2><Link href="/explore" className="mt-4 px-5 py-2.5 bg-neutral-900 border border-neutral-800 rounded font-medium text-sm">Explore other spaces</Link></div>;
  if (accessStatus === 'unauthorized' || accessStatus === 'public_not_joined' || accessStatus === 'private_not_joined') return <div className="h-screen bg-black text-white flex flex-col items-center justify-center p-6 text-center"><h2 className="text-xl text-red-500">🔒 Access Restricted</h2><Link href="/explore" className="mt-4 px-5 py-2.5 bg-white text-black rounded font-semibold text-sm">Go to Explore to Join</Link></div>;

  if (!roomData) return <div className="h-screen bg-[#050505] text-neutral-500 flex items-center justify-center text-sm">Loading room...</div>;

  if (showConvertModal) {
    return (
      <div className="h-screen bg-black/90 text-white flex flex-col items-center justify-center p-6 text-center absolute inset-0 z-50">
        <div className="max-w-md w-full border border-indigo-900/50 bg-[#0a0a0a] p-8 rounded-2xl shadow-2xl flex flex-col items-center">
          <div className="w-16 h-16 rounded-full bg-indigo-500/10 flex items-center justify-center text-2xl mb-4 border border-indigo-500/20">🚀</div>
          <h2 className="text-xl font-bold mb-2">Upgrade to Permanent Group</h2>
          <p className="text-sm text-neutral-400 mb-6">This will stop the self-destruct timer permanently. Your chat, files, and members will be preserved.</p>
          <div className="w-full text-left mb-6">
            <label className="block text-[10px] uppercase tracking-wider text-neutral-500 mb-2">Claim Group Username *</label>
            <div className="flex border border-neutral-800 rounded-md bg-[#050505] overflow-hidden focus-within:border-neutral-500 transition">
              <span className="bg-neutral-900 px-3 py-2.5 text-sm text-neutral-500 border-r border-neutral-800">omnilume.com/r/</span>
              <input type="text" value={groupUsername} onChange={(e) => setGroupUsername(e.target.value)} placeholder="my_awesome_group" className="w-full bg-transparent px-3 py-2.5 text-sm text-white outline-none" />
            </div>
          </div>
          <div className="flex w-full gap-3">
            <button onClick={() => setShowConvertModal(false)} className="flex-1 py-2.5 bg-neutral-900 border border-neutral-800 hover:bg-neutral-800 rounded-lg text-sm font-semibold transition">Cancel</button>
            <button onClick={handleConvert} disabled={converting || !groupUsername} className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-sm font-semibold transition disabled:opacity-50 text-white">{converting ? 'Upgrading...' : 'Confirm Upgrade'}</button>
          </div>
        </div>
      </div>
    );
  }

  if (countdown !== null) {
    return (
      <div className="h-screen bg-black/95 backdrop-blur-md text-white flex flex-col items-center justify-center p-6 text-center absolute inset-0 z-50 animate-in fade-in duration-300">
        <div className="w-20 h-20 rounded-full bg-indigo-500/20 border border-indigo-500/40 flex items-center justify-center text-3xl mb-6 animate-pulse">🚀</div>
        <h2 className="text-2xl font-bold mb-2">Transforming Space into Group...</h2>
        <p className="text-sm text-neutral-400 mb-8 max-w-sm">Pausing active streams, transferring room history, and securing permanent cloud archives.</p>
        <div className="text-5xl font-mono font-bold text-indigo-400 tracking-wider">00:0{countdown}</div>
        <p className="text-xs text-neutral-600 mt-6">Redirecting to your new permanent link shortly...</p>
      </div>
    );
  }

  if ((accessStatus === 'expired' || isExpired) && roomData) {
    const isIrreversible = roomData.expiration_type === 'irreversible';
    const recoveryCopy = recoveryStatus === 'pending'
      ? 'Recovery request pending review.'
      : recoveryStatus === 'approved'
        ? 'Recovery request approved.'
        : recoveryStatus === 'rejected'
          ? 'Recovery request was rejected.'
          : null;
    return (
      <div className="min-h-screen bg-black text-white flex flex-col items-center justify-center p-6 text-center">
        <div className="max-w-md w-full border border-neutral-800 bg-neutral-950 p-8 rounded-2xl shadow-2xl flex flex-col items-center">
          <div className="w-16 h-16 rounded-full bg-neutral-900 border border-neutral-800 flex items-center justify-center text-2xl mb-4">{isIrreversible ? '🔥' : '🔒'}</div>
          <h1 className={`text-xl font-bold mb-2 ${isIrreversible ? 'text-red-500' : 'text-amber-500'}`}>{isIrreversible ? 'Space Access Ended' : 'Space Quarantined'}</h1>
          <p className="text-sm text-neutral-400 mb-6">The timer hit zero. {isIrreversible ? 'Access has been cut off and the server cleanup process will permanently destroy this room.' : 'Data is preserved but inaccessible while the room is quarantined.'}</p>
          {!isIrreversible && (recoveryCopy ? <div className="w-full py-3 bg-emerald-950/40 border border-emerald-800 text-emerald-400 text-xs rounded-lg mb-4">{recoveryCopy}</div> : (userRole === 'owner' || userRole === 'admin') ? <button onClick={handleRecoveryRequest} disabled={recoverySubmitting} className="w-full py-2.5 bg-neutral-100 text-black font-semibold text-sm rounded-lg hover:bg-white disabled:cursor-wait disabled:opacity-60 mb-4">{recoverySubmitting ? 'Submitting...' : 'Request Admin Recovery'}</button> : <p className="w-full rounded-lg border border-neutral-800 bg-neutral-900/50 px-3 py-3 text-xs text-neutral-400">Only the current owner or admin can request recovery during this 24-hour window.</p>)}
          {!isIrreversible && recoveryRequests.filter((request) => request.status === 'pending').map((request) => (
            <div key={request.id} className="mb-4 w-full rounded-lg border border-indigo-900/50 bg-indigo-950/20 p-3 text-left text-xs text-indigo-200">
              <p>Recovery requested by User {request.requester_id}.</p>
              {(userRole === 'owner' || userRole === 'admin') && <div className="mt-2 flex gap-2"><button type="button" onClick={() => void handleRecoveryReview(request.id, 'approved')} className="rounded bg-emerald-700/70 px-3 py-1.5 font-bold">Approve and reopen for 7 days</button><button type="button" onClick={() => void handleRecoveryReview(request.id, 'rejected')} className="rounded bg-red-700/70 px-3 py-1.5 font-bold">Reject</button></div>}
            </div>
          ))}
          {recoveryError && <p className="mb-4 w-full rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-300">{recoveryError}</p>}
          <Link href="/explore" className="text-xs text-neutral-500 hover:text-white underline">Return to Explore</Link>
        </div>
      </div>
    );
  }

  return (
    <RoomRealtimeProvider sync={roomSync} presence={roomPresence}>
      <div className="h-screen bg-[#050505] text-neutral-200 flex flex-col font-sans overflow-hidden selection:bg-neutral-800">
      <header className="h-14 shrink-0 flex items-center justify-between px-6 border-b border-neutral-800 bg-[#0a0a0a]">
        <div className="flex items-center gap-4">
          <span className="font-semibold text-white tracking-wide text-sm uppercase">{roomData?.is_group ? 'GROUP' : 'ROOM'} / {roomData?.name || identifier}</span>
          <div className={`px-2.5 py-1 text-[10px] font-bold rounded-md tracking-wider flex items-center gap-2 border ${roomData?.expiration_type === 'permanent' ? 'bg-neutral-900/50 text-neutral-400 border-neutral-800' : 'bg-amber-950/20 text-amber-500 border-amber-900/30'}`}>
            {roomData?.expiration_type === 'permanent' ? 'PERMANENT' : `TEMP / ${timeLeft}`}
          </div>
        </div>
        <div className="flex items-center gap-4">
          {userRole === 'owner' && roomData?.expiration_type === 'recoverable' && !roomData.reopened_until && <button onClick={() => setShowConvertModal(true)} className="px-4 py-1.5 bg-indigo-500/10 border border-indigo-500/30 text-indigo-400 hover:bg-indigo-500/20 rounded text-xs font-semibold transition">🚀 Upgrade to Group</button>}
          {roomData.reopened_until && <button onClick={handlePermanentRequest} disabled={permanentSubmitting || permanentRequests.some((request) => request.status === 'pending')} className="px-4 py-1.5 bg-indigo-500/10 border border-indigo-500/30 text-indigo-400 hover:bg-indigo-500/20 rounded text-xs font-semibold transition disabled:cursor-wait disabled:opacity-50">{permanentSubmitting ? 'Requesting...' : 'Request Permanent Room'}</button>}
          <Link href="/explore" data-room-leave className="px-4 py-1.5 bg-neutral-100 hover:bg-white text-black rounded text-xs font-semibold transition">Leave</Link>
        </div>
      </header>

      <RoomNotifications roomId={roomData.id} />

      {roomData.reopened_until && permanentRequests.length > 0 && (
        <div className="border-b border-indigo-900/40 bg-indigo-950/20 px-6 py-2 text-xs text-indigo-200">
          {permanentRequests.map((request) => (
            <div key={request.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>Permanent-room request from User {request.requester_id}: {request.status}.</span>
              {request.status === 'pending' && (userRole === 'owner' || userRole === 'admin') && (
                <span className="flex gap-2">
                  <button type="button" onClick={() => void handlePermanentReview(request.id, 'approved')} className="rounded bg-emerald-700/70 px-2 py-1 text-[10px] font-bold">Approve</button>
                  <button type="button" onClick={() => void handlePermanentReview(request.id, 'rejected')} className="rounded bg-red-700/70 px-2 py-1 text-[10px] font-bold">Reject</button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {lifecycleActionError && <p className="border-b border-red-900/50 bg-red-950/30 px-6 py-2 text-xs text-red-300" role="alert">{lifecycleActionError}</p>}

      <div className="flex-1 flex overflow-hidden">
        <nav className="w-16 shrink-0 border-r border-neutral-800 bg-[#0a0a0a] flex flex-col items-center py-4 gap-6 z-10">
          <div className="flex flex-col gap-3 w-full px-2">
            <button onClick={() => setMainActivity('watch')} className={`p-3 rounded-lg flex items-center justify-center transition ${mainActivity === 'watch' ? 'bg-neutral-800 text-white' : 'text-neutral-500 hover:text-neutral-300'}`}>▶️</button>
            <button onClick={() => setMainActivity('study')} className={`p-3 rounded-lg flex items-center justify-center transition ${mainActivity === 'study' ? 'bg-neutral-800 text-white' : 'text-neutral-500 hover:text-neutral-300'}`}>📚</button>
          </div>
          <div className="w-8 h-px bg-neutral-800 my-2" />
          <div className="flex flex-col gap-3 w-full px-2">
            <button onClick={() => setActiveTool('chat')} className={`p-3 rounded-lg flex items-center justify-center transition ${activeTool === 'chat' ? 'bg-neutral-800 text-white' : 'text-neutral-500 hover:text-neutral-300'}`}>💬</button>
            <button onClick={() => setActiveTool('members')} className={`p-3 rounded-lg flex items-center justify-center transition ${activeTool === 'members' ? 'bg-neutral-800 text-white' : 'text-neutral-500 hover:text-neutral-300'}`}>👥</button>
            <button onClick={() => setActiveTool('files')} className={`p-3 rounded-lg flex items-center justify-center transition ${activeTool === 'files' ? 'bg-neutral-800 text-white' : 'text-neutral-500 hover:text-neutral-300'}`}>📁</button>
          </div>
        </nav>

        <main className="relative flex min-w-0 flex-1 flex-col bg-[#050505] p-0">
          {/* Keep the media element mounted while another room section is open.
              Hiding this layer visually preserves playback and audio position. */}
          <div
            aria-hidden={mainActivity !== 'watch'}
            className={`absolute inset-0 flex min-h-0 ${mainActivity === 'watch' ? 'z-10' : 'invisible pointer-events-none z-0'}`}
          >
            <MediaStage roomId={roomData.id} currentUserRole={userRole} />
          </div>

          {/* Keep the study timer mounted too, so it continues through room
              navigation and can finish/log a session outside the Study view. */}
          <div
            aria-hidden={mainActivity !== 'study'}
            className={`absolute inset-0 flex min-h-0 ${mainActivity === 'study' ? 'z-10' : 'invisible pointer-events-none z-0'}`}
          >
            <StudyStage
              roomId={roomData.id}
              focusRoomPath={focusRoomPath}
              timerNavigationRequest={timerNavigationRequest}
            />
          </div>

          {mainActivity !== 'study' && roomSync.timerState.isRunning && (
            <StudyMiniTimer
              roomId={roomData.id}
              timerState={roomSync.timerState}
              onOpen={() => {
                setMainActivity('study');
                setTimerNavigationRequest((request) => request + 1);
              }}
            />
          )}

          {mainActivity === 'whiteboard' && (
            <div className="relative z-10 flex min-h-0 flex-1 flex-col p-4">
              <div className="flex flex-1 items-center justify-center rounded-xl border border-neutral-800 bg-[#0a0a0a]">
                <span className="text-sm text-neutral-500">Whiteboard coming soon...</span>
              </div>
            </div>
          )}
        </main>

        {/* DRAGGABLE RESIZER HANDLE */}
        <div 
          onMouseDown={() => setIsDragging(true)}
          className={`w-1 cursor-col-resize hover:bg-neutral-500 transition-colors z-20 ${isDragging ? 'bg-indigo-500' : 'bg-transparent'}`}
          title="Drag to resize sidebar"
        />

        {/* DYNAMIC WIDTH SIDEBAR */}
        <aside style={{ width: `${sidebarWidth}px` }} className="border-l border-neutral-800 bg-[#0a0a0a] flex flex-col z-10 shrink-0">
          <div className="p-4 border-b border-neutral-800 flex justify-between items-center shrink-0">
            <h3 className="font-medium text-sm text-white uppercase tracking-wider">{activeTool}</h3>
          </div>
          <div className="flex-1 flex flex-col overflow-hidden min-w-0">
            {activeTool === 'chat' && roomData && <RoomChat roomId={roomData.id} />}
            {activeTool === 'members' && roomData && <MembersTab roomId={roomData.id} currentUserRole={userRole} />}
            {activeTool === 'files' && roomData && <FilesTab roomId={roomData.id} currentUserRole={userRole} />}
          </div>
        </aside>
      </div>
      </div>
    </RoomRealtimeProvider>
  );
}
