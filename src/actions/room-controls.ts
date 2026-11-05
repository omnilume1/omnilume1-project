'use server';

import { actionResult } from '@/lib/action-result';
import { createClient } from '@/utils/supabase/server';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FEATURES = ['chat', 'watch', 'files', 'study', 'announcements'] as const;
const ROLES = ['admin', 'member', 'guest'] as const;
const CAPABILITIES = ['manage_members', 'manage_invites', 'manage_settings', 'manage_announcements', 'chat', 'watch', 'watch_control', 'files', 'study'] as const;

type Feature = typeof FEATURES[number];
type RoomRole = typeof ROLES[number];
type Capability = typeof CAPABILITIES[number];
type RestrictionAction = 'approve' | 'reject' | 'kick' | 'ban' | 'block' | 'unban' | 'unblock';

function assertUuid(value: string, label: string) {
  if (!UUID_PATTERN.test(value)) throw new Error(`Invalid ${label}.`);
}

function assertString(value: string, label: string, maximum: number) {
  if (typeof value !== 'string' || value.length > maximum) throw new Error(`Invalid ${label}.`);
}

function normalizeInviteToken(value: string) {
  assertString(value, 'invite token', 2_048);
  const token = value.trim().split('?')[0].split('#')[0].split('/').filter(Boolean).pop() ?? '';
  if (!/^[a-f0-9]{48}$/i.test(token)) throw new Error('Invalid invite token.');
  return token;
}

function isOneOf<T extends readonly string[]>(values: T, value: string): value is T[number] {
  return (values as readonly string[]).includes(value);
}

async function authenticatedClient() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw new Error('Unauthorized');
  return supabase;
}

async function createRoomInviteImpl(roomId: string, options: { expiresAt?: string; maxUses?: number; guestLifetimeMinutes?: number } = {}) {
  assertUuid(roomId, 'room ID');
  const expiresAt = options.expiresAt ? new Date(options.expiresAt) : null;
  if (options.expiresAt && Number.isNaN(expiresAt?.getTime())) throw new Error('Invalid invite expiry.');
  if (options.maxUses !== undefined && (!Number.isInteger(options.maxUses) || options.maxUses < 1)) throw new Error('Invalid invite usage limit.');
  if (options.guestLifetimeMinutes !== undefined && (!Number.isInteger(options.guestLifetimeMinutes) || options.guestLifetimeMinutes < 5 || options.guestLifetimeMinutes > 10_080)) throw new Error('Invalid guest duration.');
  const supabase = await authenticatedClient();
  const { data, error } = await supabase.rpc('create_room_invite', {
    p_room_id: roomId,
    p_expires_at: expiresAt?.toISOString() ?? null,
    p_max_uses: options.maxUses ?? null,
    p_guest_lifetime_minutes: options.guestLifetimeMinutes ?? null,
  });
  if (error) throw new Error(error.message);
  return data;
}
export async function createRoomInvite(roomId: string, options: { expiresAt?: string; maxUses?: number; guestLifetimeMinutes?: number } = {}) {
  return actionResult(() => createRoomInviteImpl(roomId, options));
}

async function validateRoomInviteImpl(token: string) {
  const normalizedToken = normalizeInviteToken(token);
  const supabase = await authenticatedClient();
  const { data, error } = await supabase.rpc('get_room_invite', { p_token: normalizedToken });
  if (error) throw new Error(error.message);
  return data?.[0] ?? null;
}
export async function validateRoomInvite(token: string) {
  return actionResult(() => validateRoomInviteImpl(token));
}

// Room name and deletion policy for a valid invite, shown before joining
// (master plan §9). Same validity rules as get_room_invite.
async function previewRoomInviteImpl(token: string) {
  const normalizedToken = normalizeInviteToken(token);
  const supabase = await authenticatedClient();
  const { data, error } = await supabase.rpc('get_room_invite_preview', { p_token: normalizedToken });
  if (error) throw new Error(error.message);
  const row = data?.[0];
  if (!row) throw new Error('Invite is invalid or expired.');
  return row as {
    room_id: string;
    room_name: string;
    is_private: boolean;
    expiration_type: string;
    room_expires_at: string | null;
    reopened_until: string | null;
    deletion_scheduled_at: string | null;
    guest_lifetime_minutes: number | null;
  };
}
export async function previewRoomInvite(token: string) {
  return actionResult(() => previewRoomInviteImpl(token));
}

