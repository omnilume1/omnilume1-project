'use server';

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

export async function createRoomInvite(roomId: string, options: { expiresAt?: string; maxUses?: number; guestLifetimeMinutes?: number } = {}) {
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

export async function validateRoomInvite(token: string) {
  const normalizedToken = normalizeInviteToken(token);
  const supabase = await authenticatedClient();
  const { data, error } = await supabase.rpc('get_room_invite', { p_token: normalizedToken });
  if (error) throw new Error(error.message);
  return data?.[0] ?? null;
}

export async function joinRoomWithInvite(token: string) {
  const normalizedToken = normalizeInviteToken(token);
  const supabase = await authenticatedClient();
  const { data, error } = await supabase.rpc('join_room_with_invite', { p_token: normalizedToken });
  if (error || !data?.[0]) throw new Error(error?.message || 'Invite is invalid or expired.');
  return data[0];
}

export async function revokeRoomInvite(inviteId: string) {
  assertUuid(inviteId, 'invite ID');
  const supabase = await authenticatedClient();
  const { error } = await supabase.rpc('revoke_room_invite', { p_invite_id: inviteId });
  if (error) throw new Error(error.message);
}

export async function leaveRoom(roomId: string) {
  assertUuid(roomId, 'room ID');
  const supabase = await authenticatedClient();
  const { error } = await supabase.rpc('leave_room', { p_room_id: roomId });
  if (error) throw new Error(error.message);
}

export async function moderateRoomMember(roomId: string, userId: string, action: RestrictionAction, reason = '') {
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

export async function transferRoomOwnership(roomId: string, userId: string) {
  assertUuid(roomId, 'room ID');
  assertUuid(userId, 'user ID');
  const supabase = await authenticatedClient();
  const { error } = await supabase.rpc('transfer_room_ownership', { p_room_id: roomId, p_target_user_id: userId });
  if (error) throw new Error(error.message);
}

export async function setRoomMemberRole(roomId: string, userId: string, role: Extract<RoomRole, 'admin' | 'member'>) {
  assertUuid(roomId, 'room ID');
  assertUuid(userId, 'user ID');
  if (role !== 'admin' && role !== 'member') throw new Error('Invalid room role.');
  const supabase = await authenticatedClient();
  const { error } = await supabase.rpc('set_room_member_role', { p_room_id: roomId, p_target_user_id: userId, p_role: role });
  if (error) throw new Error(error.message);
}

export async function updateRoomControls(roomId: string, input: { rules?: string; welcomeMessage?: string; isLocked?: boolean; featureFlags?: Partial<Record<Feature, boolean>> }) {
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

export async function setRoomRolePermission(roomId: string, role: RoomRole, capability: Capability, allowed: boolean) {
  assertUuid(roomId, 'room ID');
  if (!isOneOf(ROLES, role) || !isOneOf(CAPABILITIES, capability) || typeof allowed !== 'boolean') throw new Error('Invalid room permission.');
  const supabase = await authenticatedClient();
  const { error } = await supabase.rpc('set_room_role_permission', { p_room_id: roomId, p_role: role, p_capability: capability, p_allowed: allowed });
  if (error) throw new Error(error.message);
}

export async function updateRoomSpecificProfile(roomId: string, input: { displayName?: string | null; avatarUrl?: string | null; bio?: string | null }) {
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

export async function createRoomAnnouncement(roomId: string, body: string, isPinned = false) {
  assertUuid(roomId, 'room ID');
  assertString(body, 'announcement', 2_000);
  if (!body.trim()) throw new Error('Announcement cannot be empty.');
  if (typeof isPinned !== 'boolean') throw new Error('Invalid pin state.');
  const supabase = await authenticatedClient();
  const { data, error } = await supabase.rpc('create_room_announcement', { p_room_id: roomId, p_body: body.trim(), p_is_pinned: isPinned });
  if (error) throw new Error(error.message);
  return data;
}

export async function updateRoomAnnouncement(announcementId: string, body: string, isPinned: boolean) {
  assertUuid(announcementId, 'announcement ID');
  assertString(body, 'announcement', 2_000);
  if (!body.trim() || typeof isPinned !== 'boolean') throw new Error('Invalid announcement.');
  const supabase = await authenticatedClient();
  const { data, error } = await supabase.rpc('update_room_announcement', { p_announcement_id: announcementId, p_body: body.trim(), p_is_pinned: isPinned });
  if (error) throw new Error(error.message);
  return data;
}

export async function getRoomControlState(roomId: string) {
  assertUuid(roomId, 'room ID');
  const supabase = await authenticatedClient();
  const [settings, permissions, announcements] = await Promise.all([
    supabase.from('room_control_settings').select('rules, welcome_message, is_locked, feature_flags, updated_at').eq('room_id', roomId).maybeSingle(),
    supabase.from('room_role_permissions').select('role, capability, allowed').eq('room_id', roomId),
    supabase.from('room_announcements').select('id, author_id, body, is_pinned, created_at, updated_at').eq('room_id', roomId).order('is_pinned', { ascending: false }).order('created_at', { ascending: false }),
  ]);
  if (settings.error || permissions.error || announcements.error) throw new Error(settings.error?.message || permissions.error?.message || announcements.error?.message || 'Unable to load room controls.');
  return { settings: settings.data, permissions: permissions.data ?? [], announcements: announcements.data ?? [] };
}
