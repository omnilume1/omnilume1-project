'use server';

import { createClient } from '@/utils/supabase/server';
import { isRoomExpired } from '@/lib/room-lifecycle';

export type RecoveryRequestStatus = 'pending' | 'approved' | 'rejected';

export type RecoveryRequest = {
  id: string;
  room_id: string;
  requester_id: string;
  status: RecoveryRequestStatus;
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
};

export type PermanentRoomRequest = RecoveryRequest;

const recoveryRequestColumns = 'id, room_id, requester_id, status, created_at, reviewed_at, reviewed_by';

async function requireUser() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw new Error('Unauthorized');
  return { supabase, user };
}

export async function getRecoveryRequestStatus(roomId: string) {
  try {
    const { supabase, user } = await requireUser();
    const { data, error } = await supabase
      .from('recovery_requests')
      .select(recoveryRequestColumns)
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

export async function getRoomRecoveryRequests(roomId: string) {
  try {
    const { supabase } = await requireUser();
    const { data, error } = await supabase
      .from('recovery_requests')
      .select(recoveryRequestColumns)
      .eq('room_id', roomId)
      .order('created_at', { ascending: true });

    if (error) throw new Error(error.message);
    return { success: true, requests: (data ?? []) as RecoveryRequest[] };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : 'Unable to load recovery requests.' };
  }
}

export async function requestRoomRecovery(roomId: string) {
  try {
    if (!roomId) throw new Error('Room is required.');
    const { supabase, user } = await requireUser();

    const { data: room, error: roomError } = await supabase
      .from('rooms')
      .select('id, expiration_type, expires_at, reopened_until')
      .eq('id', roomId)
      .maybeSingle();
    if (roomError) throw new Error(roomError.message);
    if (!room || room.expiration_type !== 'recoverable' || !isRoomExpired(room) || room.reopened_until) {
      throw new Error('This room is not eligible for recovery.');
    }

    const { data: member, error: memberError } = await supabase
      .from('room_members')
      .select('role, join_status')
      .eq('room_id', roomId)
      .eq('user_id', user.id)
      .maybeSingle();
    if (memberError) throw new Error(memberError.message);
    if (!member || member.join_status !== 'approved' || !['owner', 'admin'].includes(member.role)) {
      throw new Error('Only the current room owner or admin can request recovery.');
    }

    const { data: existing, error: existingError } = await supabase
      .from('recovery_requests')
      .select(recoveryRequestColumns)
      .eq('room_id', roomId)
      .eq('requester_id', user.id)
      .eq('status', 'pending')
      .maybeSingle();
    if (existingError) throw new Error(existingError.message);
    if (existing) return { success: true, request: existing as RecoveryRequest };

    const { data, error } = await supabase
      .from('recovery_requests')
      .insert({ room_id: roomId, requester_id: user.id })
      .select(recoveryRequestColumns)
      .single();
    if (error) throw new Error(error.message);

    return { success: true, request: data as RecoveryRequest };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : 'Unable to submit recovery request.' };
  }
}

export async function reviewRoomRecovery(requestId: string, decision: Exclude<RecoveryRequestStatus, 'pending'>) {
  try {
    const { supabase } = await requireUser();
    const { data, error } = await supabase.rpc('review_recovery_request', {
      p_request_id: requestId,
      p_decision: decision,
    });
    if (error) throw new Error(error.message);
    return { success: true, request: data as RecoveryRequest };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : 'Unable to review recovery request.' };
  }
}

export async function getPermanentRoomRequests(roomId: string) {
  try {
    const { supabase } = await requireUser();
    const { data, error } = await supabase
      .from('room_permanent_requests')
      .select(recoveryRequestColumns)
      .eq('room_id', roomId)
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    return { success: true, requests: (data ?? []) as PermanentRoomRequest[] };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : 'Unable to load permanence requests.' };
  }
}

export async function requestPermanentRoom(roomId: string) {
  try {
    if (!roomId) throw new Error('Room is required.');
    const { supabase, user } = await requireUser();
    const { data: existing, error: existingError } = await supabase
      .from('room_permanent_requests')
      .select(recoveryRequestColumns)
      .eq('room_id', roomId)
      .eq('requester_id', user.id)
      .eq('status', 'pending')
      .maybeSingle();
    if (existingError) throw new Error(existingError.message);
    if (existing) return { success: true, request: existing as PermanentRoomRequest };

    const { data, error } = await supabase
      .from('room_permanent_requests')
      .insert({ room_id: roomId, requester_id: user.id })
      .select(recoveryRequestColumns)
      .single();
    if (error) throw new Error(error.message);
    return { success: true, request: data as PermanentRoomRequest };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : 'Unable to submit permanence request.' };
  }
}

export async function reviewPermanentRoomRequest(requestId: string, decision: Exclude<RecoveryRequestStatus, 'pending'>) {
  try {
    const { supabase } = await requireUser();
    const { data, error } = await supabase.rpc('review_permanent_room_request', {
      p_request_id: requestId,
      p_decision: decision,
    });
    if (error) throw new Error(error.message);
    return { success: true, request: data as PermanentRoomRequest };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : 'Unable to review permanence request.' };
  }
}
