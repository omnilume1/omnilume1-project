import type { SupabaseClient } from '@supabase/supabase-js';

export type RoomLifecycleRow = {
  id: string;
  expiration_type: 'permanent' | 'recoverable' | 'irreversible';
  expires_at: string | null;
};

export function isRoomExpired(room: Pick<RoomLifecycleRow, 'expires_at'>, now = Date.now()) {
  if (!room.expires_at) return false;
  const expiresAt = new Date(room.expires_at).getTime();
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

export function roomExpirySeconds(room: Pick<RoomLifecycleRow, 'expires_at'>, now = Date.now()) {
  if (!room.expires_at) return null;
  const expiresAt = new Date(room.expires_at).getTime();
  if (!Number.isFinite(expiresAt)) return 0;
  return Math.max(0, Math.floor((expiresAt - now) / 1000));
}

export async function getRoomLifecycle(
  supabase: SupabaseClient,
  roomId: string,
): Promise<RoomLifecycleRow> {
  const { data, error } = await supabase
    .from('rooms')
    .select('id, expiration_type, expires_at')
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