async function joinRoomWithInviteImpl(token: string) {
  const normalizedToken = normalizeInviteToken(token);
  const supabase = await authenticatedClient();
  const { data, error } = await supabase.rpc('join_room_with_invite', { p_token: normalizedToken });
  if (error || !data?.[0]) throw new Error(error?.message || 'Invite is invalid or expired.');
  return data[0];
}
export async function joinRoomWithInvite(token: string) {
  return actionResult(() => joinRoomWithInviteImpl(token));
}

async function revokeRoomInviteImpl(inviteId: string) {
  assertUuid(inviteId, 'invite ID');
  const supabase = await authenticatedClient();
  const { error } = await supabase.rpc('revoke_room_invite', { p_invite_id: inviteId });
  if (error) throw new Error(error.message);
}
export async function revokeRoomInvite(inviteId: string) {
  return actionResult(() => revokeRoomInviteImpl(inviteId));
}

// Historical invite reads intentionally omit the reusable token. A token is
// returned only once to the controller who creates it.
async function listRoomInviteHistoryImpl(roomId: string) {
  assertUuid(roomId, 'room ID');
  const supabase = await authenticatedClient();
  const { data, error } = await supabase.rpc('list_room_invite_history', { p_room_id: roomId });
  if (error) throw new Error(error.message);
  return data ?? [];
}
export async function listRoomInviteHistory(roomId: string) {
  return actionResult(() => listRoomInviteHistoryImpl(roomId));
}

async function getMyRoomJoinEligibilityImpl(roomId: string) {
  assertUuid(roomId, 'room ID');
  const supabase = await authenticatedClient();
  const { data, error } = await supabase.rpc('get_my_room_join_eligibility', { p_room_id: roomId });
  if (error) throw new Error(error.message);
  return data?.[0] ?? {
    state: 'unavailable',
    can_join: false,
    join_status: null,
    role: null,
    guest_expires_at: null,
    restriction_types: [],
  };
}
export async function getMyRoomJoinEligibility(roomId: string) {
  return actionResult(() => getMyRoomJoinEligibilityImpl(roomId));
}

// Controllers receive room-wide guest/restriction state; ordinary members get
// only their own state. The RPC never returns moderation reasons.
async function getRoomMemberControlStatesImpl(roomId: string) {
  assertUuid(roomId, 'room ID');
  const supabase = await authenticatedClient();
  const { data, error } = await supabase.rpc('get_room_member_control_states', { p_room_id: roomId });
  if (error) throw new Error(error.message);
  return data ?? [];
}
export async function getRoomMemberControlStates(roomId: string) {
  return actionResult(() => getRoomMemberControlStatesImpl(roomId));
}

async function setRoomGhostModeImpl(roomId: string, isGhostMode: boolean) {
  assertUuid(roomId, 'room ID');
  if (typeof isGhostMode !== 'boolean') throw new Error('Invalid ghost mode.');
  const supabase = await authenticatedClient();
  const { data, error } = await supabase.rpc('set_room_ghost_mode', {
    p_room_id: roomId,
    p_is_ghost_mode: isGhostMode,
  });
  if (error) throw new Error(error.message);
  return data === true;
}
export async function setRoomGhostMode(roomId: string, isGhostMode: boolean) {
  return actionResult(() => setRoomGhostModeImpl(roomId, isGhostMode));
}

async function getMyRoomPresenceModeImpl(roomId: string) {
  assertUuid(roomId, 'room ID');
  const supabase = await authenticatedClient();
  const { data, error } = await supabase.rpc('get_my_room_presence_mode', { p_room_id: roomId });
  if (error) throw new Error(error.message);
  return data?.[0] ?? { is_ghost_mode: false, can_view_ghost_presence: false };
}
export async function getMyRoomPresenceMode(roomId: string) {
  return actionResult(() => getMyRoomPresenceModeImpl(roomId));
}

async function getRoomRealtimeSnapshotsImpl(roomId: string) {
  assertUuid(roomId, 'room ID');
  const supabase = await authenticatedClient();
  const { data, error } = await supabase.rpc('get_room_realtime_snapshots', { p_room_id: roomId });
  if (error) throw new Error(error.message);
  return data ?? [];
}
export async function getRoomRealtimeSnapshots(roomId: string) {
  return actionResult(() => getRoomRealtimeSnapshotsImpl(roomId));
}

