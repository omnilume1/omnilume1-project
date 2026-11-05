'use server';

import { actionResult } from '@/lib/action-result';
import { randomUUID } from 'node:crypto';
import { createClient } from '@/utils/supabase/server';

// 1. Create Room
async function createRoomImpl(formData: FormData) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) throw new Error("Unauthorized");

  const name = formData.get('name') as string;
  const description = formData.get('description') as string;
  const isPrivate = formData.get('is_private') === 'true';
  
  const requestedExpirationType = formData.get('expiration_type');
  const expirationType = requestedExpirationType === 'recoverable' || requestedExpirationType === 'irreversible'
    ? requestedExpirationType
    : requestedExpirationType === 'permanent' || requestedExpirationType === null
      ? 'permanent'
      : null;
  if (!expirationType) throw new Error('Invalid expiration type.');

  const rawHours = formData.get('expires_in_hours');
  const hours = rawHours === null || rawHours === '' ? null : Number(rawHours);
  if (expirationType !== 'permanent' && (hours === null || !Number.isFinite(hours) || hours <= 0 || hours > 720)) {
    throw new Error('Temporary rooms require an expiration between 1 and 720 hours.');
  }
  if (expirationType === 'permanent' && hours !== null && (!Number.isFinite(hours) || hours < 0)) {
    throw new Error('Invalid expiration value.');
  }

  const rawScheduledFor = formData.get('scheduled_for');
  const scheduledForDate = rawScheduledFor === null || rawScheduledFor === ''
    ? null
    : new Date(String(rawScheduledFor));
  if (scheduledForDate && (!Number.isFinite(scheduledForDate.getTime()) || scheduledForDate.getTime() <= Date.now())) {
    throw new Error('Scheduled rooms require a future start time.');
  }

  // Clean username (lowercase, no spaces, only alphanumeric/underscores/dots)
  const rawUsername = formData.get('username') as string;
  const username = rawUsername ? rawUsername.toLowerCase().replace(/[^a-z0-9_.]/g, '') : null;

  // Calculate the exact death timestamp if it's a temporary room
  let expiresAt = null;
  if (expirationType !== 'permanent' && hours !== null) {
    const startTime = scheduledForDate?.getTime() ?? Date.now();
    expiresAt = new Date(startTime + hours * 3600 * 1000).toISOString();
  }

  const roomId = randomUUID();
  const { error: roomError } = await supabase
    .from('rooms')
    .insert({
      id: roomId,
      name,
      description,
      is_private: isPrivate,
      expiration_type: expirationType,
      expires_at: expiresAt,
      scheduled_for: scheduledForDate?.toISOString() ?? null,
      created_by: user.id,
      username: username || null // Pass null if empty to avoid unique constraint errors
    });

  if (roomError) throw new Error(roomError.message);

  // Add the creator as the Owner (Auto-approved)
  const { error: memberError } = await supabase
    .from('room_members')
    .insert({
      room_id: roomId,
      user_id: user.id,
      role: 'owner',
      join_status: 'approved'
    });

  if (memberError) throw new Error(memberError.message);

  // Optional template (Action 13): features, layout, theme and rules. The room
  // is already created, so a template that cannot be applied is not fatal;
  // the owner can apply it again from the room's Controls.
  const templateId = formData.get('template_id');
  if (typeof templateId === 'string' && /^[0-9a-f-]{36}$/i.test(templateId)) {
    await supabase.rpc('apply_room_template', { p_room_id: roomId, p_template_id: templateId });
  }

  return roomId;
}
export async function createRoom(formData: FormData) {
  return actionResult(() => createRoomImpl(formData));
}
// 2. Fetch Public Rooms for Explore Page
async function getPublicRoomsImpl() {
  const supabase = await createClient();
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('rooms')
    .select(`
      id,
      name,
      description,
      username,
      created_at,
      expiration_type,
      deletion_scheduled_at,
      room_members(count)
    `)
    .eq('is_private', false)
    .is('scheduled_for', null)
    .or(`expires_at.is.null,expires_at.gt.${now},reopened_until.gt.${now}`)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return data;
}
export async function getPublicRooms() {
  return actionResult(() => getPublicRoomsImpl());
}

// 3. The Master Join Function (Handles IDs, Usernames, Links, and Join Requests)
async function processRoomJoinImpl(identifier: string) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) throw new Error("Unauthorized");

  // Extract username/ID if the user pasted a full URL (e.g., localhost:3000/r/username)
  let cleanId = identifier.trim();
  if (cleanId.includes('/')) {
     cleanId = cleanId.split('/').pop() || cleanId;
  }
  cleanId = cleanId.replace(/^@/, '').toLowerCase();

  // Action 05 keeps joins inside the database transaction so restrictions and
  // locks cannot be bypassed through a direct table insert.
  const { data, error } = await supabase.rpc('request_room_join', { p_identifier: cleanId });
  if (error || !data || data.length === 0) {
    throw new Error(error?.message || 'Room not found. Check your code, link, or username.');
  }
  return { roomId: data[0].room_id, status: data[0].status };
}
export async function processRoomJoin(identifier: string) {
  return actionResult(() => processRoomJoinImpl(identifier));
}

// The Rooms surface only receives the caller's currently approved memberships.
// RLS on both tables remains the authority for private-room visibility.
async function getMyJoinedRoomsImpl() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error('Unauthorized');

  const { data, error } = await supabase
    .from('room_members')
    .select('role, rooms!inner(id, name, description, username, is_private, expiration_type, expires_at, reopened_until, scheduled_for)')
    .eq('user_id', user.id)
    .eq('join_status', 'approved');
  if (error) throw new Error(error.message);
  return data ?? [];
}
export async function getMyJoinedRooms() {
  return actionResult(() => getMyJoinedRoomsImpl());
}

// 4. Action 14: convert a room into a persistent group. One database
// transaction (convert_room_to_group) decides eligibility and does all of the
// work or none of it; a repeated call returns the same group. A group has no
// username or link, so none is accepted here.
const CONVERSION_ERRORS = new Set(['not_owner', 'not_signed_in', 'not_active', 'irreversible', 'deletion_scheduled', 'owner_invalid', 'e2ee_keys_missing']);
async function convertRoomToGroupImpl(roomId: string) {
  if (typeof roomId !== 'string' || !/^[0-9a-f-]{36}$/i.test(roomId)) throw new Error('Choose a room to convert.');
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error('Sign in to convert a room.');

  const { data, error } = await supabase.rpc('convert_room_to_group', { p_room_id: roomId });
  if (error) {
    // The RPC's own sentences are written for people; anything else is generic.
    throw new Error(CONVERSION_ERRORS.has(error.hint ?? '') ? error.message : 'The room could not be converted. Nothing was changed. Try again.');
  }
  const result = data as { group_id: string; name: string; already_converted: boolean; member_count: number };
  return { groupId: result.group_id, name: result.name, alreadyConverted: result.already_converted, memberCount: result.member_count };
}
export async function convertRoomToGroup(roomId: string) {
  return actionResult(() => convertRoomToGroupImpl(roomId));
}
