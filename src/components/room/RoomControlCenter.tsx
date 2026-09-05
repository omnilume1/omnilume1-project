'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createRoomAnnouncement,
  createRoomInvite,
  getRoomControlState,
  listRoomInviteHistory,
  revokeRoomInvite,
  setRoomRolePermission,
  updateRoomAnnouncement,
  updateRoomControls,
  updateRoomSpecificProfile,
} from '@/actions/room-controls';
import { useRoomRealtime } from '@/components/room/RoomRealtimeProvider';
import { OmniIcon } from '@/components/ui/OmniIcon';

type Feature = 'chat' | 'watch' | 'files' | 'study' | 'announcements';
type RoomRole = 'admin' | 'member' | 'guest';
type Capability = 'manage_members' | 'manage_invites' | 'manage_settings' | 'manage_announcements' | 'chat' | 'watch' | 'watch_control' | 'files' | 'study';
type Tab = 'overview' | 'invites' | 'rules' | 'permissions' | 'announcements' | 'profile';

type Settings = { rules: string; welcome_message: string; is_locked: boolean; feature_flags: Record<Feature, boolean> };
type Permission = { role: RoomRole; capability: Capability; allowed: boolean };
type Announcement = { id: string; author_id: string; body: string; is_pinned: boolean; created_at: string; updated_at: string };
type Invite = { id: string; token: string; expires_at: string | null; max_uses: number | null; uses_count: number; guest_lifetime_minutes: number | null };
type InviteHistory = Omit<Invite, 'token'> & { revoked_at: string | null; created_at: string; status: 'active' | 'revoked' | 'expired' | 'exhausted' };
type MemberState = { user_id: string; role: RoomRole | 'owner' | null; join_status: string | null; guest_expires_at: string | null; restriction_types: string[] | null };
type RoomProfile = { user_id: string; display_name: string | null; avatar_url: string | null; bio: string | null; updated_at: string };

const FEATURES: Array<{ key: Feature; label: string; description: string }> = [
  { key: 'chat', label: 'Chat', description: 'Room conversation and messages.' },
  { key: 'watch', label: 'Watch', description: 'Shared media and playback controls.' },
  { key: 'files', label: 'Files', description: 'Room attachments and shared files.' },
  { key: 'study', label: 'Study', description: 'Study timer and focus tools.' },
  { key: 'announcements', label: 'Announcements', description: 'Room-wide updates from controllers.' },
];

const CAPABILITIES: Array<{ key: Capability; label: string }> = [
  { key: 'manage_members', label: 'Manage members' },
  { key: 'manage_invites', label: 'Manage invites' },
  { key: 'manage_settings', label: 'Manage settings' },
  { key: 'manage_announcements', label: 'Manage announcements' },
  { key: 'chat', label: 'Use chat' },
  { key: 'watch', label: 'Use Watch' },
  { key: 'watch_control', label: 'Control Watch' },
  { key: 'files', label: 'Use files' },
  { key: 'study', label: 'Use study tools' },
];

const DEFAULT_SETTINGS: Settings = {
  rules: '',
  welcome_message: '',
  is_locked: false,
  feature_flags: { chat: true, watch: true, files: true, study: true, announcements: true },
};