async function saveRoomRealtimeSnapshotImpl(
  roomId: string,
  snapshotType: 'media' | 'timer' | 'settings',
  stateVersion: number,
  payload: Record<string, unknown>,
) {
  assertUuid(roomId, 'room ID');
  if (!Number.isSafeInteger(stateVersion) || stateVersion < 1) throw new Error('Invalid realtime state version.');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid realtime snapshot payload.');
  const supabase = await authenticatedClient();
  const { data, error } = await supabase.rpc('upsert_room_realtime_snapshot', {
    p_room_id: roomId,
    p_snapshot_type: snapshotType,
    p_state_version: stateVersion,
    p_payload: payload,
  });
  if (error) throw new Error(error.message);
  const row = data?.[0] as { snapshot_type?: string; state_version?: number | string; updated_at?: string } | undefined;
  if (!row || row.state_version === undefined) return null;
  const authoritativeVersion = Number(row.state_version);
  if (!Number.isSafeInteger(authoritativeVersion) || authoritativeVersion < 1) {
    throw new Error('Invalid authoritative realtime state version.');
  }
  return { ...row, state_version: authoritativeVersion };
}
export async function saveRoomRealtimeSnapshot(roomId: string, snapshotType: 'media' | 'timer' | 'settings', stateVersion: number, payload: Record<string, unknown>) {
  return actionResult(() => saveRoomRealtimeSnapshotImpl(roomId, snapshotType, stateVersion, payload));
}

async function leaveRoomImpl(roomId: string) {
  assertUuid(roomId, 'room ID');
  const supabase = await authenticatedClient();
  const { error } = await supabase.rpc('leave_room', { p_room_id: roomId });
  if (error) throw new Error(error.message);
}
export async function leaveRoom(roomId: string) {
  return actionResult(() => leaveRoomImpl(roomId));
}

async function moderateRoomMemberImpl(roomId: string, userId: string, action: RestrictionAction, reason = '') {
  assertUuid(roomId, 'room ID');
  assertUuid(userId, 'user ID');
  if (!isOneOf(['approve', 'reject', 'kick', 'ban', 'block', 'unban', 'unblock'] as const, action)) throw new Error('Invalid moderation action.');
  assertString(reason, 'reason', 500);
  const supabase = await authenticatedClient();
  const { error } = await supabase.rpc('review_room_member', {
    p_room_id: roomId,
    p_target_user_id: userId,
    p_action: action,
    p_reason: reason.trim(),
  });
  if (error) throw new Error(error.message);
}
export async function moderateRoomMember(roomId: string, userId: string, action: RestrictionAction, reason = '') {
  return actionResult(() => moderateRoomMemberImpl(roomId, userId, action, reason));
}

async function transferRoomOwnershipImpl(roomId: string, userId: string) {
  assertUuid(roomId, 'room ID');
  assertUuid(userId, 'user ID');
  const supabase = await authenticatedClient();
  const { error } = await supabase.rpc('transfer_room_ownership', { p_room_id: roomId, p_target_user_id: userId });
  if (error) throw new Error(error.message);
}
export async function transferRoomOwnership(roomId: string, userId: string) {
  return actionResult(() => transferRoomOwnershipImpl(roomId, userId));
}

async function setRoomMemberRoleImpl(roomId: string, userId: string, role: Extract<RoomRole, 'admin' | 'member'>) {
  assertUuid(roomId, 'room ID');
  assertUuid(userId, 'user ID');
  if (role !== 'admin' && role !== 'member') throw new Error('Invalid room role.');
  const supabase = await authenticatedClient();
  const { error } = await supabase.rpc('set_room_member_role', { p_room_id: roomId, p_target_user_id: userId, p_role: role });
  if (error) throw new Error(error.message);
}
export async function setRoomMemberRole(roomId: string, userId: string, role: Extract<RoomRole, 'admin' | 'member'>) {
  return actionResult(() => setRoomMemberRoleImpl(roomId, userId, role));
}

