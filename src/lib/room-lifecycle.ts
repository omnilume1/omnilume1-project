import type { SupabaseClient } from '@supabase/supabase-js';

export type RoomLifecycleRow = {
  id: string;
  expiration_type: 'permanent' | 'recoverable' | 'irreversible';
  expires_at: string | null;
  reopened_until?: string | null;
};

function effectiveDeadline(room: Pick<RoomLifecycleRow, 'expiration_type' | 'expires_at' | 'reopened_until'>, now: number) {
  if (room.expiration_type === 'permanent') return null;

  const reopenedUntil = room.reopened_until ? new Date(room.reopened_until).getTime() : Number.NaN;
  if (Number.isFinite(reopenedUntil) && reopenedUntil > now) return reopenedUntil;

  const expiresAt = room.expires_at ? new Date(room.expires_at).getTime() : Number.NaN;
  return Number.isFinite(expiresAt) ? expiresAt : null;
}

export function isRoomExpired(room: Pick<RoomLifecycleRow, 'expiration_type' | 'expires_at' | 'reopened_until'>, now = Date.now()) {
  const deadline = effectiveDeadline(room, now);
  return deadline !== null && deadline <= now;
}

export function roomExpirySeconds(room: Pick<RoomLifecycleRow, 'expiration_type' | 'expires_at' | 'reopened_until'>, now = Date.now()) {
  const deadline = effectiveDeadline(room, now);
  if (deadline === null) return null;
  return Math.max(0, Math.floor((deadline - now) / 1000));
}

export async function getRoomLifecycle(
  supabase: SupabaseClient,
  roomId: string,
): Promise<RoomLifecycleRow> {
  const { data, error } = await supabase
    .from('rooms')
    .select('id, expiration_type, expires_at, reopened_until')
    .eq('id', roomId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error('Room not found.');

  return data as RoomLifecycleRow;
}

export async function assertActiveRoom(supabase: SupabaseClient, roomId: string) {
  const room = await getRoomLifecycle(supabase, roomId);
  if (isRoomExpired(room)) throw new Error('This room has expired and is no longer active.');
  return room;
}
