'use server';

import { actionResult } from '@/lib/action-result';
import { createClient } from '@/utils/supabase/server';
import { assertActiveRoom, isRoomExpired } from '@/lib/room-lifecycle';

// 1. The Bouncer: Checks if the user is allowed inside the room
async function getRoomAccessImpl(identifier: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { status: 'unauthorized', role: null, room: null };

  // Resolve the exact room ID (in case they used a custom username link)
  const { data: roomData } = await supabase.rpc('get_room_by_identifier', { identifier: identifier.toLowerCase() });
  if (!roomData || roomData.length === 0) return { status: 'not_found', role: null, room: null };
  
  const room = roomData[0];

  // The authorization RPC is the single source of truth for guest expiry,
  // scheduling, lock state, restrictions, and membership visibility.
  const { data: eligibilityData, error: eligibilityError } = await supabase.rpc(
    'get_my_room_join_eligibility',
    { p_room_id: room.id },
  );
  if (eligibilityError) throw new Error(eligibilityError.message);
  const eligibility = eligibilityData?.[0];
  const member = eligibility?.join_status
    ? { role: eligibility.role, join_status: eligibility.join_status }
    : null;

  if (!member) {
    const restrictionState = eligibility?.state;
    if (restrictionState === 'blocked' || restrictionState === 'banned') {
      return { status: restrictionState, role: null, room };
    }
    if (!room.is_private) return { status: 'public_not_joined', role: null, room };
    return { status: 'private_not_joined', role: null, room };
  }

  if (eligibility?.state === 'guest_expired') {
    return { status: 'guest_expired', role: member.role, room };
  }

  if (eligibility?.state === 'scheduled') {
    return { status: 'scheduled', role: member.role, room };
  }

  // Recovery-window rooms resolve for every approved non-guest member (any of
  // them may request recovery; only site owners review). Do not let stale
  // approved membership fall through to the normal room shell.
  if (
    member.join_status === 'approved'
    && room.expiration_type === 'recoverable'
    && isRoomExpired(room)
    && ['owner', 'admin', 'member'].includes(member.role ?? '')
  ) {
    return { status: 'recovery_window', role: member.role, room };
  }

  if (eligibility?.state === 'unavailable' && member.join_status === 'approved') {
    return { status: 'expired', role: member.role, room };
  }

  return { status: member.join_status, role: member.role, room };
}
export async function getRoomAccess(identifier: string) {
  return actionResult(() => getRoomAccessImpl(identifier));
}
// 2. Fetch the clipboard: Gets all members for the sidebar
async function getRoomMembersListImpl(roomId: string) {
  const supabase = await createClient();
  await assertActiveRoom(supabase, roomId);
  
  const { data, error } = await supabase
    .from('room_members')
    .select('user_id, role, join_status, joined_at')
    .eq('room_id', roomId)
    .order('joined_at', { ascending: true });

  if (error) throw new Error(error.message);
  return data;
}
export async function getRoomMembersList(roomId: string) {
  return actionResult(() => getRoomMembersListImpl(roomId));
}

async function getRoomMemberIdentitiesImpl(roomId: string) {
  const supabase = await createClient();
  await assertActiveRoom(supabase, roomId);
  const { data, error } = await supabase.rpc('get_room_member_identities', { p_room_id: roomId });
  if (error) throw new Error(error.message);
  return data ?? [];
}
export async function getRoomMemberIdentities(roomId: string) {
  return actionResult(() => getRoomMemberIdentitiesImpl(roomId));
}

// 3. The Owner's Control: Approve or Reject a pending user
async function manageMemberRequestImpl(roomId: string, targetUserId: string, action: 'approve' | 'reject') {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) throw new Error('Unauthorized');
  await assertActiveRoom(supabase, roomId);

  // Verify the person clicking the button is the Owner or Admin
  const { data: me } = await supabase
    .from('room_members')
    .select('role')
    .eq('room_id', roomId)
    .eq('user_id', user.id)
    .single();

  if (!me || (me.role !== 'owner' && me.role !== 'admin')) {
    throw new Error("Only owners and admins can manage requests.");
  }

  const { error } = await supabase.rpc('review_room_member', {
    p_room_id: roomId,
    p_target_user_id: targetUserId,
    p_action: action,
  });
  if (error) throw new Error(error.message);
}
export async function manageMemberRequest(roomId: string, targetUserId: string, action: 'approve' | 'reject') {
  return actionResult(() => manageMemberRequestImpl(roomId, targetUserId, action));
}
