'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/utils/supabase/client';
import { listRoomFiles } from '@/actions/room-files';
import { useRoomRealtime } from '@/components/room/RoomRealtimeProvider';
import RoomActivityFeed from '@/components/room/RoomActivityFeed';
import { OmniIcon, type OmniIconName } from '@/components/ui/OmniIcon';
import { roomDeletionPolicy } from '@/lib/room-deletion-policy';
import { ROOM_MESSAGE_COLUMNS, replyPreview, type RoomChatMessage } from '@/lib/room-chat-model';
import { isFeatureEnabled, type RoomActivity, type RoomFeatureFlags, type RoomTool } from '@/lib/room-layout';

type DashboardFile = { id: string; original_name: string; mime_type: string; created_at: string };
type DashboardAnnouncement = { id: string; body: string; created_at: string };

interface RoomDashboardProps {
  roomId: string;
  room: { name: string; expiration_type: string; deletion_scheduled_at?: string | null; is_group?: boolean };
  timeLeft: string;
  featureFlags: RoomFeatureFlags;
  onOpenActivity: (activity: RoomActivity) => void;
  onOpenTool: (tool: RoomTool) => void;
}

function formatRemaining(seconds: number) {
  const safe = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${String(safe % 60).padStart(2, '0')}`;
}

// Room home (Action 09): what is happening in this room, using only
// membership-scoped reads (RLS) and the room's existing realtime values.
// Features the room has disabled are not offered, so nothing opens empty.
export default function RoomDashboard({ roomId, room, timeLeft, featureFlags, onOpenActivity, onOpenTool }: RoomDashboardProps) {
  const { onlineUserIds, currentUserId, timerState, mediaState, roomMessageEvents, roomControlVersion, connectionGeneration } = useRoomRealtime();
  const supabase = useMemo(() => createClient(), []);
  const [pinned, setPinned] = useState<RoomChatMessage[]>([]);
  const [announcement, setAnnouncement] = useState<DashboardAnnouncement | null>(null);
  const [files, setFiles] = useState<DashboardFile[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [reloadToken, setReloadToken] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const chatOn = isFeatureEnabled(featureFlags, 'chat');
  const filesOn = isFeatureEnabled(featureFlags, 'files');
  const watchOn = isFeatureEnabled(featureFlags, 'watch');
  const studyOn = isFeatureEnabled(featureFlags, 'study');
  const announcementsOn = isFeatureEnabled(featureFlags, 'announcements');

  useEffect(() => {
    let active = true;
    void (async () => {
      const empty = { data: [] as unknown[], error: null };
      // Files are listed only through list_room_files (files capability).
      const [pins, latest, recent] = await Promise.all([
        chatOn
          ? supabase.from('messages').select(ROOM_MESSAGE_COLUMNS).eq('room_id', roomId).not('pinned_at', 'is', null).eq('is_deleted', false).order('pinned_at', { ascending: false }).limit(3)
          : Promise.resolve(empty),
        announcementsOn
          ? supabase.from('room_announcements').select('id, body, created_at').eq('room_id', roomId).order('is_pinned', { ascending: false }).order('created_at', { ascending: false }).limit(1)
          : Promise.resolve(empty),
        filesOn ? listRoomFiles(roomId) : Promise.resolve({ ok: true as const, data: [] }),
      ]);
      if (!active) return;
      if (pins.error || latest.error || !recent.ok) {
        setStatus('error');
        return;
      }
      setPinned((pins.data ?? []) as RoomChatMessage[]);
      setAnnouncement(((latest.data ?? []) as DashboardAnnouncement[])[0] ?? null);
      setFiles((recent.data as Array<DashboardFile & { retention_state?: string }>)
        .filter((file) => !file.retention_state || file.retention_state === 'active')
        .sort((left, right) => right.created_at.localeCompare(left.created_at))
        .slice(0, 4));
      setStatus('ready');
    })();
    return () => { active = false; };
  }, [announcementsOn, chatOn, connectionGeneration, filesOn, reloadToken, roomControlVersion, roomId, supabase]);

  // Pins arrive live as message UPDATEs on the existing room feed.
  useEffect(() => {
    if (!chatOn || roomMessageEvents.length === 0) return;
    const timer = window.setTimeout(() => {
      setPinned((current) => {
        let next = current;
        for (const event of roomMessageEvents) {
          if (event.kind !== 'update') continue;
          const row = event.message as Partial<RoomChatMessage>;
          if (typeof row.id !== 'string' || !('pinned_at' in row)) continue;
          const without = next.filter((message) => message.id !== row.id);
          next = row.pinned_at && !row.is_deleted && typeof row.sender_id === 'string' && typeof row.created_at === 'string'
            ? [row as RoomChatMessage, ...without].sort((left, right) => (right.pinned_at ?? '').localeCompare(left.pinned_at ?? '')).slice(0, 3)
            : without;
        }
        return next;
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [chatOn, roomMessageEvents]);

  useEffect(() => {
    if (!timerState.isRunning) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [timerState.isRunning]);

  const policy = roomDeletionPolicy({ expiration_type: room.expiration_type, deletion_scheduled_at: room.deletion_scheduled_at ?? null });
  const others = onlineUserIds.filter((id) => id !== currentUserId).length;
  const timerRemaining = timerState.isRunning && timerState.endTime ? (timerState.endTime - now) / 1_000 : timerState.remaining;

  const actions: Array<{ key: string; icon: OmniIconName; label: string; detail: string; onClick: () => void }> = [];
  if (watchOn) actions.push({ key: 'watch', icon: 'play', label: 'Watch', detail: mediaState?.title ? `${mediaState.playing ? 'Now playing' : 'Paused'}: ${mediaState.title}` : 'Watch together in sync', onClick: () => onOpenActivity('watch') });
  if (studyOn) actions.push({ key: 'study', icon: 'study', label: 'Study', detail: timerState.isRunning ? `Timer running · ${formatRemaining(timerRemaining)} left` : 'Shared focus timer and notes', onClick: () => onOpenActivity('study') });
  if (studyOn) actions.push({ key: 'whiteboard', icon: 'pen', label: 'Whiteboard', detail: 'Sketch ideas together', onClick: () => onOpenActivity('whiteboard') });
  if (chatOn) actions.push({ key: 'chat', icon: 'message', label: 'Chat', detail: 'Talk with the room', onClick: () => onOpenTool('chat') });
  if (filesOn) actions.push({ key: 'files', icon: 'file', label: 'Files', detail: 'PDFs, media and shared files', onClick: () => onOpenTool('files') });
  actions.push({ key: 'members', icon: 'users', label: 'Members', detail: 'Who is in this room', onClick: () => onOpenTool('members') });
  const disabled = [!watchOn && 'Watch', !studyOn && 'Study', !chatOn && 'Chat', !filesOn && 'Files'].filter(Boolean) as string[];

  const openPinned = (messageId: string) => {
    onOpenTool('chat');
    window.setTimeout(() => { window.location.hash = `message-${messageId}`; }, 50);
  };

  return (
    <section className="room-dashboard" aria-label="Room home">
      <header className="room-dashboard-card room-dashboard-hero">
        <p className="room-dashboard-kicker">{room.is_group ? 'Group home' : 'Room home'}</p>
        <h2 className="room-dashboard-title">{room.name}</h2>
        <p className="room-dashboard-policy"><span className={`room-dashboard-chip policy-${policy.kind}`}>{policy.label}</span>{room.expiration_type !== 'permanent' && timeLeft ? <span className="room-dashboard-chip">Time left {timeLeft}</span> : null}</p>
        <p className="room-dashboard-muted">{policy.description}</p>
        <p className="room-dashboard-online" aria-live="polite"><span className="room-dashboard-online-dot" aria-hidden="true" />{others === 0 ? 'Only you are here right now.' : `You and ${others} other${others === 1 ? '' : 's'} online.`}</p>
      </header>

      <div className="room-dashboard-card">
        <h3 className="room-dashboard-heading">Jump in</h3>
        <div className="room-dashboard-actions">
          {actions.map((action) => (
            <button key={action.key} type="button" onClick={action.onClick} className="room-dashboard-action">
              <span className="room-dashboard-action-icon"><OmniIcon name={action.icon} size={16} /></span>
              <span className="min-w-0">
                <span className="room-dashboard-action-label">{action.label}</span>
                <span className="room-dashboard-action-detail">{action.detail}</span>
              </span>
            </button>
          ))}
        </div>
        {disabled.length > 0 && <p className="room-dashboard-muted mt-3">Turned off by the room: {disabled.join(', ')}.</p>}
      </div>

      {status === 'error' ? (
        <div className="room-dashboard-card" role="alert">
          <p className="room-dashboard-muted">Room activity could not be loaded.</p>
          <button type="button" className="omni-button omni-button-ghost mt-3" onClick={() => { setStatus('loading'); setReloadToken((token) => token + 1); }}>Retry</button>
        </div>
      ) : (
        <>
          {chatOn && (
            <div className="room-dashboard-card">
              <h3 className="room-dashboard-heading"><OmniIcon name="pin" size={14} /> Pinned</h3>
              {status === 'loading' ? <div className="room-dashboard-skeleton" aria-busy="true" /> : pinned.length === 0 ? (
                <p className="room-dashboard-muted">No pinned messages yet. Members who manage announcements can pin from a message&apos;s menu.</p>
              ) : (
                <ul className="room-dashboard-list">
                  {pinned.map((message) => (
                    <li key={message.id}><button type="button" onClick={() => openPinned(message.id)} className="room-dashboard-row">{replyPreview(message)}</button></li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {announcementsOn && (
            <div className="room-dashboard-card">
              <h3 className="room-dashboard-heading"><OmniIcon name="megaphone" size={14} /> Latest announcement</h3>
              {status === 'loading' ? <div className="room-dashboard-skeleton" aria-busy="true" /> : announcement ? (
                <p className="room-dashboard-announcement">{announcement.body}</p>
              ) : <p className="room-dashboard-muted">No announcements yet.</p>}
            </div>
          )}
          {filesOn && (
            <div className="room-dashboard-card">
              <h3 className="room-dashboard-heading"><OmniIcon name="file" size={14} /> Recent files</h3>
              {status === 'loading' ? <div className="room-dashboard-skeleton" aria-busy="true" /> : files.length === 0 ? (
                <p className="room-dashboard-muted">Nothing shared yet.</p>
              ) : (
                <ul className="room-dashboard-list">
                  {files.map((file) => (
                    <li key={file.id}><button type="button" onClick={() => onOpenTool('files')} className="room-dashboard-row"><span className="room-dashboard-file-type">{file.mime_type === 'application/pdf' ? 'PDF' : file.mime_type.split('/')[0]}</span>{file.original_name}</button></li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
      <RoomActivityFeed roomId={roomId} />
    </section>
  );
}