function messageFrom(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function shortUserId(id: string) {
  return `${id.slice(0, 8)}…`;
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : 'No expiry';
}

export default function RoomControlCenter({
  open,
  roomId,
  currentUserRole,
  onClose,
  onStateChange,
}: {
  open: boolean;
  roomId: string;
  currentUserRole: string | null;
  onClose: () => void;
  onStateChange: (state: { featureFlags: Partial<Record<Feature, boolean>>; canManageMembers: boolean }) => void;
}) {
  const { roomControlVersion } = useRoomRealtime();
  const [tab, setTab] = useState<Tab>('overview');
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [memberStates, setMemberStates] = useState<MemberState[]>([]);
  const [inviteHistory, setInviteHistory] = useState<InviteHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [inviteExpiry, setInviteExpiry] = useState('');
  const [inviteUses, setInviteUses] = useState('');
  const [guestMinutes, setGuestMinutes] = useState('');
  const [draftRules, setDraftRules] = useState('');
  const [draftWelcome, setDraftWelcome] = useState('');
  const [announcementBody, setAnnouncementBody] = useState('');
  const [announcementPinned, setAnnouncementPinned] = useState(false);
  const [editingAnnouncement, setEditingAnnouncement] = useState<string | null>(null);
  const [editAnnouncementBody, setEditAnnouncementBody] = useState('');
  const [editAnnouncementPinned, setEditAnnouncementPinned] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [profileAvatarUrl, setProfileAvatarUrl] = useState('');
  const [profileBio, setProfileBio] = useState('');

  const isOwner = currentUserRole === 'owner';
  const permissionFor = useCallback((capability: Capability, nextPermissions = permissions) => (
    isOwner || nextPermissions.some((permission) => permission.role === currentUserRole && permission.capability === capability && permission.allowed)
  ), [currentUserRole, isOwner, permissions]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const state = await getRoomControlState(roomId);
      const nextSettings = {
        ...DEFAULT_SETTINGS,
        ...(state.settings ?? {}),
        feature_flags: { ...DEFAULT_SETTINGS.feature_flags, ...(state.settings?.feature_flags ?? {}) },
      } as Settings;
      const nextPermissions = state.permissions as Permission[];
      const canManageInvites = isOwner || nextPermissions.some((permission) => permission.role === currentUserRole && permission.capability === 'manage_invites' && permission.allowed);
      const [history] = await Promise.all([canManageInvites ? listRoomInviteHistory(roomId) : Promise.resolve([])]);
      const nextProfile = state.myRoomProfile as RoomProfile | null;

      setSettings(nextSettings);
      setPermissions(nextPermissions);
      setAnnouncements(state.announcements as Announcement[]);
      setMemberStates(state.memberStates as MemberState[]);
      setInviteHistory(history as InviteHistory[]);
      setDraftRules(nextSettings.rules);
      setDraftWelcome(nextSettings.welcome_message);
      setProfileName(nextProfile?.display_name ?? '');
      setProfileAvatarUrl(nextProfile?.avatar_url ?? '');
      setProfileBio(nextProfile?.bio ?? '');
      onStateChange({
        featureFlags: nextSettings.feature_flags,
        canManageMembers: isOwner || nextPermissions.some((permission) => permission.role === currentUserRole && permission.capability === 'manage_members' && permission.allowed),
      });
      setError(null);
    } catch (loadError) {
      setError(messageFrom(loadError, 'Unable to load Room Control Center.'));
    } finally {
      setLoading(false);
    }
  }, [currentUserRole, isOwner, onStateChange, roomId]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load, roomControlVersion]);

  const run = async (key: string, action: () => Promise<void>, success: string) => {
    setWorking(key);
    setError(null);
    try {
      await action();
      setNotice(success);
      await load();
    } catch (actionError) {
      setError(messageFrom(actionError, 'This room control could not be updated.'));
    } finally {
      setWorking(null);
    }
  };

  const canManageSettings = permissionFor('manage_settings');
  const canManageInvites = permissionFor('manage_invites');
  const canManageAnnouncements = permissionFor('manage_announcements');
  const inviteCode = useMemo(() => invite?.token ?? '', [invite]);
  const guestStates = memberStates.filter((state) => state.role === 'guest');
  const restrictedStates = memberStates.filter((state) => (state.restriction_types?.length ?? 0) > 0);

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(inviteCode);
      setNotice('Invite code copied.');
    } catch {
      setError('Unable to copy the invite code. Select and copy it manually.');
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-end bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:justify-center sm:p-5" role="dialog" aria-modal="true" aria-labelledby="room-control-title">
      <section className="flex max-h-[calc(100dvh-16px)] w-full max-w-5xl flex-col overflow-hidden rounded-t-3xl border border-white/10 bg-[#0c0d12] shadow-2xl sm:max-h-[calc(100dvh-40px)] sm:rounded-3xl">
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-white/10 px-4 py-4 sm:px-6">
          <div><p className="text-[10px] font-bold uppercase tracking-[.18em] text-violet-300">Room management</p><h2 id="room-control-title" className="mt-1 text-xl font-semibold text-white">Control Center</h2><p className="mt-1 text-xs text-neutral-500">The server enforces every role, capability, restriction, and room setting.</p></div>
          <button type="button" onClick={onClose} className="rounded-xl border border-white/10 p-2 text-neutral-400 hover:bg-white/10 hover:text-white" aria-label="Close Control Center"><OmniIcon name="close" size={18} /></button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-white/10 p-2 sm:w-44 sm:flex-col sm:overflow-y-auto sm:border-b-0 sm:border-r" aria-label="Room Control Center sections">
            {([['overview', 'Overview'], ['invites', 'Invites'], ['rules', 'Rules & welcome'], ['permissions', 'Permissions'], ['announcements', 'Announcements'], ['profile', 'Room profile']] as Array<[Tab, string]>).map(([key, label]) => <button key={key} type="button" onClick={() => setTab(key)} className={`shrink-0 rounded-xl px-3 py-2.5 text-left text-xs font-semibold transition ${tab === key ? 'bg-violet-500/15 text-violet-200' : 'text-neutral-400 hover:bg-white/5 hover:text-white'}`}>{label}</button>)}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto p-4 pb-28 sm:p-6 sm:pb-6">
            {notice && <p role="status" className="mb-4 rounded-xl border border-emerald-400/20 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">{notice}</p>}
            {error && <p role="alert" className="mb-4 rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</p>}
            {loading ? <p className="py-10 text-center text-sm text-neutral-500">Loading room controls…</p> : <>
              {tab === 'overview' && <div className="space-y-5">
                <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold text-white">Room lock</h3><p className="mt-1 text-sm text-neutral-500">{settings.is_locked ? 'New joins are paused until this room is unlocked.' : 'New joins are currently allowed by room policy.'}</p></div>{canManageSettings && <button type="button" disabled={working === 'lock'} onClick={() => void run('lock', () => updateRoomControls(roomId, { isLocked: !settings.is_locked }).then(() => undefined), settings.is_locked ? 'Room unlocked.' : 'Room locked.')} className="omni-button omni-button-ghost">{working === 'lock' ? 'Saving…' : settings.is_locked ? 'Unlock room' : 'Lock room'}</button>}</div></section>
                <section><h3 className="font-semibold text-white">Room features</h3><p className="mt-1 text-sm text-neutral-500">Disabled features are also enforced by the backend.</p><div className="mt-3 grid gap-3 sm:grid-cols-2">{FEATURES.map((feature) => { const enabled = settings.feature_flags[feature.key] !== false; return <article key={feature.key} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4"><div className="flex items-start justify-between gap-3"><div><h4 className="font-medium text-white">{feature.label}</h4><p className="mt-1 text-xs leading-5 text-neutral-500">{feature.description}</p></div><span className={`rounded-full px-2 py-1 text-[10px] font-bold ${enabled ? 'bg-emerald-500/10 text-emerald-300' : 'bg-neutral-700/40 text-neutral-400'}`}>{enabled ? 'Enabled' : 'Disabled'}</span></div>{canManageSettings && <button type="button" disabled={working === `feature-${feature.key}`} onClick={() => void run(`feature-${feature.key}`, () => updateRoomControls(roomId, { featureFlags: { [feature.key]: !enabled } }).then(() => undefined), `${feature.label} ${enabled ? 'disabled' : 'enabled'}.`)} className="mt-4 text-xs font-semibold text-violet-200 hover:text-violet-100">{enabled ? 'Disable' : 'Enable'}</button>}</article>; })}</div></section>
                <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4"><h3 className="font-semibold text-white">Member experience</h3><p className="mt-2 text-sm leading-6 text-neutral-400">{settings.welcome_message || 'No welcome message has been configured.'}</p>{settings.rules && <p className="mt-3 whitespace-pre-wrap border-t border-white/10 pt-3 text-sm leading-6 text-neutral-500">{settings.rules}</p>}</section>
                {(guestStates.length > 0 || restrictedStates.length > 0) && <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4"><h3 className="font-semibold text-white">Guest and restriction state</h3><p className="mt-1 text-xs leading-5 text-neutral-500">Controllers receive room-wide state; other members see only their own server-authorized state.</p><div className="mt-3 space-y-2">{guestStates.map((state) => <StateRow key={`${state.user_id}-guest`} state={state} />)}{restrictedStates.filter((state) => state.role !== 'guest').map((state) => <StateRow key={`${state.user_id}-restriction`} state={state} />)}</div></section>}
              </div>}

              {tab === 'invites' && <div className="space-y-5"><div><h3 className="font-semibold text-white">Invite links and codes</h3><p className="mt-1 text-sm text-neutral-500">Tokens are shown only once when they are created. History never exposes reusable tokens.</p></div>{!canManageInvites ? <ReadOnly message="Only members with invite-management permission can view or manage room invites." /> : <><section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4"><div className="grid gap-3 sm:grid-cols-3"><label className="text-xs text-neutral-400">Expires at<input type="datetime-local" value={inviteExpiry} onChange={(event) => setInviteExpiry(event.target.value)} className="omni-input mt-1" /></label><label className="text-xs text-neutral-400">Maximum uses<input inputMode="numeric" value={inviteUses} onChange={(event) => setInviteUses(event.target.value)} placeholder="Unlimited" className="omni-input mt-1" /></label><label className="text-xs text-neutral-400">Guest minutes<input inputMode="numeric" value={guestMinutes} onChange={(event) => setGuestMinutes(event.target.value)} placeholder="Permanent member" className="omni-input mt-1" /></label></div><button type="button" disabled={working === 'invite'} onClick={() => void run('invite', async () => { const created = await createRoomInvite(roomId, { expiresAt: inviteExpiry ? new Date(inviteExpiry).toISOString() : undefined, maxUses: inviteUses ? Number(inviteUses) : undefined, guestLifetimeMinutes: guestMinutes ? Number(guestMinutes) : undefined }); const newInvite = (Array.isArray(created) ? created[0] : created) as Invite | null; if (!newInvite) throw new Error('Invite creation did not return invite details.'); setInvite(newInvite); }, 'Invite created.')} className="omni-button omni-button-primary mt-4">{working === 'invite' ? 'Creating…' : 'Generate invite'}</button></section>{invite && <section className="rounded-2xl border border-violet-400/20 bg-violet-500/5 p-4"><p className="text-xs font-bold uppercase tracking-wider text-violet-200">Latest generated invite</p><code className="mt-3 block break-all rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-white">{inviteCode}</code><div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => void copyInvite()} className="omni-button omni-button-ghost">Copy code</button><button type="button" disabled={working === 'revoke'} onClick={() => void run('revoke-latest', async () => { await revokeRoomInvite(invite.id); setInvite(null); }, 'Invite revoked.')} className="omni-button omni-button-ghost text-red-200">Revoke</button></div></section>}<section><h4 className="text-sm font-semibold text-white">Invite history</h4>{inviteHistory.length === 0 ? <ReadOnly message="No invites have been created for this room." /> : <div className="mt-3 space-y-2">{inviteHistory.map((item) => <article key={item.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-3"><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-semibold capitalize text-white">{item.status}</span><span className="text-[10px] text-neutral-500">Created {formatDate(item.created_at)}</span></div><p className="mt-1 text-xs text-neutral-400">Uses: {item.uses_count}{item.max_uses === null ? ' / unlimited' : ` / ${item.max_uses}`} · {item.guest_lifetime_minutes ? `Guest access: ${item.guest_lifetime_minutes} minutes` : 'Standard membership'} · Expires: {formatDate(item.expires_at)}</p>{item.status === 'active' && <button type="button" disabled={working === `revoke-${item.id}`} onClick={() => void run(`revoke-${item.id}`, () => revokeRoomInvite(item.id), 'Invite revoked.')} className="mt-2 text-xs font-semibold text-red-200 hover:text-red-100">Revoke invite</button>}</article>)}</div>}</section></>}</div>}

              {tab === 'rules' && <div className="space-y-5"><div><h3 className="font-semibold text-white">Rules and welcome</h3><p className="mt-1 text-sm text-neutral-500">Approved members receive a read-only view; authorized controllers can update it.</p></div>{canManageSettings ? <section className="space-y-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4"><label className="block text-sm font-medium text-white">Welcome message<textarea value={draftWelcome} onChange={(event) => setDraftWelcome(event.target.value)} maxLength={1000} rows={3} className="omni-input mt-2 min-h-24" /></label><label className="block text-sm font-medium text-white">Room rules<textarea value={draftRules} onChange={(event) => setDraftRules(event.target.value)} maxLength={5000} rows={8} className="omni-input mt-2 min-h-40" /></label><button type="button" disabled={working === 'rules'} onClick={() => void run('rules', () => updateRoomControls(roomId, { rules: draftRules, welcomeMessage: draftWelcome }).then(() => undefined), 'Rules and welcome message saved.')} className="omni-button omni-button-primary">{working === 'rules' ? 'Saving…' : 'Save rules & welcome'}</button></section> : <ReadOnly message={`${settings.welcome_message || 'No welcome message has been configured.'}${settings.rules ? `\n\n${settings.rules}` : ''}`} />}</div>}

              {tab === 'permissions' && <div className="space-y-5"><div><h3 className="font-semibold text-white">Granular permissions</h3><p className="mt-1 text-sm text-neutral-500">These persisted values are enforced by the backend for every room operation.</p></div>{!isOwner ? <ReadOnly message="Only the room owner can change granular permissions." /> : <div className="overflow-x-auto rounded-2xl border border-white/10"><table className="w-full min-w-[620px] text-left text-xs"><thead className="bg-white/[0.04] text-neutral-400"><tr><th className="p-3">Capability</th>{(['admin', 'member', 'guest'] as RoomRole[]).map((role) => <th key={role} className="p-3 capitalize">{role}</th>)}</tr></thead><tbody>{CAPABILITIES.map((capability) => <tr key={capability.key} className="border-t border-white/10"><td className="p-3 text-white">{capability.label}</td>{(['admin', 'member', 'guest'] as RoomRole[]).map((role) => { const allowed = permissions.some((permission) => permission.role === role && permission.capability === capability.key && permission.allowed); const key = `permission-${role}-${capability.key}`; return <td key={role} className="p-3"><button type="button" disabled={working === key} onClick={() => void run(key, () => setRoomRolePermission(roomId, role, capability.key, !allowed), `${role} permission updated.`)} className={`rounded-lg px-3 py-1.5 font-semibold ${allowed ? 'bg-emerald-500/15 text-emerald-200' : 'bg-white/5 text-neutral-500'}`}>{allowed ? 'Allowed' : 'Denied'}</button></td>; })}</tr>)}</tbody></table></div>}</div>}

              {tab === 'announcements' && <div className="space-y-5"><div><h3 className="font-semibold text-white">Announcements</h3><p className="mt-1 text-sm text-neutral-500">Pinned updates are shown first for authorized room members.</p></div>{settings.feature_flags.announcements === false ? <ReadOnly message="Announcements are currently disabled for this room." /> : <>{canManageAnnouncements && <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4"><textarea value={announcementBody} onChange={(event) => setAnnouncementBody(event.target.value)} rows={4} maxLength={2000} className="omni-input min-h-28" placeholder="Share an update with the room…" /><label className="mt-3 flex items-center gap-2 text-sm text-neutral-300"><input type="checkbox" checked={announcementPinned} onChange={(event) => setAnnouncementPinned(event.target.checked)} /> Pin this announcement</label><button type="button" disabled={!announcementBody.trim() || working === 'announcement'} onClick={() => void run('announcement', async () => { await createRoomAnnouncement(roomId, announcementBody, announcementPinned); setAnnouncementBody(''); setAnnouncementPinned(false); }, 'Announcement published.')} className="omni-button omni-button-primary mt-4">Publish announcement</button></section>}<div className="space-y-3">{announcements.length === 0 ? <ReadOnly message="No announcements yet." /> : announcements.map((announcement) => <article key={announcement.id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4"><div className="mb-2 flex items-center justify-between gap-2"><span className="text-[10px] font-bold uppercase tracking-wider text-violet-200">{announcement.is_pinned ? 'Pinned' : 'Announcement'}</span><span className="text-[10px] text-neutral-500">{formatDate(announcement.created_at)}</span></div>{editingAnnouncement === announcement.id && canManageAnnouncements ? <div><textarea value={editAnnouncementBody} rows={4} maxLength={2000} className="omni-input min-h-24" onChange={(event) => setEditAnnouncementBody(event.target.value)} /><label className="mt-2 flex items-center gap-2 text-xs text-neutral-300"><input type="checkbox" checked={editAnnouncementPinned} onChange={(event) => setEditAnnouncementPinned(event.target.checked)} /> Pinned</label><div className="mt-3 flex gap-2"><button type="button" disabled={!editAnnouncementBody.trim() || working === 'announcement-update'} onClick={() => void run('announcement-update', () => updateRoomAnnouncement(announcement.id, editAnnouncementBody, editAnnouncementPinned).then(() => undefined), 'Announcement updated.')} className="omni-button omni-button-primary">Save update</button><button type="button" onClick={() => setEditingAnnouncement(null)} className="omni-button omni-button-ghost">Cancel</button></div></div> : <><p className="whitespace-pre-wrap text-sm leading-6 text-neutral-200">{announcement.body}</p>{canManageAnnouncements && <button type="button" onClick={() => { setEditingAnnouncement(announcement.id); setEditAnnouncementBody(announcement.body); setEditAnnouncementPinned(announcement.is_pinned); }} className="mt-3 text-xs font-semibold text-violet-200">Edit</button>}</>}</article>)}</div></>}</div>}

              {tab === 'profile' && <div className="space-y-5"><div><h3 className="font-semibold text-white">Room-specific profile</h3><p className="mt-1 text-sm text-neutral-500">This preloaded identity is scoped to this room and never changes the global OmniLume profile.</p></div><section className="space-y-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4"><label className="block text-sm font-medium text-white">Display name<input value={profileName} onChange={(event) => setProfileName(event.target.value)} maxLength={80} className="omni-input mt-2" /></label><label className="block text-sm font-medium text-white">Avatar URL<input value={profileAvatarUrl} onChange={(event) => setProfileAvatarUrl(event.target.value)} maxLength={2048} className="omni-input mt-2" /></label><label className="block text-sm font-medium text-white">Bio<textarea value={profileBio} onChange={(event) => setProfileBio(event.target.value)} maxLength={280} rows={4} className="omni-input mt-2 min-h-28" /></label><button type="button" disabled={working === 'room-profile'} onClick={() => void run('room-profile', () => updateRoomSpecificProfile(roomId, { displayName: profileName || null, avatarUrl: profileAvatarUrl || null, bio: profileBio || null }).then(() => undefined), 'Room-specific profile saved.')} className="omni-button omni-button-primary">{working === 'room-profile' ? 'Saving…' : 'Save room profile'}</button></section></div>}
            </>}
          </div>
        </div>
      </section>
    </div>
  );
}

function StateRow({ state }: { state: MemberState }) {
  const restrictions = state.restriction_types?.join(', ') || 'none';
  return <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs text-neutral-300"><span className="font-semibold text-white">{shortUserId(state.user_id)}</span> · {state.role ?? 'former member'}{state.role === 'guest' && ` · guest expires ${formatDate(state.guest_expires_at)}`}{restrictions !== 'none' && ` · restricted: ${restrictions}`}</div>;
}

function ReadOnly({ message }: { message: string }) {
  return <div className="whitespace-pre-wrap rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-sm leading-6 text-neutral-400">{message}</div>;
}
