'use server';

import { createClient } from '@/utils/supabase/server';
import { isRoomExpired } from '@/lib/room-lifecycle';

export type RecoveryRequestStatus = 'pending' | 'approved' | 'rejected';

type RecoveryRequest = {
  id: string;
  room_id: string;
  requester_id: string;
  status: RecoveryRequestStatus;
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
};

export async function getRecoveryRequestStatus(roomId: string) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return { success: false, error: 'Unauthorized' };

    const { data, error } = await supabase
      .from('recovery_requests')
      .select('id, room_id, requester_id, status, created_at, reviewed_at, reviewed_by')
      .eq('room_id', roomId)
      .eq('requester_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(error.message);
    return { success: true, request: (data as RecoveryRequest | null) ?? null };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : 'Unable to load recovery status.' };
  }
}

export async function requestRoomRecovery(roomId: string) {
  try {
    if (!roomId) throw new Error('Room is required.');

    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) throw new Error('Unauthorized');

    const { data: room, error: roomError } = await supabase
      .from('rooms')
      .select('id, expiration_type, expires_at')
      .eq('id', roomId)
      .maybeSingle();
    if (roomError) throw new Error(roomError.message);
    if (!room || room.expiration_type !== 'recoverable' || !isRoomExpired(room)) {
      throw new Error('This room is not eligible for recovery.');
    }

    const { data: member, error: memberError } = await supabase
      .from('room_members')
      .select('join_status')
      .eq('room_id', roomId)
      .eq('user_id', user.id)
      .maybeSingle();
    if (memberError) throw new Error(memberError.message);
    if (!member || member.join_status !== 'approved') {
      throw new Error('Only approved room members can request recovery.');
    }

    const { data: existing, error: existingError } = await supabase
      .from('recovery_requests')
      .select('id, room_id, requester_id, status, created_at, reviewed_at, reviewed_by')
      .eq('room_id', roomId)
      .eq('requester_id', user.id)
      .eq('status', 'pending')
      .maybeSingle();
    if (existingError) throw new Error(existingError.message);
    if (existing) return { success: true, request: existing as RecoveryRequest };

    const { data, error } = await supabase
      .from('recovery_requests')
      .insert({ room_id: roomId, requester_id: user.id })
      .select('id, room_id, requester_id, status, created_at, reviewed_at, reviewed_by')
      .single();
    if (error) throw new Error(error.message);

    return { success: true, request: data as RecoveryRequest };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : 'Unable to submit recovery request.' };
  }
}

