'use client';

import { unwrapAction } from '@/lib/action-result';
import { useState, use, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import RoomChat from '@/components/room/RoomChat';
import MembersTab from '@/components/room/MembersTab';
import FilesTab from '@/components/room/FilesTab';
import MediaStage from '@/components/room/MediaStage'; 
import StudyStage, { StudyMiniTimer } from '@/components/room/StudyStage';
import StudyWhiteboardPanel from '@/components/room/StudyWhiteboardPanel';
import { getRoomAccess } from '@/actions/members';
import { convertRoomToGroup } from '@/actions/rooms';
import {
  getPermanentRoomRequests,
  getRecoveryRequestStatus,
  requestPermanentRoom,
  requestRoomRecovery,
  reviewPermanentRoomRequest,
  type PermanentRoomRequest,
  type RecoveryRequestStatus,
} from '@/actions/recovery';
import RoomRealtimeProvider from '@/components/room/RoomRealtimeProvider';
import { VoiceRoomProvider } from '@/components/room/VoiceRoom';
import VoicePanel, { VoiceDock } from '@/components/room/VoicePanel';
import CollabPanel from '@/components/room/CollabPanel';
import RoomNotifications from '@/components/room/RoomNotifications';
import RoomControlCenter from '@/components/room/RoomControlCenter';
import RoomEntryPrompts from '@/components/room/RoomEntryPrompts';
import RoomAnnouncementBanner from '@/components/room/RoomAnnouncementBanner';
import RoomRoleChangeNotification from '@/components/room/RoomRoleChangeNotification';
import FloatingDock from '@/components/ui/FloatingDock';
import NotificationBell from '@/components/ui/NotificationBell';
import { OmniIcon } from '@/components/ui/OmniIcon';
import { leaveRoom, transferRoomOwnership } from '@/actions/room-controls';
import { getRoomMembersList } from '@/actions/members';
import { clearRoomRealtimeCache, useRoomSync } from '@/hooks/useRoomSync';
import { useRoomPresence } from '@/hooks/useRoomPresence';
import { clearFocusLock } from '@/lib/focus-lock';
import { isRoomExpired } from '@/lib/room-lifecycle';
import { roomWorkspacePreferenceKey } from '@/lib/room-workspace-preferences';
import { minimizeRoom } from '@/lib/minimized-rooms';
import RoomDashboard from '@/components/room/RoomDashboard';
import NowPlayingBar from '@/components/room/NowPlayingBar';
import RoomPulseBar from '@/components/room/RoomPulseBar';
import { BookmarkToggle } from '@/components/room/BookmarkButton';
import {
  DEFAULT_ROOM_APPEARANCE,
  HOME_CHAT_WIDTH,
  ROOM_LAYOUTS,
  ROOM_LAYOUT_DETAILS,
  ROOM_THEMES,
  ROOM_THEME_LABELS,
  clampHomeChatWidth,
  effectiveActivity,
  effectiveLayout,
  effectiveTheme,
  effectiveTool,
  isRoomLayout,
  isRoomTheme,
  sidePanelState,
  type RoomActivity,
  type RoomAppearance,
  type RoomLayout,
  type RoomTheme,
  type RoomTool,
} from '@/lib/room-layout';

type AccessStatus = 'loading' | 'approved' | 'pending' | 'expired' | 'recovery_window' | 'guest_expired' | 'scheduled' | 'not_found' | 'unauthorized' | 'public_not_joined' | 'private_not_joined' | 'blocked' | 'banned' | 'kicked';

type RoomData = {
  id: string;
  name: string;
  is_private: boolean;
  created_by: string;
  username: string | null;
  expiration_type: string;
  expires_at: string | null;
  reopened_until?: string | null;
  scheduled_for?: string | null;
  is_group?: boolean;
  deletion_scheduled_at?: string | null;
};

type RoomFeature = 'chat' | 'watch' | 'files' | 'study' | 'announcements';

const DEFAULT_FEATURE_FLAGS: Record<RoomFeature, boolean> = {
  chat: true,
  watch: true,
  files: true,
  study: true,
  announcements: true,
};

const MIN_SIDEBAR_WIDTH = 280;
const MAX_SIDEBAR_WIDTH = 600;

function clampSidebarWidth(width: number) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

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
  const [permanentRequests, setPermanentRequests] = useState<PermanentRoomRequest[]>([]);
  const [permanentSubmitting, setPermanentSubmitting] = useState(false);
  const [lifecycleActionError, setLifecycleActionError] = useState<string | null>(null);

  const [showConvertModal, setShowConvertModal] = useState(false);
  const [groupUsername, setGroupUsername] = useState('');
  const [converting, setConverting] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [conversionTarget, setConversionTarget] = useState<string | null>(null);
  const conversionNavigating = useRef(false);
  const [showControlCenter, setShowControlCenter] = useState(false);
  const [showLeaveConfirmation, setShowLeaveConfirmation] = useState(false);
  const [ownerLeaveStep, setOwnerLeaveStep] = useState<'choice' | 'transfer'>('choice');
  const [ownerTransferCandidates, setOwnerTransferCandidates] = useState<Array<{ user_id: string; role: string; join_status: string; guest_expires_at?: string | null }>>([]);
  const [ownerTransferTarget, setOwnerTransferTarget] = useState('');
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [featureFlags, setFeatureFlags] = useState<Record<RoomFeature, boolean>>(DEFAULT_FEATURE_FLAGS);
  const [canManageMembers, setCanManageMembers] = useState(false);
  const [canControlMedia, setCanControlMedia] = useState(false);
  const [presenceRefreshVersion, setPresenceRefreshVersion] = useState(0);
  const [controlCenterTab, setControlCenterTab] = useState<'user-control' | 'profile' | null>(null);
  const [controlCenterMemberId, setControlCenterMemberId] = useState<string | null>(null);
  // Action 09: owner-controlled appearance plus this member's own preset,
  // theme and panel sizes (browser storage keyed by room and user).
  const [appearance, setAppearance] = useState<RoomAppearance>(DEFAULT_ROOM_APPEARANCE);
  const [personalLayout, setPersonalLayout] = useState<RoomLayout | null>(null);
  const [personalTheme, setPersonalTheme] = useState<RoomTheme | null>(null);
  const [homeChatWidth, setHomeChatWidth] = useState<number>(HOME_CHAT_WIDTH.initial);
  // The panel a member opened on demand belongs to the layout it was opened
  // in, so choosing Stage focus always starts with the stage filling the room.
  const [stageChatOpenLayout, setStageChatOpenLayout] = useState<RoomLayout | null>(null);
  const [showLayoutMenu, setShowLayoutMenu] = useState(false);
  const workspacePreferencesLoadedRef = useRef<string | null>(null);
  const workspaceModeRef = useRef<'home' | 'stage'>('home');
  const sideInnerRef = useRef<HTMLDivElement>(null);
  const layoutMenuRef = useRef<HTMLDivElement>(null);

  // ==========================================
  // DRAGGABLE SIDEBAR STATE
  // ==========================================
  const [sidebarWidth, setSidebarWidth] = useState(320); // Default 320px
  const [isDragging, setIsDragging] = useState(false);
  const sidebarPreferenceLoadedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      if (workspaceModeRef.current === 'home') {
        // The home chat is centred, so its edge moves half as far as its width.
        const area = sideInnerRef.current?.parentElement?.getBoundingClientRect();
        if (area) setHomeChatWidth(clampHomeChatWidth(Math.abs(e.clientX - (area.left + area.width / 2)) * 2));
        return;
      }
      const newWidth = document.body.clientWidth - e.clientX;
      setSidebarWidth(clampSidebarWidth(newWidth));
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
    // Mirror the server-side cleaning in convertRoomToGroup so navigation
    // lands on the exact handle that gets claimed.
    const target = groupUsername.toLowerCase().replace(/[^a-z0-9_.]/g, '');
    if (!target) return alert("Please provide a group username.");
    setConverting(true);
    try {
      await convertRoomToGroup(roomData.id, groupUsername).then(unwrapAction);
      setConverting(false);
      setShowConvertModal(false);
      setConversionTarget(target);
      setCountdown(5);
    } catch (error: unknown) {
      alert(error instanceof Error ? error.message : 'Unable to upgrade this room.');
      setConverting(false);
    }
  };

  // Pure countdown ticker. The updater only computes the next value; side
  // effects (navigation) live in the dedicated effect below.
  useEffect(() => {
    if (countdown === null || countdown <= 0) return;
    const timer = setInterval(() => {
      setCountdown((prev) => (prev === null ? null : Math.max(0, prev - 1)));
    }, 1000);
    return () => clearInterval(timer);
  }, [countdown]);

  // Navigation runs in the effect phase once the countdown reaches zero and
  // the claimed group handle is known. The ref guards against repeated pushes.
  useEffect(() => {
    if (countdown !== 0 || !conversionTarget) return;
    if (conversionNavigating.current) return;
    conversionNavigating.current = true;
    router.push(`/room/${conversionTarget}`);
  }, [countdown, conversionTarget, router]);

  useEffect(() => {
    async function checkAccess() {
      try {
        const { status, role, room } = await getRoomAccess(identifier).then(unwrapAction);
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
    if (accessStatus === 'not_found' || accessStatus === 'pending' || accessStatus === 'expired' || accessStatus === 'recovery_window' || accessStatus === 'guest_expired' || accessStatus === 'scheduled' || accessStatus === 'unauthorized' || accessStatus === 'public_not_joined' || accessStatus === 'private_not_joined' || accessStatus === 'blocked' || accessStatus === 'banned' || accessStatus === 'kicked' || isExpired) {
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

  const [mainActivity, setMainActivity] = useState<RoomActivity>('home');
  const [activeTool, setActiveTool] = useState<RoomTool>('chat');
  const [timerNavigationRequest, setTimerNavigationRequest] = useState(0);
  const roomIsExpired = accessStatus === 'expired' || isExpired;
  const realtimeRoomId = accessStatus === 'approved' && !roomIsExpired ? (roomData?.id ?? '') : '';
  const roomSync = useRoomSync(realtimeRoomId, userRole === 'owner' || canControlMedia);
  const roomPresence = useRoomPresence(realtimeRoomId, presenceRefreshVersion);
  const sidebarPreferenceKey = roomWorkspacePreferenceKey(roomData?.id ?? '', roomSync.currentUserId, 'sidebar-width');
  useEffect(() => {
    sidebarPreferenceLoadedKeyRef.current = null;
    const timer = window.setTimeout(() => {
      if (!sidebarPreferenceKey) {
        setSidebarWidth(320);
        return;
      }
      const saved = window.localStorage.getItem(sidebarPreferenceKey);
      const parsed = saved ? Number(saved) : NaN;
      setSidebarWidth(Number.isFinite(parsed) ? clampSidebarWidth(parsed) : 320);
      sidebarPreferenceLoadedKeyRef.current = sidebarPreferenceKey;
    }, 0);
    return () => window.clearTimeout(timer);
  }, [sidebarPreferenceKey]);
  useEffect(() => {
    if (!sidebarPreferenceKey || sidebarPreferenceLoadedKeyRef.current !== sidebarPreferenceKey) return;
    window.localStorage.setItem(sidebarPreferenceKey, String(sidebarWidth));
  }, [sidebarPreferenceKey, sidebarWidth]);
  const layoutPreferenceKey = roomWorkspacePreferenceKey(roomData?.id ?? '', roomSync.currentUserId, 'layout');
  const themePreferenceKey = roomWorkspacePreferenceKey(roomData?.id ?? '', roomSync.currentUserId, 'theme');
  const homeChatPreferenceKey = roomWorkspacePreferenceKey(roomData?.id ?? '', roomSync.currentUserId, 'home-chat-width');
  useEffect(() => {
    workspacePreferencesLoadedRef.current = null;
    const timer = window.setTimeout(() => {
      const readValue = (key: string | null) => (key ? window.localStorage.getItem(key) : null);
      const savedLayout = readValue(layoutPreferenceKey);
      const savedTheme = readValue(themePreferenceKey);
      const savedWidth = Number(readValue(homeChatPreferenceKey));
      setPersonalLayout(isRoomLayout(savedLayout) ? savedLayout : null);
      setPersonalTheme(isRoomTheme(savedTheme) ? savedTheme : null);
      setHomeChatWidth(Number.isFinite(savedWidth) && savedWidth > 0 ? clampHomeChatWidth(savedWidth) : HOME_CHAT_WIDTH.initial);
      workspacePreferencesLoadedRef.current = layoutPreferenceKey;
    }, 0);
    return () => window.clearTimeout(timer);
  }, [homeChatPreferenceKey, layoutPreferenceKey, themePreferenceKey]);
  useEffect(() => {
    if (!layoutPreferenceKey || workspacePreferencesLoadedRef.current !== layoutPreferenceKey) return;
    const write = (key: string | null, value: string | null) => {
      if (!key) return;
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    };
    write(layoutPreferenceKey, personalLayout);
    write(themePreferenceKey, personalTheme);
    write(homeChatPreferenceKey, String(homeChatWidth));
  }, [homeChatPreferenceKey, homeChatWidth, layoutPreferenceKey, personalLayout, personalTheme, themePreferenceKey]);
  useEffect(() => {
    if (!showLayoutMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && layoutMenuRef.current?.contains(event.target)) return;
      setShowLayoutMenu(false);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setShowLayoutMenu(false); };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [showLayoutMenu]);
  useEffect(() => {
    const currentUserId = roomSync.currentUserId;
    const removed = roomSync.roomControlEvents.find((event) => event.subjectUserId === currentUserId && ((event.eventType === 'membership_changed' && event.payload.action === 'kick') || (event.eventType === 'restriction_changed' && (event.payload.action === 'ban' || event.payload.action === 'block'))));
    if (!removed) return;
    // UX only. The server already denies a removed member's fetches and
    // Postgres Changes; this just stops the realtime hooks (realtimeRoomId
    // becomes empty), drops cached room media state, and leaves the room.
    const removedRoomId = roomData?.id ?? '';
    const timer = window.setTimeout(() => {
      clearRoomRealtimeCache(removedRoomId);
      setAccessStatus(removed.eventType === 'restriction_changed' ? 'blocked' : 'kicked');
      clearFocusLock();
      router.replace(`/explore?roomNotice=${removed.eventType === 'restriction_changed' ? 'blocked' : 'kicked'}`);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [roomData?.id, roomSync.currentUserId, roomSync.roomControlEvents, router]);
  const focusRoomPath = `/room/${encodeURIComponent(identifier)}`;
  const featureEnabled = (feature: RoomFeature) => featureFlags[feature] !== false;
  // A disabled feature never leaves an empty stage or panel.
  const activity = effectiveActivity(mainActivity, featureFlags);
  const tool = effectiveTool(activeTool, featureFlags);
  const layout = effectiveLayout(appearance, personalLayout);
  const theme = effectiveTheme(appearance, personalTheme);
  const sidePanel = sidePanelState(activity, layout, stageChatOpenLayout === layout);
  useEffect(() => { workspaceModeRef.current = sidePanel.mode; }, [sidePanel.mode]);
  const openTool = (next: RoomTool) => {
    setActiveTool(next);
    setStageChatOpenLayout(layout);
  };
  const isHomeMode = sidePanel.mode === 'home';
  const resizeBounds = isHomeMode ? { min: HOME_CHAT_WIDTH.min, max: HOME_CHAT_WIDTH.max, value: homeChatWidth } : { min: MIN_SIDEBAR_WIDTH, max: MAX_SIDEBAR_WIDTH, value: sidebarWidth };
  const handleControlStateChange = useCallback(({ featureFlags: nextFlags, canManageMembers: nextCanManageMembers, canControlMedia: nextCanControlMedia, appearance: nextAppearance }: { featureFlags: Partial<Record<RoomFeature, boolean>>; canManageMembers: boolean; canControlMedia: boolean; isGhostMode: boolean; appearance: RoomAppearance }) => {
    setFeatureFlags({ ...DEFAULT_FEATURE_FLAGS, ...nextFlags });
    setAppearance(nextAppearance);
    setCanManageMembers(nextCanManageMembers);
    setCanControlMedia(nextCanControlMedia);
    setPresenceRefreshVersion((version) => version + 1);
  }, []);

  const handleLeave = async () => {
    if (!roomData || leaving) return;
    setLeaving(true);
    setLeaveError(null);
    try {
      await leaveRoom(roomData.id).then(unwrapAction);
      clearRoomRealtimeCache(roomData.id);
      router.push('/explore');
    } catch (error) {
      setLeaveError(error instanceof Error ? error.message : 'Unable to leave this room.');
      setLeaving(false);
    }
  };

  const openOwnerTransfer = async () => {
    if (!roomData || leaving) return;
    setLeaving(true);
    setLeaveError(null);
    try {
      const members = await getRoomMembersList(roomData.id).then(unwrapAction) as Array<{ user_id: string; role: string; join_status: string; guest_expires_at?: string | null }>;
      const eligible = members.filter((member) => member.user_id !== roomData.created_by && member.join_status === 'approved' && member.role !== 'guest' && !member.guest_expires_at);
      if (eligible.length === 0) throw new Error('No eligible permanent member is available to receive ownership.');
      setOwnerTransferCandidates(eligible);
      setOwnerTransferTarget(eligible[0].user_id);
      setOwnerLeaveStep('transfer');
    } catch (error) {
      setLeaveError(error instanceof Error ? error.message : 'Unable to load eligible members.');
    } finally {
      setLeaving(false);
    }
  };

  const completeOwnerTransferAndLeave = async () => {
    if (!roomData || !ownerTransferTarget || leaving) return;
    setLeaving(true);
    setLeaveError(null);
    try {
      await transferRoomOwnership(roomData.id, ownerTransferTarget).then(unwrapAction);
      await leaveRoom(roomData.id).then(unwrapAction);
      clearRoomRealtimeCache(roomData.id);
      router.push('/explore');
    } catch (error) {
      setLeaveError(error instanceof Error ? error.message : 'Unable to transfer ownership and leave this room.');
      setLeaving(false);
    }
  };

  const minimizeActiveRoom = () => {
    if (!roomData) return;
    minimizeRoom(roomData.id);
    router.push('/explore?roomNotice=minimized');
  };

  if (accessStatus === 'loading') return <div className="omni-state-screen text-sm text-neutral-500">Verifying secure access...</div>;
  if (accessStatus === 'not_found') return <div className="h-screen bg-black text-white flex flex-col items-center justify-center p-6 text-center"><h2 className="text-xl">❌ Space Not Found</h2><Link href="/explore" className="mt-4 px-5 py-2.5 bg-white text-black rounded font-semibold text-sm">Return to Explore</Link></div>;
  if (accessStatus === 'pending') return <div className="h-screen bg-black text-white flex flex-col items-center justify-center p-6 text-center"><h2 className="text-xl text-amber-500">⏳ Waiting for Approval</h2><Link href="/explore" className="mt-4 px-5 py-2.5 bg-neutral-900 border border-neutral-800 rounded font-medium text-sm">Explore other spaces</Link></div>;
  if (accessStatus === 'scheduled') return <div className="h-screen bg-black text-white flex flex-col items-center justify-center p-6 text-center"><h2 className="text-xl text-violet-300">⏰ This room is scheduled</h2><p className="mt-2 text-sm text-neutral-500">The room will open at {roomData?.scheduled_for ? new Date(roomData.scheduled_for).toLocaleString() : 'its scheduled time'}.</p><Link href="/explore" className="mt-4 px-5 py-2.5 bg-neutral-900 border border-neutral-800 rounded font-medium text-sm">Explore other spaces</Link></div>;
  if (accessStatus === 'guest_expired') return <div className="h-screen bg-black text-white flex flex-col items-center justify-center p-6 text-center"><h2 className="text-xl text-amber-400">Guest access has expired</h2><p className="mt-2 text-sm text-neutral-500">Ask a room manager for a new invitation if you need access again.</p><Link href="/explore" className="mt-4 px-5 py-2.5 bg-neutral-900 border border-neutral-800 rounded font-medium text-sm">Explore other spaces</Link></div>;
  if (accessStatus === 'kicked') return <div className="h-screen bg-black text-white flex flex-col items-center justify-center p-6 text-center"><h2 className="text-xl text-red-400">You were kicked from this room.</h2><p className="mt-2 text-sm text-neutral-500">Your active room session has ended.</p><Link href="/explore" className="mt-4 px-5 py-2.5 bg-white text-black rounded font-semibold text-sm">Return to Rooms</Link></div>;
  if (accessStatus === 'blocked' || accessStatus === 'banned') return <div className="h-screen bg-black text-white flex flex-col items-center justify-center p-6 text-center"><h2 className="text-xl text-red-400">You have been blocked from this room.</h2><p className="mt-2 text-sm text-neutral-500">Room access is not available for this account.</p><Link href="/explore" className="mt-4 px-5 py-2.5 bg-white text-black rounded font-semibold text-sm">Return to Rooms</Link></div>;
  if (accessStatus === 'unauthorized' || accessStatus === 'public_not_joined' || accessStatus === 'private_not_joined') return <div className="h-screen bg-black text-white flex flex-col items-center justify-center p-6 text-center"><h2 className="text-xl text-red-500">🔒 Access Restricted</h2><Link href="/explore" className="mt-4 px-5 py-2.5 bg-white text-black rounded font-semibold text-sm">Go to Explore to Join</Link></div>;

  if (!roomData) return <div className="omni-state-screen text-sm text-neutral-500">Loading room...</div>;

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

  if ((accessStatus === 'expired' || accessStatus === 'recovery_window' || isExpired) && roomData) {
    const isIrreversible = roomData.expiration_type === 'irreversible';
    // Each member sees only the status of their own request; site owners
    // review requests at /admin/recovery.
    const recoveryCopy = recoveryStatus === 'pending'
      ? 'Your recovery request is waiting for a site owner to review it.'
      : recoveryStatus === 'approved'
        ? 'Your recovery request was approved. Reload the page to enter the room.'
        : recoveryStatus === 'rejected'
          ? 'Your recovery request was rejected.'
          : null;
    const canRequestRecovery = ['owner', 'admin', 'member'].includes(userRole ?? '');
    return (
      <div className="min-h-screen bg-black text-white flex flex-col items-center justify-center p-6 text-center">
        <div className="max-w-md w-full border border-neutral-800 bg-neutral-950 p-8 rounded-2xl shadow-2xl flex flex-col items-center">
          <div className="w-16 h-16 rounded-full bg-neutral-900 border border-neutral-800 flex items-center justify-center text-2xl mb-4">{isIrreversible ? '🔥' : '🔒'}</div>
          <h1 className={`text-xl font-bold mb-2 ${isIrreversible ? 'text-red-500' : 'text-amber-500'}`}>{isIrreversible ? 'Space Access Ended' : 'Space Quarantined'}</h1>
          <p className="text-sm text-neutral-400 mb-6">The timer hit zero. {isIrreversible ? 'Access has been cut off and the server cleanup process will permanently destroy this room.' : 'Data is preserved but inaccessible for 7 days. If no recovery is requested in that time, the room and all of its chats and files are permanently deleted.'}</p>
          {!isIrreversible && (recoveryCopy ? <div className="w-full py-3 bg-emerald-950/40 border border-emerald-800 text-emerald-400 text-xs rounded-lg mb-4">{recoveryCopy}</div> : canRequestRecovery ? <><button onClick={handleRecoveryRequest} disabled={recoverySubmitting} className="w-full py-2.5 bg-neutral-100 text-black font-semibold text-sm rounded-lg hover:bg-white disabled:cursor-wait disabled:opacity-60 mb-2">{recoverySubmitting ? 'Submitting...' : 'Request recovery'}</button><p className="mb-4 text-xs text-neutral-500">Any member can ask during this 7-day window. A site owner reviews each request.</p></> : <p className="w-full rounded-lg border border-neutral-800 bg-neutral-900/50 px-3 py-3 text-xs text-neutral-400">Room members can request recovery during this 7-day window.</p>)}
          {recoveryError && <p className="mb-4 w-full rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-300">{recoveryError}</p>}
          <Link href="/explore" className="text-xs text-neutral-500 hover:text-white underline">Return to Explore</Link>
        </div>
      </div>
    );
  }

  return (
    <RoomRealtimeProvider sync={roomSync} presence={roomPresence}>
    <VoiceRoomProvider roomId={roomData.id}>
      <div className="room-shell flex h-screen flex-col overflow-hidden font-sans selection:bg-neutral-800" data-room-theme={theme}>
      <header className="room-header shrink-0">
        <div className="room-header-title flex items-center gap-4">
          <span className="font-semibold text-white tracking-wide text-sm uppercase">{roomData?.is_group ? 'GROUP' : 'ROOM'} / {roomData?.name || identifier}</span>
          <div className={`px-2.5 py-1 text-[10px] font-bold rounded-md tracking-wider flex items-center gap-2 border ${roomData?.expiration_type === 'permanent' ? 'bg-neutral-900/50 text-neutral-400 border-neutral-800' : 'bg-amber-950/20 text-amber-500 border-amber-900/30'}`}>
            {roomData?.expiration_type === 'permanent' ? 'PERMANENT' : `TEMP / ${timeLeft}`}
          </div>
        </div>
        <div className="room-actions flex items-center gap-4">
          {userRole === 'owner' && roomData?.expiration_type === 'recoverable' && !roomData.reopened_until && <button onClick={() => setShowConvertModal(true)} className="px-4 py-1.5 bg-indigo-500/10 border border-indigo-500/30 text-indigo-400 hover:bg-indigo-500/20 rounded text-xs font-semibold transition">Upgrade to Group</button>}
          {roomData.reopened_until && <button onClick={handlePermanentRequest} disabled={permanentSubmitting || permanentRequests.some((request) => request.status === 'pending')} className="px-4 py-1.5 bg-indigo-500/10 border border-indigo-500/30 text-indigo-400 hover:bg-indigo-500/20 rounded text-xs font-semibold transition disabled:cursor-wait disabled:opacity-50">{permanentSubmitting ? 'Requesting...' : 'Request Permanent Room'}</button>}
          <div className="room-layout-menu" ref={layoutMenuRef}>
            <button type="button" className="room-action" aria-haspopup="dialog" aria-expanded={showLayoutMenu} onClick={() => setShowLayoutMenu((open) => !open)} title="Layout and theme"><OmniIcon name="rooms" size={14} /><span>Layout</span></button>
            {showLayoutMenu && (
              <div role="dialog" aria-label="Layout and theme" className="room-layout-popover">
                <fieldset disabled={appearance.layoutLocked}>
                  <legend className="room-layout-legend">Layout</legend>
                  {appearance.layoutLocked && <p className="room-layout-hint">Locked by the room: {ROOM_LAYOUT_DETAILS[appearance.defaultLayout].label}.</p>}
                  <label className="room-layout-option">
                    <input type="radio" name="room-personal-layout" checked={personalLayout === null || appearance.layoutLocked} onChange={() => setPersonalLayout(null)} />
                    <span><strong>Room default</strong><small>{ROOM_LAYOUT_DETAILS[appearance.defaultLayout].label}</small></span>
                  </label>
                  {ROOM_LAYOUTS.map((option) => (
                    <label key={option} className="room-layout-option">
                      <input type="radio" name="room-personal-layout" checked={!appearance.layoutLocked && personalLayout === option} onChange={() => setPersonalLayout(option)} />
                      <span><strong>{ROOM_LAYOUT_DETAILS[option].label}</strong><small>{ROOM_LAYOUT_DETAILS[option].description}</small></span>
                    </label>
                  ))}
                </fieldset>
                <label className="room-layout-legend mt-3 block" htmlFor="room-personal-theme">Theme</label>
                <select id="room-personal-theme" className="omni-input mt-1" value={personalTheme ?? ''} onChange={(event) => setPersonalTheme(isRoomTheme(event.target.value) ? event.target.value : null)}>
                  <option value="">Room theme ({ROOM_THEME_LABELS[appearance.theme]})</option>
                  {ROOM_THEMES.map((option) => <option key={option} value={option}>{ROOM_THEME_LABELS[option]}</option>)}
                </select>
                <button type="button" className="omni-button omni-button-ghost mt-3 w-full" onClick={() => { setSidebarWidth(320); setHomeChatWidth(HOME_CHAT_WIDTH.initial); }}>Reset panel sizes</button>
                <p className="room-layout-hint mt-2">Your layout, theme and panel sizes are saved on this device for you only.</p>
              </div>
            )}
          </div>
          <BookmarkToggle roomId={roomData.id} kind="room" entityId={roomData.id} className="room-action" labels={['☆ Save', '★ Saved']} subject="room" />
          <NotificationBell roomId={roomData.id} />
          <button type="button" onClick={() => setShowControlCenter(true)} className="room-action room-action-controls"><OmniIcon name="settings" size={14} /><span>Controls</span></button>
          <button type="button" onClick={minimizeActiveRoom} className="room-action" title="Return to Rooms without leaving"><span aria-hidden="true">—</span><span>Minimize room</span></button>
          <button type="button" onClick={() => { setLeaveError(null); setShowLeaveConfirmation(true); }} data-room-leave className="room-action room-action-leave">Leave</button>
        </div>
      </header>

      <RoomNotifications roomId={roomData.id} />
      <RoomRoleChangeNotification events={roomSync.roomControlEvents} currentUserId={roomSync.currentUserId} />
      <RoomPulseBar roomId={roomData.id} />
      <RoomAnnouncementBanner roomId={roomData.id} />
      <RoomEntryPrompts roomId={roomData.id} onOpenRoomProfile={() => { setControlCenterTab('profile'); setShowControlCenter(true); }} />

      {roomData.reopened_until && permanentRequests.length > 0 && (
        <div className="room-state-bar rounded-none border-x-0 border-t-0">
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
      {roomData.expiration_type === 'permanent' && roomData.deletion_scheduled_at && <p className="border-b border-red-900/50 bg-red-950/30 px-6 py-2 text-xs text-red-200" role="status">This room is scheduled for permanent deletion on {new Date(roomData.deletion_scheduled_at).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' })}. Chats and files will be deleted unless the owner cancels.</p>}

      <div className="room-content flex-1 overflow-hidden" data-workspace-mode={sidePanel.mode} data-layout={layout}>
        <nav className="workspace-rail z-10">
          <div className="workspace-rail-group w-full">
            <button type="button" aria-label="Room home" title="Room home" aria-pressed={activity === 'home'} onClick={() => setMainActivity('home')} className={`workspace-tool ${activity === 'home' ? 'is-active' : ''}`}><OmniIcon name="home" size={17} /></button>
            <button type="button" aria-label="Watch" title={featureEnabled('watch') ? 'Watch' : 'Watch is turned off by this room'} aria-pressed={activity === 'watch'} disabled={!featureEnabled('watch')} onClick={() => setMainActivity('watch')} className={`workspace-tool ${activity === 'watch' ? 'is-active' : ''} ${!featureEnabled('watch') ? 'opacity-40' : ''}`}><OmniIcon name="play" size={17} /></button>
            <button type="button" aria-label="Study" title={featureEnabled('study') ? 'Study' : 'Study is turned off by this room'} aria-pressed={activity === 'study'} disabled={!featureEnabled('study')} onClick={() => setMainActivity('study')} className={`workspace-tool ${activity === 'study' ? 'is-active' : ''} ${!featureEnabled('study') ? 'opacity-40' : ''}`}><OmniIcon name="study" size={18} /></button>
            <button type="button" aria-label="Whiteboard" title={featureEnabled('study') ? 'Whiteboard' : 'The whiteboard is part of Study, which this room has turned off'} aria-pressed={activity === 'whiteboard'} disabled={!featureEnabled('study')} onClick={() => setMainActivity('whiteboard')} className={`workspace-tool ${activity === 'whiteboard' ? 'is-active' : ''} ${!featureEnabled('study') ? 'opacity-40' : ''}`}><OmniIcon name="pen" size={17} /></button>
          </div>
          <div className="my-2 h-px w-8 bg-neutral-800" />
          <div className="workspace-rail-group w-full">
            <button type="button" aria-label="Chat" title={featureEnabled('chat') ? 'Chat' : 'Chat is turned off by this room'} aria-pressed={tool === 'chat' && sidePanel.visible} disabled={!featureEnabled('chat')} onClick={() => openTool('chat')} className={`workspace-tool ${tool === 'chat' && sidePanel.visible ? 'is-active' : ''} ${!featureEnabled('chat') ? 'opacity-40' : ''}`}><OmniIcon name="message" size={17} /></button>
            <button type="button" aria-label="Members" title="Members" aria-pressed={tool === 'members' && sidePanel.visible} onClick={() => openTool('members')} className={`workspace-tool ${tool === 'members' && sidePanel.visible ? 'is-active' : ''}`}><OmniIcon name="users" size={17} /></button>
            <button type="button" aria-label="Voice" title={featureEnabled('chat') ? 'Voice, screen share and raise hand' : 'Voice needs room chat, which this room has turned off'} aria-pressed={tool === 'voice' && sidePanel.visible} disabled={!featureEnabled('chat')} onClick={() => openTool('voice')} className={`workspace-tool ${tool === 'voice' && sidePanel.visible ? 'is-active' : ''} ${!featureEnabled('chat') ? 'opacity-40' : ''}`}><OmniIcon name="mic" size={17} /></button>
            <button type="button" aria-label="Collaborate" title={featureEnabled('chat') ? 'Polls, countdowns, events and search' : 'Collaborate needs room chat, which this room has turned off'} aria-pressed={tool === 'collab' && sidePanel.visible} disabled={!featureEnabled('chat')} onClick={() => openTool('collab')} className={`workspace-tool ${tool === 'collab' && sidePanel.visible ? 'is-active' : ''} ${!featureEnabled('chat') ? 'opacity-40' : ''}`}><OmniIcon name="poll" size={17} /></button>
            <button type="button" aria-label="Files" title={featureEnabled('files') ? 'Files' : 'Files are turned off by this room'} aria-pressed={tool === 'files' && sidePanel.visible} disabled={!featureEnabled('files')} onClick={() => openTool('files')} className={`workspace-tool ${tool === 'files' && sidePanel.visible ? 'is-active' : ''} ${!featureEnabled('files') ? 'opacity-40' : ''}`}><OmniIcon name="file" size={17} /></button>
          </div>
        </nav>

        <main className="workspace-main relative flex min-w-0 flex-1 flex-col p-0">
          {/* Keep the media element mounted while another room section is open.
              Hiding this layer visually preserves playback and audio position. */}
          <div
            data-stage-layer
            aria-hidden={activity !== 'watch'}
            className={`absolute inset-0 flex min-h-0 ${activity === 'watch' ? 'z-10' : 'invisible pointer-events-none z-0'}`}
          >
            {featureEnabled('watch') ? <MediaStage roomId={roomData.id} canControlMedia={userRole === 'owner' || canControlMedia} /> : <RoomFeatureUnavailable label="Watch" />}
          </div>

          {/* Keep the study timer mounted too, so it continues through room
              navigation and can finish/log a session outside the Study view. */}
          <div
            data-stage-layer
            aria-hidden={activity !== 'study'}
            data-now-playing-pad
            className={`absolute inset-0 flex min-h-0 ${activity === 'study' ? 'z-10' : 'invisible pointer-events-none z-0'}`}
          >
            {featureEnabled('study') ? <StudyStage
              roomId={roomData.id}
              focusRoomPath={focusRoomPath}
              timerNavigationRequest={timerNavigationRequest}
              onOpenWatch={featureEnabled('watch') ? () => setMainActivity('watch') : undefined}
            /> : <RoomFeatureUnavailable label="Study" />}
          </div>

          {activity === 'home' && (
            <div data-now-playing-pad className="room-dashboard-layer relative z-10 flex min-h-0 flex-1 flex-col overflow-y-auto">
              <RoomDashboard
                roomId={roomData.id}
                room={roomData}
                timeLeft={timeLeft}
                featureFlags={featureFlags}
                onOpenActivity={setMainActivity}
                onOpenTool={openTool}
              />
            </div>
          )}

          {activity !== 'watch' && featureEnabled('watch') && roomSync.mediaState && (
            <div className="now-playing-slot">
              <NowPlayingBar roomId={roomData.id} onOpen={() => setMainActivity('watch')} />
            </div>
          )}

          {activity !== 'study' && activity !== 'home' && roomSync.timerState.isRunning && (
            <StudyMiniTimer
              roomId={roomData.id}
              timerState={roomSync.timerState}
              onOpen={() => {
                setMainActivity('study');
                setTimerNavigationRequest((request) => request + 1);
              }}
            />
          )}

          {activity === 'whiteboard' && (
            <div data-now-playing-pad className="relative z-10 flex min-h-0 flex-1 flex-col p-3">
              {featureEnabled('study')
                ? <StudyWhiteboardPanel roomId={roomData.id} />
                : <div className="flex flex-1 items-center justify-center rounded-xl border border-neutral-800 bg-[#0a0a0a] p-6 text-center text-sm text-neutral-500">The whiteboard is part of Study, which this room has disabled.</div>}
            </div>
          )}
        </main>

        {/* DYNAMIC WIDTH SIDEBAR */}
        {/* One panel element in every mode: CSS places it in the centre at
            room home and beside the stage when a feature is open, so chat,
            members and files never remount when the layout changes. */}
        <aside
          style={{ ['--sidebar-width' as string]: `${sidebarWidth}px`, ['--home-chat-width' as string]: `${homeChatWidth}px` }}
          className="workspace-side z-10 shrink-0"
          data-placement={sidePanel.placement}
          data-collapsed={sidePanel.visible ? undefined : 'true'}
        >
          <div ref={sideInnerRef} className="workspace-side-inner">
            {/* The handle stays on the panel edge while its width changes. */}
            <div
              role="separator"
              tabIndex={0}
              aria-label={isHomeMode ? 'Resize the centred chat panel' : 'Resize chat panel'}
              aria-orientation="vertical"
              aria-valuemin={resizeBounds.min}
              aria-valuemax={resizeBounds.max}
              aria-valuenow={resizeBounds.value}
              onMouseDown={() => setIsDragging(true)}
              onDoubleClick={() => (isHomeMode ? setHomeChatWidth(HOME_CHAT_WIDTH.initial) : setSidebarWidth(320))}
              onKeyDown={(event) => {
                const grow = isHomeMode ? event.key === 'ArrowRight' : event.key === 'ArrowLeft';
                const shrink = isHomeMode ? event.key === 'ArrowLeft' : event.key === 'ArrowRight';
                const apply = (next: (width: number) => number) => (isHomeMode
                  ? setHomeChatWidth((width) => clampHomeChatWidth(next(width)))
                  : setSidebarWidth((width) => clampSidebarWidth(next(width))));
                if (grow) {
                  event.preventDefault();
                  apply((width) => width + 40);
                } else if (shrink) {
                  event.preventDefault();
                  apply((width) => width - 40);
                } else if (event.key === 'Home') {
                  event.preventDefault();
                  apply(() => resizeBounds.min);
                } else if (event.key === 'End') {
                  event.preventDefault();
                  apply(() => resizeBounds.max);
                }
              }}
              className={`workspace-resizer z-20 ${isDragging ? 'is-resizing bg-indigo-500' : ''}`}
              title="Drag to resize chat panel"
            />
            <div className="chat-topbar shrink-0">
              <h3 className="font-medium text-sm text-white uppercase tracking-wider">{tool === 'collab' ? 'collaborate' : tool}</h3>
              {layout === 'stage' && !isHomeMode && (
                <button type="button" onClick={() => setStageChatOpenLayout(null)} className="room-panel-close" aria-label="Hide panel" title="Hide panel"><OmniIcon name="close" size={13} /></button>
              )}
            </div>
            <div className="flex-1 flex flex-col overflow-hidden min-w-0">
              {tool === 'chat' && roomData && (featureEnabled('chat') ? <RoomChat roomId={roomData.id} /> : <RoomFeatureUnavailable label="Room chat" compact />)}
              {tool === 'members' && roomData && <MembersTab roomId={roomData.id} currentUserRole={userRole} canManageMembers={canManageMembers} onChangeRole={(memberId) => { setControlCenterMemberId(memberId); setControlCenterTab('user-control'); setShowControlCenter(true); }} />}
              {tool === 'voice' && roomData && <VoicePanel />}
              {tool === 'collab' && roomData && <CollabPanel roomId={roomData.id} />}
              {tool === 'files' && roomData && (featureEnabled('files') ? <FilesTab roomId={roomData.id} currentUserRole={userRole} canControlMedia={userRole === 'owner' || canControlMedia} /> : <RoomFeatureUnavailable label="Files" compact />)}
            </div>
          </div>
        </aside>
        {layout === 'stage' && !isHomeMode && !sidePanel.visible && (
          <button type="button" className="room-panel-reopen" onClick={() => setStageChatOpenLayout(layout)} aria-label={`Show ${tool}`}><OmniIcon name={tool === 'files' ? 'file' : tool === 'members' ? 'users' : tool === 'voice' ? 'mic' : tool === 'collab' ? 'poll' : 'message'} size={16} /><span>Show {tool === 'collab' ? 'collaborate' : tool}</span></button>
        )}
      </div>
      </div>
      <RoomControlCenter
        open={showControlCenter}
        roomId={roomData.id}
        currentUserRole={userRole}
        onClose={() => { setShowControlCenter(false); setControlCenterTab(null); setControlCenterMemberId(null); }}
        onStateChange={handleControlStateChange}
        requestedTab={controlCenterTab}
        selectedMemberId={controlCenterMemberId}
        roomLifecycle={{ expirationType: roomData.expiration_type, deletionScheduledAt: roomData.deletion_scheduled_at ?? null }}
        onRoomLifecycleChange={(deletionScheduledAt) => setRoomData((current) => current ? { ...current, deletion_scheduled_at: deletionScheduledAt } : current)}
      />
      {showLeaveConfirmation && <div className="fixed inset-0 z-[70] grid place-items-center bg-black/70 p-4 backdrop-blur-sm" role="alertdialog" aria-modal="true" aria-labelledby="leave-room-title"><section className="w-full max-w-md rounded-2xl border border-white/10 bg-[#111217] p-6 shadow-2xl"><p className="text-[10px] font-bold uppercase tracking-[.16em] text-amber-200">Membership</p>{userRole === 'owner' && ownerLeaveStep === 'choice' ? <><h2 id="leave-room-title" className="mt-2 text-xl font-semibold text-white">Do you want to transfer ownership before leaving?</h2><p className="mt-3 text-sm leading-6 text-neutral-400">Choose No to leave the active workspace while retaining your room membership and ownership for later.</p>{leaveError && <p role="alert" className="mt-4 rounded-xl border border-red-400/20 bg-red-500/10 p-3 text-sm text-red-200">{leaveError}</p>}<div className="mt-6 flex flex-wrap justify-end gap-3"><button type="button" disabled={leaving} onClick={() => setShowLeaveConfirmation(false)} className="omni-button omni-button-ghost">Cancel</button><button type="button" disabled={leaving} onClick={() => { setShowLeaveConfirmation(false); minimizeActiveRoom(); }} className="omni-button omni-button-ghost">No</button><button type="button" disabled={leaving} onClick={() => void openOwnerTransfer()} className="omni-button omni-button-primary">Yes</button></div></> : userRole === 'owner' ? <><h2 id="leave-room-title" className="mt-2 text-xl font-semibold text-white">Choose a new owner</h2><p className="mt-3 text-sm leading-6 text-neutral-400">Only an approved permanent member can receive ownership.</p>{leaveError && <p role="alert" className="mt-4 rounded-xl border border-red-400/20 bg-red-500/10 p-3 text-sm text-red-200">{leaveError}</p>}<select value={ownerTransferTarget} onChange={(event) => setOwnerTransferTarget(event.target.value)} className="omni-input mt-4">{ownerTransferCandidates.map((member) => <option key={member.user_id} value={member.user_id}>User {member.user_id.slice(0, 8)}</option>)}</select><div className="mt-6 flex flex-wrap justify-end gap-3"><button type="button" disabled={leaving} onClick={() => setOwnerLeaveStep('choice')} className="omni-button omni-button-ghost">Back</button><button type="button" disabled={leaving || !ownerTransferTarget} onClick={() => void completeOwnerTransferAndLeave()} className="omni-button omni-button-primary">{leaving ? 'Leaving…' : 'Transfer and leave'}</button></div></> : <><h2 id="leave-room-title" className="mt-2 text-xl font-semibold text-white">Leave this room?</h2><p className="mt-3 text-sm leading-6 text-neutral-400">You can rejoin later when the room is open and you are not restricted.</p>{leaveError && <p role="alert" className="mt-4 rounded-xl border border-red-400/20 bg-red-500/10 p-3 text-sm text-red-200">{leaveError}</p>}<div className="mt-6 flex flex-wrap justify-end gap-3"><button type="button" disabled={leaving} onClick={() => setShowLeaveConfirmation(false)} className="omni-button omni-button-ghost">Cancel</button><button type="button" disabled={leaving} onClick={() => void handleLeave()} className="omni-button omni-button-primary">{leaving ? 'Leaving…' : 'Leave room'}</button></div></>}</section></div>}
      {featureEnabled('chat') && <VoiceDock panelOpen={tool === 'voice' && sidePanel.visible} onOpen={() => openTool('voice')} />}
      <FloatingDock />
    </VoiceRoomProvider>
    </RoomRealtimeProvider>
  );
}

function RoomFeatureUnavailable({ label, compact = false }: { label: string; compact?: boolean }) {
  return <div className={`flex flex-1 flex-col items-center justify-center p-6 text-center ${compact ? 'chat-panel' : ''}`}><span className="rounded-full border border-white/10 bg-white/5 p-3 text-neutral-400"><OmniIcon name="lock" size={20} /></span><h2 className="mt-4 text-lg font-semibold text-white">{label} is unavailable</h2><p className="mt-2 max-w-sm text-sm leading-6 text-neutral-500">This feature has been disabled by the room&apos;s controls. It will become available when an authorized manager enables it.</p></div>;
}
