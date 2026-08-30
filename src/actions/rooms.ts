'use server';

import { createClient } from '@/utils/supabase/server';

// 1. Create Room (Upgraded with Expiration & Anonymous Mode)
export async function createRoom(formData: FormData) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) throw new Error("Unauthorized");

  const name = formData.get('name') as string;
  const description = formData.get('description') as string;
  const isPrivate = formData.get('is_private') === 'true';
  const isAnonymous = formData.get('is_anonymous') === 'true';
  
  const expirationType = formData.get('expiration_type') as string || 'permanent';
  const hours = Number(formData.get('expires_in_hours')) || 0;

  // Clean username (lowercase, no spaces, only alphanumeric/underscores/dots)
  const rawUsername = formData.get('username') as string;
  const username = rawUsername ? rawUsername.toLowerCase().replace(/[^a-z0-9_.]/g, '') : null;

  // Calculate the exact death timestamp if it's a temporary room
  let expiresAt = null;
  if (expirationType !== 'permanent' && hours > 0) {
    expiresAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  }

  const { data: room, error: roomError } = await supabase
    .from('rooms')
    .insert({
      name,
      description,
      is_private: isPrivate,
      is_anonymous: isAnonymous,
      expiration_type: expirationType,
      expires_at: expiresAt,
      created_by: user.id,
      username: username || null // Pass null if empty to avoid unique constraint errors
    })
    .select('id')
    .single();

  if (roomError) throw new Error(roomError.message);

  // Add the creator as the Owner (Auto-approved)
  const { error: memberError } = await supabase
    .from('room_members')
    .insert({
      room_id: room.id,
      user_id: user.id,
      role: 'owner',
      join_status: 'approved'
    });

  if (memberError) throw new Error(memberError.message);

  return room.id;
}

// 2. Fetch Public Rooms for Explore Page
export async function getPublicRooms() {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('rooms')
    .select(`
      id,
      name,
      description,
      username,
      created_at,
      room_members(count)
    `)
    .eq('is_private', false)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return data;
}

// 3. The Master Join Function (Handles IDs, Usernames, Links, and Join Requests)
export async function processRoomJoin(identifier: string) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) throw new Error("Unauthorized");

  // Extract username/ID if the user pasted a full URL (e.g., localhost:3000/r/username)
  let cleanId = identifier.trim();
  if (cleanId.includes('/')) {
     cleanId = cleanId.split('/').pop() || cleanId;
  }
  cleanId = cleanId.toLowerCase();

  // Securely find the room using our new Postgres function
  const { data, error: rpcError } = await supabase.rpc('get_room_by_identifier', { identifier: cleanId });

  if (rpcError || !data || data.length === 0) {
    throw new Error("Room not found. Check your code, link, or username.");
  }

  const room = data[0];

  // Check if the user already requested or joined
  const { data: existing } = await supabase
    .from('room_members')
    .select('join_status')
    .eq('room_id', room.id)
    .eq('user_id', user.id)
    .single();

  if (existing) {
    return { roomId: room.id, status: existing.join_status };
  }

  // If private, send to 'pending'. If public, instantly 'approved'.
  const statusToSet = room.is_private ? 'pending' : 'approved';

  const { error: insertError } = await supabase
    .from('room_members')
    .insert({
      room_id: room.id,
      user_id: user.id,
      role: 'member',
      join_status: statusToSet
    });

  if (insertError) throw new Error(insertError.message);

  return { roomId: room.id, status: statusToSet };
}

// 4. Phase 16: Convert a Temporary Room into a Permanent Group
export async function convertRoomToGroup(roomId: string, groupUsername: string) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) throw new Error("Unauthorized");

  // Verify ownership
  const { data: member } = await supabase
    .from('room_members')
    .select('role')
    .eq('room_id', roomId)
    .eq('user_id', user.id)
    .single();

  if (!member || member.role !== 'owner') {
    throw new Error("Only the room owner can convert this space to a group.");
  }

  // Verify the room is allowed to be converted (Not Irreversible)
  const { data: room } = await supabase
    .from('rooms')
    .select('expiration_type')
    .eq('id', roomId)
    .single();

  if (!room || room.expiration_type === 'irreversible') {
    throw new Error("Irreversible rooms cannot be converted to groups.");
  }

  // Clean the new username
  const cleanUsername = groupUsername.toLowerCase().replace(/[^a-z0-9_.]/g, '');

  // Perform the conversion
  const { error: updateError } = await supabase
    .from('rooms')
    .update({
      is_group: true,
      expiration_type: 'permanent',
      expires_at: null, // Destroy the timer
      username: cleanUsername || null
    })
    .eq('id', roomId);

  if (updateError) throw new Error(updateError.message);

  return true;
}