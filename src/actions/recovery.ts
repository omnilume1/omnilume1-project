'use server';

import { createClient } from '@/utils/supabase/server';

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

export type RecoveryRequestWithRequester = RecoveryRequest & { requester_label: string };

// Any approved (non-guest) member of an expired recoverable room may ask for
// recovery inside its 7-day window, once per room while a request is pending.
// The database policy (can_request_room_recovery) is the authority; the
// checks here only turn its refusals into clear messages.
export async function requestRoomRecovery(roomId: string) {
  try {
    if (!roomId) throw new Error('Room is required.');
    const { supabase, user } = await requireUser();

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
    if (error) {
      if (error.code === '42501') {
        throw new Error('Recovery can be requested only by members of this room, during its 7-day recovery window.');
      }
      if (error.code === '23505') {
        throw new Error('You already have a pending recovery request for this room.');
      }
      throw new Error(error.message);
    }

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

export type RecoveryReviewItem = {
  request_id: string;
  room_id: string;
  room_name: string;
  room_expired_at: string | null;
  window_ends_at: string | null;
  requester_id: string;
  requester_label: string;
  requested_at: string;
  other_pending: number;
};

export async function getRecoveryReviewQueue() {
  try {
    const { supabase } = await requireUser();
    const { data, error } = await supabase.rpc('list_recovery_review_queue');
    if (error) throw new Error(error.code === '42501' ? 'Only a site owner can review recovery requests.' : error.message);
    return { success: true, requests: (data ?? []) as RecoveryReviewItem[] };
  } catch (error: unknown) {
    return { success: false, requests: [] as RecoveryReviewItem[], error: error instanceof Error ? error.message : 'Unable to load recovery requests.' };
  }
}

// §9 permanent rooms: the owner schedules deletion (7–14 day grace period) and
// may cancel it before the grace period ends. Enforced by the RPCs.
export async function scheduleRoomDeletion(roomId: string, graceDays: number) {
  try {
    if (!roomId) throw new Error('Room is required.');
    if (!Number.isInteger(graceDays) || graceDays < 7 || graceDays > 14) throw new Error('Choose a grace period of 7 to 14 days.');
    const { supabase } = await requireUser();
    const { data, error } = await supabase.rpc('schedule_room_deletion', { p_room_id: roomId, p_grace_days: graceDays });
    if (error) throw new Error(error.message);
    return { success: true, deletionScheduledAt: data as string };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : 'Unable to schedule deletion.' };
  }
}

export async function cancelRoomDeletion(roomId: string) {
  try {
    if (!roomId) throw new Error('Room is required.');
    const { supabase } = await requireUser();
    const { error } = await supabase.rpc('cancel_room_deletion', { p_room_id: roomId });
    if (error) throw new Error(error.message);
    return { success: true };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : 'Unable to cancel deletion.' };
  }
}
