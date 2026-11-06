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
import { OmniIcon, type OmniIconName } from '@/components/ui/OmniIcon';
import OmniIntro from '@/components/ui/OmniIntro';
import RoomDesk, { type DeskHandle } from '@/components/room/RoomDesk';
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
import RoomConversionDialog, { type ConversionResult } from '@/components/room/RoomConversionDialog';
import { BookmarkToggle } from '@/components/room/BookmarkButton';
import { getRoomGroup } from '@/lib/management-data';
import {
  DEFAULT_ROOM_APPEARANCE,
  ROOM_LAYOUTS,
  ROOM_LAYOUT_DETAILS,
  ROOM_THEMES,
  ROOM_THEME_LABELS,
  effectiveActivity,
  effectiveLayout,
  effectiveTheme,
  effectiveTool,
  isRoomLayout,
  isRoomTheme,
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

// The room desk: every room feature is a window. Watch, Study and Chat stay
// mounted while closed so playback, the timer and the chat keep running.
type WinId = RoomActivity | RoomTool;
const RAIL_STAGE: WinId[] = ['home', 'watch', 'study', 'whiteboard'];
const RAIL_TOOLS: WinId[] = ['chat', 'members', 'voice', 'collab', 'files'];
const WINDOW_IDS: WinId[] = [...RAIL_STAGE, ...RAIL_TOOLS];
const DEFAULT_WINDOWS: WinId[] = ['home', 'chat'];
const WINDOW_META: Record<WinId, { title: string; icon: OmniIconName; label: string }> = {
  home: { title: 'Room home', icon: 'home', label: 'Room home' },
  watch: { title: 'Watch together', icon: 'tv', label: 'Watch' },
  study: { title: 'Study', icon: 'timer', label: 'Study' },
  whiteboard: { title: 'Whiteboard', icon: 'pen', label: 'Whiteboard' },
  chat: { title: 'Room chat', icon: 'message', label: 'Chat' },
  members: { title: 'Members', icon: 'users', label: 'Members' },
  voice: { title: 'Voice', icon: 'mic', label: 'Voice' },
  collab: { title: 'Collaborate', icon: 'poll', label: 'Collaborate' },
  files: { title: 'Files', icon: 'file', label: 'Files' },
};
const ROOM_RAIL_PIN_KEY = 'omni-room-rail-pin';
const isWinId = (value: unknown): value is WinId => typeof value === 'string' && (WINDOW_IDS as string[]).includes(value);

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
  const [groupInfo, setGroupInfo] = useState<{ name: string; member_count: number } | null>(null);
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
  // theme and desk (browser storage keyed by room and user).
  const [appearance, setAppearance] = useState<RoomAppearance>(DEFAULT_ROOM_APPEARANCE);
  const [personalLayout, setPersonalLayout] = useState<RoomLayout | null>(null);
  const [personalTheme, setPersonalTheme] = useState<RoomTheme | null>(null);
  const [showLayoutMenu, setShowLayoutMenu] = useState(false);
  const workspacePreferencesLoadedRef = useRef<string | null>(null);
  const layoutMenuRef = useRef<HTMLDivElement>(null);
  // Open desk windows, oldest first; the desk handle tiles, resets, focuses and raises.
  const [openWindows, setOpenWindows] = useState<WinId[]>(DEFAULT_WINDOWS);
  const deskRef = useRef<DeskHandle>(null);
  const windowsPreferenceLoadedKeyRef = useRef<string | null>(null);
  // The rail tucks itself away and slides back while the pointer is at the left edge (or over it), unless
  // pinned. The pin is saved on this device. The room shell only renders client-side, after access is
  // checked, so reading storage here never mismatches the server markup.
  const [railPinned, setRailPinned] = useState(() => typeof window !== 'undefined' && window.localStorage.getItem(ROOM_RAIL_PIN_KEY) === 'pinned');
  const toggleRailPin = () => setRailPinned((pinned) => {
    try { window.localStorage.setItem(ROOM_RAIL_PIN_KEY, pinned ? 'auto' : 'pinned'); } catch { /* storage off: still toggles for this visit */ }
    return !pinned;
  });

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

  const [timerNavigationRequest, setTimerNavigationRequest] = useState(0);
  const roomIsExpired = accessStatus === 'expired' || isExpired;
  const realtimeRoomId = accessStatus === 'approved' && !roomIsExpired ? (roomData?.id ?? '') : '';
  const roomSync = useRoomSync(realtimeRoomId, userRole === 'owner' || canControlMedia);
  const roomPresence = useRoomPresence(realtimeRoomId, presenceRefreshVersion);
  const deskPreferenceKey = roomWorkspacePreferenceKey(roomData?.id ?? '', roomSync.currentUserId, 'desk');
  const windowsPreferenceKey = roomWorkspacePreferenceKey(roomData?.id ?? '', roomSync.currentUserId, 'desk-windows');
  useEffect(() => {
    windowsPreferenceLoadedKeyRef.current = null;
    const timer = window.setTimeout(() => {
      if (!windowsPreferenceKey) return;
      try {
        const saved = JSON.parse(window.localStorage.getItem(windowsPreferenceKey) ?? 'null') as unknown;
        if (Array.isArray(saved)) setOpenWindows([...new Set(saved.filter(isWinId))]);
      } catch {
        // A damaged value falls back to the default windows.
      }
      windowsPreferenceLoadedKeyRef.current = windowsPreferenceKey;
    }, 0);
    return () => window.clearTimeout(timer);
  }, [windowsPreferenceKey]);
  useEffect(() => {
    if (!windowsPreferenceKey || windowsPreferenceLoadedKeyRef.current !== windowsPreferenceKey) return;
    window.localStorage.setItem(windowsPreferenceKey, JSON.stringify(openWindows));
  }, [openWindows, windowsPreferenceKey]);
  const layoutPreferenceKey = roomWorkspacePreferenceKey(roomData?.id ?? '', roomSync.currentUserId, 'layout');
  const themePreferenceKey = roomWorkspacePreferenceKey(roomData?.id ?? '', roomSync.currentUserId, 'theme');
  useEffect(() => {
    workspacePreferencesLoadedRef.current = null;
    const timer = window.setTimeout(() => {
      const readValue = (key: string | null) => (key ? window.localStorage.getItem(key) : null);
      const savedLayout = readValue(layoutPreferenceKey);
      const savedTheme = readValue(themePreferenceKey);
      setPersonalLayout(isRoomLayout(savedLayout) ? savedLayout : null);
      setPersonalTheme(isRoomTheme(savedTheme) ? savedTheme : null);
      workspacePreferencesLoadedRef.current = layoutPreferenceKey;
    }, 0);
    return () => window.clearTimeout(timer);
  }, [layoutPreferenceKey, themePreferenceKey]);
  useEffect(() => {
    if (!layoutPreferenceKey || workspacePreferencesLoadedRef.current !== layoutPreferenceKey) return;
    const write = (key: string | null, value: string | null) => {
      if (!key) return;
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    };
    write(layoutPreferenceKey, personalLayout);
    write(themePreferenceKey, personalTheme);
  }, [layoutPreferenceKey, personalLayout, personalTheme, themePreferenceKey]);
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
  // A disabled feature never opens an empty window: its rail button is off and
  // an open window for it closes (effectiveActivity/effectiveTool fall back).
  const windowEnabled = (id: WinId) => (RAIL_STAGE.includes(id) ? effectiveActivity(id as RoomActivity, featureFlags) === id : effectiveTool(id as RoomTool, featureFlags) === id);
  const visibleWindows = openWindows.filter(windowEnabled);
  const isOpen = (id: WinId) => visibleWindows.includes(id);
  const openWindow = (id: WinId) => {
    if (!windowEnabled(id)) return;
    setOpenWindows((current) => (current.includes(id) ? current : [...current, id]));
    deskRef.current?.raise(id);
  };
  const closeWindow = (id: string) => setOpenWindows((current) => current.filter((open) => open !== id));
  const toggleWindow = (id: WinId) => (isOpen(id) ? closeWindow(id) : openWindow(id));
  const layout = effectiveLayout(appearance, personalLayout);
  const theme = effectiveTheme(appearance, personalTheme);
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

  // Action 14: the conversion changes what the room is (permanent, private,
  // closed to joins). The owner's dialog and every member's control-event feed
  // apply the same local update; the database already enforces all of it.
  const applyConversion = useCallback((name: string | null) => {
    setRoomData((current) => current ? { ...current, is_group: true, is_private: true, expiration_type: 'permanent', expires_at: null, reopened_until: null, username: null } : current);
    if (name) setGroupInfo((current) => ({ name, member_count: current?.member_count ?? 0 }));
  }, []);
  const convertedEvents = roomSync.roomControlEvents.filter((event) => event.eventType === 'group_converted').length;
  const roomIdForGroup = roomData?.id;
  const isGroupRoom = Boolean(roomData?.is_group);
  useEffect(() => {
    if (!roomIdForGroup || (!isGroupRoom && convertedEvents === 0)) return;
    let active = true;
    void getRoomGroup(roomIdForGroup).then((result) => {
      if (!active || !result.ok || !result.data) return;
      setGroupInfo({ name: result.data.name, member_count: result.data.member_count });
      applyConversion(null);
    });
    return () => { active = false; };
  }, [roomIdForGroup, isGroupRoom, convertedEvents, applyConversion]);

  if (accessStatus === 'loading') return <main className="omni-loading-screen"><div className="grid justify-items-center gap-5"><OmniIntro tagline={false} /><p className="text-sm text-neutral-500">Verifying secure access...</p></div></main>;
  if (accessStatus === 'not_found') return <div className="omni-state-screen flex-col text-center text-white"><h2 className="text-xl">❌ Space Not Found</h2><Link href="/explore" className="mt-4 px-5 py-2.5 bg-white text-black rounded font-semibold text-sm">Return to Explore</Link></div>;
  if (accessStatus === 'pending') return <div className="omni-state-screen flex-col text-center text-white"><h2 className="text-xl text-amber-500">⏳ Waiting for Approval</h2><Link href="/explore" className="mt-4 px-5 py-2.5 bg-neutral-900 border border-neutral-800 rounded font-medium text-sm">Explore other spaces</Link></div>;
  if (accessStatus === 'scheduled') return <div className="omni-state-screen flex-col text-center text-white"><h2 className="text-xl text-violet-300">⏰ This room is scheduled</h2><p className="mt-2 text-sm text-neutral-500">The room will open at {roomData?.scheduled_for ? new Date(roomData.scheduled_for).toLocaleString() : 'its scheduled time'}.</p><Link href="/explore" className="mt-4 px-5 py-2.5 bg-neutral-900 border border-neutral-800 rounded font-medium text-sm">Explore other spaces</Link></div>;
  if (accessStatus === 'guest_expired') return <div className="omni-state-screen flex-col text-center text-white"><h2 className="text-xl text-amber-400">Guest access has expired</h2><p className="mt-2 text-sm text-neutral-500">Ask a room manager for a new invitation if you need access again.</p><Link href="/explore" className="mt-4 px-5 py-2.5 bg-neutral-900 border border-neutral-800 rounded font-medium text-sm">Explore other spaces</Link></div>;
  if (accessStatus === 'kicked') return <div className="omni-state-screen flex-col text-center text-white"><h2 className="text-xl text-red-400">You were kicked from this room.</h2><p className="mt-2 text-sm text-neutral-500">Your active room session has ended.</p><Link href="/explore" className="mt-4 px-5 py-2.5 bg-white text-black rounded font-semibold text-sm">Return to Rooms</Link></div>;
  if (accessStatus === 'blocked' || accessStatus === 'banned') return <div className="omni-state-screen flex-col text-center text-white"><h2 className="text-xl text-red-400">You have been blocked from this room.</h2><p className="mt-2 text-sm text-neutral-500">Room access is not available for this account.</p><Link href="/explore" className="mt-4 px-5 py-2.5 bg-white text-black rounded font-semibold text-sm">Return to Rooms</Link></div>;
  if (accessStatus === 'unauthorized' || accessStatus === 'public_not_joined' || accessStatus === 'private_not_joined') return <div className="omni-state-screen flex-col text-center text-white"><h2 className="text-xl text-red-500">🔒 Access Restricted</h2><Link href="/explore" className="mt-4 px-5 py-2.5 bg-white text-black rounded font-semibold text-sm">Go to Explore to Join</Link></div>;

  if (!roomData) return <main className="omni-loading-screen"><div className="grid justify-items-center gap-5"><OmniIntro tagline={false} /><p className="text-sm text-neutral-500">Loading room...</p></div></main>;

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
      <div className="omni-state-screen flex-col text-center text-white">
        <div className="glass-strong max-w-md w-full p-8 rounded-2xl flex flex-col items-center">
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
      <div className="room-shell" data-room-theme={theme} data-chrome={railPinned ? undefined : 'auto'}>
      {!railPinned && <div className="room-edge room-edge-left" aria-hidden="true" />}
      <header className="room-header">
        <button type="button" onClick={minimizeActiveRoom} className="icon-button room-back" aria-label="Minimize room" title="Return to Rooms without leaving"><OmniIcon name="back" size={16} /></button>
        <div className="room-header-title">
          <h1>{roomData?.name || identifier}</h1>
          {roomData?.is_group && <span className="room-chip">Group</span>}
          <span className={`room-chip ${roomData?.expiration_type === 'permanent' ? '' : 'is-temp mono'}`}>{roomData?.expiration_type === 'permanent' ? 'Permanent' : `Temp · ${timeLeft}`}</span>
          <span className="room-here"><span className="status-dot" aria-hidden="true" />{roomPresence.onlineUserIds.length} here</span>
        </div>
        <div className="room-actions">
          {userRole === 'owner' && roomData && !roomData.is_group && roomData.expiration_type !== 'irreversible' && !roomData.deletion_scheduled_at && <button type="button" onClick={() => setShowConvertModal(true)} className="room-action">Convert to group</button>}
          {roomData.reopened_until && <button onClick={handlePermanentRequest} disabled={permanentSubmitting || permanentRequests.some((request) => request.status === 'pending')} className="room-action disabled:cursor-wait disabled:opacity-50">{permanentSubmitting ? 'Requesting...' : 'Request Permanent Room'}</button>}
          <div className="room-layout-menu" ref={layoutMenuRef}>
            <button type="button" className="room-action" aria-haspopup="dialog" aria-expanded={showLayoutMenu} onClick={() => setShowLayoutMenu((open) => !open)} title="Layout and theme"><OmniIcon name="layout" size={15} /><span>Layout</span><OmniIcon name="chevron" size={14} /></button>
            {showLayoutMenu && (
              <div role="dialog" aria-label="Layout and theme" className="room-layout-popover" onKeyDown={(event) => { if (event.key.toLowerCase() === 't' && !(event.target instanceof HTMLSelectElement)) { event.preventDefault(); deskRef.current?.tile(); setShowLayoutMenu(false); } }}>
                <div className="room-layout-commands">
                  <button type="button" className="room-layout-command" onClick={() => { deskRef.current?.tile(); setShowLayoutMenu(false); }}><OmniIcon name="layout" size={15} />Tile all windows<span className="room-key mono">T</span></button>
                  <button type="button" className="room-layout-command" onClick={() => { deskRef.current?.focus(); setShowLayoutMenu(false); }}><OmniIcon name="maximize" size={15} />Focus one window</button>
                  <button type="button" className="room-layout-command" onClick={() => { deskRef.current?.reset(); setShowLayoutMenu(false); }}><OmniIcon name="history" size={15} />Reset layout</button>
                </div>
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
                <p className="room-layout-hint mt-2">Your layout, theme and panel sizes are saved on this device for you only.</p>
              </div>
            )}
          </div>
          <BookmarkToggle roomId={roomData.id} kind="room" entityId={roomData.id} className="room-action" labels={['☆ Save', '★ Saved']} subject="room" />
          <NotificationBell roomId={roomData.id} />
          <button type="button" onClick={() => setShowControlCenter(true)} className="room-action"><OmniIcon name="settings" size={15} /><span>Controls</span></button>
          <button type="button" onClick={minimizeActiveRoom} className="room-action" title="Return to Rooms without leaving"><span aria-hidden="true">—</span><span>Minimize room</span></button>
          <button type="button" onClick={() => { setLeaveError(null); setShowLeaveConfirmation(true); }} data-room-leave className="room-action room-action-leave">Leave</button>
        </div>
      </header>

      <div className="room-notices">
        <RoomNotifications roomId={roomData.id} />
        <RoomRoleChangeNotification events={roomSync.roomControlEvents} currentUserId={roomSync.currentUserId} />
        {roomData.is_group && <p className="group-banner" role="status">This room is now a group{groupInfo ? `: “${groupInfo.name}”` : ''}. Members and history are kept; new joins are closed.</p>}
        <RoomPulseBar roomId={roomData.id} />
        <RoomAnnouncementBanner roomId={roomData.id} />
        <RoomEntryPrompts roomId={roomData.id} onOpenRoomProfile={() => { setControlCenterTab('profile'); setShowControlCenter(true); }} />

        {roomData.reopened_until && permanentRequests.length > 0 && (
          <div className="room-state-bar">
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
        {lifecycleActionError && <p className="room-alert" role="alert">{lifecycleActionError}</p>}
        {roomData.expiration_type === 'permanent' && roomData.deletion_scheduled_at && <p className="room-alert" role="status">This room is scheduled for permanent deletion on {new Date(roomData.deletion_scheduled_at).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' })}. Chats and files will be deleted unless the owner cancels.</p>}
      </div>

      <div className="room-stage">
        <nav className="room-rail glass" aria-label="Room windows">
          {[RAIL_STAGE, RAIL_TOOLS].map((group, groupIndex) => (
            <div key={groupIndex} className="room-rail-group">
              {group.map((id) => {
                const enabled = windowEnabled(id);
                const offTitle: Partial<Record<WinId, string>> = {
                  watch: 'Watch is turned off by this room',
                  study: 'Study is turned off by this room',
                  whiteboard: 'The whiteboard is part of Study, which this room has turned off',
                  chat: 'Chat is turned off by this room',
                  voice: 'Voice needs room chat, which this room has turned off',
                  collab: 'Collaborate needs room chat, which this room has turned off',
                  files: 'Files are turned off by this room',
                };
                const onTitle: Partial<Record<WinId, string>> = { voice: 'Voice, screen share and raise hand', collab: 'Polls, countdowns, events and search' };
                return (
                  <button key={id} type="button" aria-label={WINDOW_META[id].label} title={enabled ? (onTitle[id] ?? WINDOW_META[id].label) : offTitle[id]} aria-pressed={isOpen(id)} disabled={!enabled} onClick={() => toggleWindow(id)} className="room-rail-btn">
                    <OmniIcon name={WINDOW_META[id].icon} size={17} />
                  </button>
                );
              })}
            </div>
          ))}
          <div className="room-rail-group room-rail-chrome">
            <button type="button" aria-label="Keep the rail on screen" title={railPinned ? 'Let the rail hide again. It comes back when you point at the left edge' : 'Keep the rail on screen'} aria-pressed={railPinned} onClick={toggleRailPin} className="room-rail-btn">
              <OmniIcon name="sidebar" size={17} />
            </button>
          </div>
        </nav>

        <div className="room-desk-wrap">
          <RoomDesk
            ref={deskRef}
            preset={layout}
            storageKey={deskPreferenceKey}
            onClose={closeWindow}
            emptyHint={<><OmniIcon name="layout" size={22} /><p>Every window is closed. Open one from the rail.</p></>}
            windows={[
              { id: 'home', open: isOpen('home'), children: <div className="room-dashboard-layer flex min-h-0 flex-1 flex-col overflow-y-auto"><RoomDashboard roomId={roomData.id} room={roomData} timeLeft={timeLeft} featureFlags={featureFlags} onOpenActivity={openWindow} onOpenTool={openWindow} /></div> },
              { id: 'watch', open: isOpen('watch'), keepMounted: featureEnabled('watch'), children: <MediaStage roomId={roomData.id} canControlMedia={userRole === 'owner' || canControlMedia} /> },
              { id: 'study', open: isOpen('study'), keepMounted: featureEnabled('study'), children: <StudyStage roomId={roomData.id} focusRoomPath={focusRoomPath} timerNavigationRequest={timerNavigationRequest} onOpenWatch={featureEnabled('watch') ? () => openWindow('watch') : undefined} /> },
              { id: 'whiteboard', open: isOpen('whiteboard'), children: <div className="flex min-h-0 flex-1 flex-col p-3"><StudyWhiteboardPanel roomId={roomData.id} /></div> },
              { id: 'chat', open: isOpen('chat'), keepMounted: featureEnabled('chat'), children: <RoomChat roomId={roomData.id} /> },
              { id: 'members', open: isOpen('members'), children: <MembersTab roomId={roomData.id} currentUserRole={userRole} canManageMembers={canManageMembers} onChangeRole={(memberId) => { setControlCenterMemberId(memberId); setControlCenterTab('user-control'); setShowControlCenter(true); }} /> },
              { id: 'voice', open: isOpen('voice'), children: <VoicePanel /> },
              { id: 'collab', open: isOpen('collab'), children: <CollabPanel roomId={roomData.id} /> },
              { id: 'files', open: isOpen('files'), children: <FilesTab roomId={roomData.id} currentUserRole={userRole} canControlMedia={userRole === 'owner' || canControlMedia} /> },
            ].map((w) => ({ ...w, title: WINDOW_META[w.id as WinId].title, icon: WINDOW_META[w.id as WinId].icon }))}
          />
          <div className="room-desk-float">
            {!isOpen('watch') && featureEnabled('watch') && roomSync.mediaState && <div className="now-playing-slot"><NowPlayingBar roomId={roomData.id} onOpen={() => openWindow('watch')} /></div>}
            {!isOpen('study') && featureEnabled('study') && roomSync.timerState.isRunning && (
              <StudyMiniTimer
                roomId={roomData.id}
                timerState={roomSync.timerState}
                onOpen={() => {
                  openWindow('study');
                  setTimerNavigationRequest((request) => request + 1);
                }}
              />
            )}
          </div>
        </div>
      </div>
      </div>
      {showConvertModal && <RoomConversionDialog roomId={roomData.id} roomName={roomData.name} onClose={() => setShowConvertModal(false)} onConverted={(result: ConversionResult) => { applyConversion(result.name); setGroupInfo({ name: result.name, member_count: result.memberCount }); }} />}
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
      {showLeaveConfirmation && <div className="fixed inset-0 z-[70] grid place-items-center bg-black/70 p-4 backdrop-blur-sm" role="alertdialog" aria-modal="true" aria-labelledby="leave-room-title"><section className="glass-strong w-full max-w-md rounded-2xl p-6"><p className="text-[10px] font-bold uppercase tracking-[.16em] text-amber-200">Membership</p>{userRole === 'owner' && ownerLeaveStep === 'choice' ? <><h2 id="leave-room-title" className="mt-2 text-xl font-semibold text-white">Do you want to transfer ownership before leaving?</h2><p className="mt-3 text-sm leading-6 text-neutral-400">Choose No to leave the active workspace while retaining your room membership and ownership for later.</p>{leaveError && <p role="alert" className="mt-4 rounded-xl border border-red-400/20 bg-red-500/10 p-3 text-sm text-red-200">{leaveError}</p>}<div className="mt-6 flex flex-wrap justify-end gap-3"><button type="button" disabled={leaving} onClick={() => setShowLeaveConfirmation(false)} className="omni-button omni-button-ghost">Cancel</button><button type="button" disabled={leaving} onClick={() => { setShowLeaveConfirmation(false); minimizeActiveRoom(); }} className="omni-button omni-button-ghost">No</button><button type="button" disabled={leaving} onClick={() => void openOwnerTransfer()} className="omni-button omni-button-primary">Yes</button></div></> : userRole === 'owner' ? <><h2 id="leave-room-title" className="mt-2 text-xl font-semibold text-white">Choose a new owner</h2><p className="mt-3 text-sm leading-6 text-neutral-400">Only an approved permanent member can receive ownership.</p>{leaveError && <p role="alert" className="mt-4 rounded-xl border border-red-400/20 bg-red-500/10 p-3 text-sm text-red-200">{leaveError}</p>}<select value={ownerTransferTarget} onChange={(event) => setOwnerTransferTarget(event.target.value)} className="omni-input mt-4">{ownerTransferCandidates.map((member) => <option key={member.user_id} value={member.user_id}>User {member.user_id.slice(0, 8)}</option>)}</select><div className="mt-6 flex flex-wrap justify-end gap-3"><button type="button" disabled={leaving} onClick={() => setOwnerLeaveStep('choice')} className="omni-button omni-button-ghost">Back</button><button type="button" disabled={leaving || !ownerTransferTarget} onClick={() => void completeOwnerTransferAndLeave()} className="omni-button omni-button-primary">{leaving ? 'Leaving…' : 'Transfer and leave'}</button></div></> : <><h2 id="leave-room-title" className="mt-2 text-xl font-semibold text-white">Leave this room?</h2><p className="mt-3 text-sm leading-6 text-neutral-400">You can rejoin later when the room is open and you are not restricted.</p>{leaveError && <p role="alert" className="mt-4 rounded-xl border border-red-400/20 bg-red-500/10 p-3 text-sm text-red-200">{leaveError}</p>}<div className="mt-6 flex flex-wrap justify-end gap-3"><button type="button" disabled={leaving} onClick={() => setShowLeaveConfirmation(false)} className="omni-button omni-button-ghost">Cancel</button><button type="button" disabled={leaving} onClick={() => void handleLeave()} className="omni-button omni-button-primary">{leaving ? 'Leaving…' : 'Leave room'}</button></div></>}</section></div>}
      {featureEnabled('chat') && <VoiceDock panelOpen={isOpen('voice')} onOpen={() => openWindow('voice')} />}
      <FloatingDock />
    </VoiceRoomProvider>
    </RoomRealtimeProvider>
  );
}