async function updateRoomControlsImpl(roomId: string, input: { rules?: string; welcomeMessage?: string; isLocked?: boolean; featureFlags?: Partial<Record<Feature, boolean>> }) {
  assertUuid(roomId, 'room ID');
  if (input.rules !== undefined) assertString(input.rules, 'rules', 5_000);
  if (input.welcomeMessage !== undefined) assertString(input.welcomeMessage, 'welcome message', 1_000);
  if (input.isLocked !== undefined && typeof input.isLocked !== 'boolean') throw new Error('Invalid lock state.');
  if (input.featureFlags !== undefined) {
    for (const [feature, enabled] of Object.entries(input.featureFlags)) {
      if (!isOneOf(FEATURES, feature) || typeof enabled !== 'boolean') throw new Error('Invalid feature flags.');
    }
  }
  const supabase = await authenticatedClient();
  const { data, error } = await supabase.rpc('update_room_controls', {
    p_room_id: roomId,
    p_rules: input.rules ?? null,
    p_welcome_message: input.welcomeMessage ?? null,
    p_is_locked: input.isLocked ?? null,
    p_feature_flags: input.featureFlags ?? null,
  });
  if (error) throw new Error(error.message);
  return data;
}
export async function updateRoomControls(roomId: string, input: { rules?: string; welcomeMessage?: string; isLocked?: boolean; featureFlags?: Partial<Record<Feature, boolean>> }) {
  return actionResult(() => updateRoomControlsImpl(roomId, input));
}

// Action 09: the room's default layout preset, layout lock and theme
// (manage_settings; re-checked by update_room_appearance).
const ROOM_LAYOUT_VALUES = ['balanced', 'stage', 'chat'] as const;
const ROOM_THEME_VALUES = ['violet', 'ocean', 'emerald', 'amber', 'rose', 'graphite'] as const;
async function updateRoomAppearanceImpl(roomId: string, input: { defaultLayout: string; layoutLocked: boolean; theme: string }) {
  assertUuid(roomId, 'room ID');
  if (!isOneOf(ROOM_LAYOUT_VALUES, input.defaultLayout)) throw new Error('Choose a valid layout.');
  if (!isOneOf(ROOM_THEME_VALUES, input.theme)) throw new Error('Choose a valid theme.');
  if (typeof input.layoutLocked !== 'boolean') throw new Error('Invalid layout lock.');
  const supabase = await authenticatedClient();
  const { data, error } = await supabase.rpc('update_room_appearance', {
    p_room_id: roomId,
    p_default_layout: input.defaultLayout,
    p_layout_locked: input.layoutLocked,
    p_theme: input.theme,
  });
  if (error) throw new Error(error.code === '42501' ? 'Only members who manage room settings can change the layout and theme.' : error.message);
  return data as { default_layout: string; layout_locked: boolean; theme: string };
}
export async function updateRoomAppearance(roomId: string, input: { defaultLayout: string; layoutLocked: boolean; theme: string }) {
  return actionResult(() => updateRoomAppearanceImpl(roomId, input));
}

async function setRoomRolePermissionImpl(roomId: string, role: RoomRole, capability: Capability, allowed: boolean) {
  assertUuid(roomId, 'room ID');
  if (!isOneOf(ROLES, role) || !isOneOf(CAPABILITIES, capability) || typeof allowed !== 'boolean') throw new Error('Invalid room permission.');
  const supabase = await authenticatedClient();
  const { error } = await supabase.rpc('set_room_role_permission', { p_room_id: roomId, p_role: role, p_capability: capability, p_allowed: allowed });
  if (error) throw new Error(error.message);
}
export async function setRoomRolePermission(roomId: string, role: RoomRole, capability: Capability, allowed: boolean) {
  return actionResult(() => setRoomRolePermissionImpl(roomId, role, capability, allowed));
}

async function updateRoomSpecificProfileImpl(roomId: string, input: { displayName?: string | null; avatarUrl?: string | null; bio?: string | null }) {
  assertUuid(roomId, 'room ID');
  if (input.displayName !== undefined && input.displayName !== null) assertString(input.displayName, 'display name', 80);
  if (input.avatarUrl !== undefined && input.avatarUrl !== null) assertString(input.avatarUrl, 'avatar URL', 2_048);
  if (input.bio !== undefined && input.bio !== null) assertString(input.bio, 'bio', 280);
  const supabase = await authenticatedClient();
  const { data, error } = await supabase.rpc('upsert_room_member_profile', {
    p_room_id: roomId,
    p_display_name: input.displayName ?? null,
    p_avatar_url: input.avatarUrl ?? null,
    p_bio: input.bio ?? null,
  });
  if (error) throw new Error(error.message);
  return data;
}
export async function updateRoomSpecificProfile(roomId: string, input: { displayName?: string | null; avatarUrl?: string | null; bio?: string | null }) {
  return actionResult(() => updateRoomSpecificProfileImpl(roomId, input));
}

