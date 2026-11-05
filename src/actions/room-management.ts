'use server';

import { createHash } from 'node:crypto';
import { actionResult } from '@/lib/action-result';
import { createClient } from '@/utils/supabase/server';
import { exportFileName } from '@/lib/room-management-model';

// Backup / export (Action 13). The snapshot is built inside
// export_room_snapshot (owner/admin only, rate limited, audited, no keys or
// ciphertext). The server hashes the exact bytes it returns and records the
// SHA-256 on the audit row so the file can be verified later.
// Provider-neutral: no signing secret is needed (a keyed signature would need
// an owner-provided secret; the audited digest is the free path).
const USER_FACING = new Set(['42501', 'P0429', '22023']);

async function exportRoomImpl(roomId: string) {
  if (typeof roomId !== 'string' || !/^[0-9a-f-]{36}$/i.test(roomId)) throw new Error('Choose a room to export.');
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error('Sign in to export a room.');

  const { data, error } = await supabase.rpc('export_room_snapshot', { p_room_id: roomId });
  if (error || !data) {
    throw new Error(error?.code && USER_FACING.has(error.code) ? error.message : 'The room could not be exported right now.');
  }
  const snapshot = data as { export_id: string; room?: { name?: string }; exported_at: string };
  const json = JSON.stringify(data, null, 2);
  const sha256 = createHash('sha256').update(json).digest('hex');
  const { error: digestError } = await supabase.rpc('record_room_export_digest', { p_export_id: snapshot.export_id, p_sha256: sha256 });
  if (digestError) throw new Error('The export could not be recorded. Try again.');
  return { json, sha256, fileName: exportFileName(snapshot.room?.name ?? 'room', snapshot.exported_at), exportId: snapshot.export_id };
}

export async function exportRoom(roomId: string) {
  return actionResult(() => exportRoomImpl(roomId));
}
