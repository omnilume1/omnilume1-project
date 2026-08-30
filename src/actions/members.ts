'use server';

import { createClient } from '@/utils/supabase/server';

// 1. The Bouncer: Checks if the user is allowed inside the room
export async function getRoomAccess(identifier: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { status: 'unauthorized', role: null, room: null };

  // Resolve the exact room ID (in case they used a custom username link)
  const { data: roomData } = await supabase.rpc('get_room_by_identifier', { identifier: identifier.toLowerCase() });
  if (!roomData || roomData.length === 0) return { status: 'not_found', role: null, room: null };
  
  const room = roomData[0];

  // Get the user's membership status
  const { data: member } = await supabase
    .from('room_members')
    .select('role, join_status')
    .eq('room_id', room.id)
    .eq('user_id', user.id)
    .single();

  if (!member) {
    if (!room.is_private) return { status: 'public_not_joined', role: null, room };
    return { status: 'private_not_joined', role: null, room };
  }

  return { status: member.join_status, role: member.role, room };
}

// 2. Fetch the clipboard: Gets all members for the sidebar
export async function getRoomMembersList(roomId: string) {
  const supabase = await createClient();
  
  const { data, error } = await supabase
    .from('room_members')
    .select('user_id, role, join_status, joined_at')
    .eq('room_id', roomId)
    .order('joined_at', { ascending: true });

  if (error) throw new Error(error.message);
  return data;
}

// 3. The Owner's Control: Approve or Reject a pending user
export async function manageMemberRequest(roomId: string, targetUserId: string, action: 'approve' | 'reject') {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Verify the person clicking the button is the Owner or Admin
  const { data: me } = await supabase
    .from('room_members')
    .select('role')
    .eq('room_id', roomId)
    .eq('user_id', user?.id)
    .single();

  if (!me || (me.role !== 'owner' && me.role !== 'admin')) {
    throw new Error("Only owners and admins can manage requests.");
  }

  if (action === 'reject') {
    await supabase.from('room_members').delete().eq('room_id', roomId).eq('user_id', targetUserId);
  } else {
    await supabase.from('room_members').update({ join_status: 'approved' }).eq('room_id', roomId).eq('user_id', targetUserId);
  }
}