async function getRoomSpecificProfileImpl(roomId: string, userId?: string) {
  assertUuid(roomId, 'room ID');
  if (userId !== undefined) assertUuid(userId, 'user ID');
  const supabase = await authenticatedClient();
  const { data, error } = await supabase.rpc('get_room_member_profile', {
    p_room_id: roomId,
    p_user_id: userId ?? null,
  });
  if (error) throw new Error(error.message);
  return data?.[0] ?? null;
}
export async function getRoomSpecificProfile(roomId: string, userId?: string) {
  return actionResult(() => getRoomSpecificProfileImpl(roomId, userId));
}

async function getMyRoomSpecificProfileImpl(roomId: string) {
  return getRoomSpecificProfileImpl(roomId);
}
export async function getMyRoomSpecificProfile(roomId: string) {
  return actionResult(() => getMyRoomSpecificProfileImpl(roomId));
}

async function createRoomAnnouncementImpl(roomId: string, body: string, isPinned = false) {
  assertUuid(roomId, 'room ID');
  assertString(body, 'announcement', 2_000);
  if (!body.trim()) throw new Error('Announcement cannot be empty.');
  if (typeof isPinned !== 'boolean') throw new Error('Invalid pin state.');
  const supabase = await authenticatedClient();
  const { data, error } = await supabase.rpc('create_room_announcement', { p_room_id: roomId, p_body: body.trim(), p_is_pinned: isPinned });
  if (error) throw new Error(error.message);
  return data;
}
export async function createRoomAnnouncement(roomId: string, body: string, isPinned = false) {
  return actionResult(() => createRoomAnnouncementImpl(roomId, body, isPinned));
}

async function updateRoomAnnouncementImpl(announcementId: string, body: string, isPinned: boolean) {
  assertUuid(announcementId, 'announcement ID');
  assertString(body, 'announcement', 2_000);
  if (!body.trim() || typeof isPinned !== 'boolean') throw new Error('Invalid announcement.');
  const supabase = await authenticatedClient();
  const { data, error } = await supabase.rpc('update_room_announcement', { p_announcement_id: announcementId, p_body: body.trim(), p_is_pinned: isPinned });
  if (error) throw new Error(error.message);
  return data;
}
export async function updateRoomAnnouncement(announcementId: string, body: string, isPinned: boolean) {
  return actionResult(() => updateRoomAnnouncementImpl(announcementId, body, isPinned));
}

async function getRoomControlStateImpl(roomId: string) {
  assertUuid(roomId, 'room ID');
  const supabase = await authenticatedClient();
  const [settings, permissions, announcements, membership, profile, presence] = await Promise.all([
    supabase.from('room_control_settings').select('rules, welcome_message, is_locked, feature_flags, default_layout, layout_locked, theme, updated_at').eq('room_id', roomId).maybeSingle(),
    supabase.from('room_role_permissions').select('role, capability, allowed').eq('room_id', roomId),
    supabase.from('room_announcements').select('id, author_id, body, is_pinned, created_at, updated_at').eq('room_id', roomId).order('is_pinned', { ascending: false }).order('created_at', { ascending: false }),
    supabase.rpc('get_room_member_control_states', { p_room_id: roomId }),
    supabase.rpc('get_room_member_profile', { p_room_id: roomId, p_user_id: null }),
    supabase.rpc('get_my_room_presence_mode', { p_room_id: roomId }),
  ]);
  if (settings.error || permissions.error || announcements.error || membership.error || profile.error || presence.error) throw new Error(settings.error?.message || permissions.error?.message || announcements.error?.message || membership.error?.message || profile.error?.message || presence.error?.message || 'Unable to load room controls.');
  return {
    settings: settings.data,
    permissions: permissions.data ?? [],
    announcements: announcements.data ?? [],
    memberStates: membership.data ?? [],
    myRoomProfile: profile.data?.[0] ?? null,
    myPresenceMode: presence.data?.[0] ?? { is_ghost_mode: false, can_view_ghost_presence: false },
  };
}
export async function getRoomControlState(roomId: string) {
  return actionResult(() => getRoomControlStateImpl(roomId));
}
