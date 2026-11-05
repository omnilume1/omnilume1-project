import { createClient } from '@/utils/supabase/client';

// Shared Watch queue and clips (Action 11), read through RLS (watch
// capability) and written only through capability-checked RPCs. Called from
// the browser on purpose: room pages queue server actions one at a time.
// Errors come back as values.

export type QueueEntry = {
  id: string;
  position: number;
  added_by: string;
  created_at: string;
  media: { id: string; file_name: string; media_type: string; title: string | null; artist: string | null } | null;
};

export type MediaClip = {
  id: string;
  media_id: string;
  start_seconds: number;
  end_seconds: number | null;
  label: string;
  created_by: string;
  created_at: string;
};

export type DataResult<T> = { ok: true; data: T } | { ok: false; error: string };

const USER_FACING = new Set(['42501', '23505', '23514', 'P0002', '22023']);
function failure(error: { code?: string; message?: string } | null, fallback: string): { ok: false; error: string } {
  if (error?.code && USER_FACING.has(error.code) && error.message && !/permission denied|row-level security/i.test(error.message)) {
    return { ok: false, error: error.message };
  }
  return { ok: false, error: fallback };
}

export async function listQueue(roomId: string): Promise<DataResult<QueueEntry[]>> {
  const { data, error } = await createClient()
    .from('room_media_queue')
    .select('id, position, added_by, created_at, media:temporary_media(id, file_name, media_type, title:metadata->>title, artist:metadata->>artist)')
    .eq('room_id', roomId)
    .order('position', { ascending: true });
  if (error) return failure(error, 'Unable to load the queue.');
  const rows = (data ?? []) as Array<Omit<QueueEntry, 'media'> & { media: QueueEntry['media'] | QueueEntry['media'][] }>;
  return { ok: true, data: rows.map((row) => ({ ...row, media: Array.isArray(row.media) ? row.media[0] ?? null : row.media })) };
}

export async function addToQueue(roomId: string, mediaId: string): Promise<DataResult<string>> {
  const { data, error } = await createClient().rpc('add_media_to_queue', { p_room_id: roomId, p_media_id: mediaId });
  if (error) return failure(error, 'Unable to add this to the queue.');
  return { ok: true, data: String(data) };
}

export async function removeFromQueue(itemId: string): Promise<DataResult<boolean>> {
  const { data, error } = await createClient().rpc('remove_media_from_queue', { p_item_id: itemId });
  if (error) return failure(error, 'Unable to remove this queue item.');
  return { ok: true, data: data === true };
}

export async function moveInQueue(itemId: string, toIndex: number): Promise<DataResult<boolean>> {
  const { data, error } = await createClient().rpc('move_media_in_queue', { p_item_id: itemId, p_to_index: toIndex });
  if (error) return failure(error, 'Unable to reorder the queue.');
  return { ok: true, data: data === true };
}

export async function listClips(mediaId: string): Promise<DataResult<MediaClip[]>> {
  const { data, error } = await createClient()
    .from('room_media_clips')
    .select('id, media_id, start_seconds, end_seconds, label, created_by, created_at')
    .eq('media_id', mediaId)
    .order('start_seconds', { ascending: true });
  if (error) return failure(error, 'Unable to load clips.');
  return {
    ok: true,
    data: ((data ?? []) as MediaClip[]).map((clip) => ({
      ...clip,
      start_seconds: Number(clip.start_seconds),
      end_seconds: clip.end_seconds === null ? null : Number(clip.end_seconds),
    })),
  };
}

export async function createClip(roomId: string, mediaId: string, start: number, end: number | null, label: string): Promise<DataResult<string>> {
  const { data, error } = await createClient().rpc('create_media_clip', { p_room_id: roomId, p_media_id: mediaId, p_start: start, p_end: end, p_label: label });
  if (error) return failure(error, 'Unable to save this clip.');
  return { ok: true, data: String(data) };
}

export async function deleteClip(clipId: string): Promise<DataResult<boolean>> {
  const { data, error } = await createClient().rpc('delete_media_clip', { p_clip_id: clipId });
  if (error) return failure(error, 'Unable to delete this clip.');
  return { ok: true, data: data === true };
}

export async function loadMemberNames(roomId: string): Promise<Map<string, string>> {
  const { data } = await createClient().rpc('get_room_member_identities', { p_room_id: roomId });
  const names = new Map<string, string>();
  for (const row of (Array.isArray(data) ? data : []) as Array<{ user_id: string; username: string | null; account_display_name: string | null; room_display_name: string | null }>) {
    names.set(row.user_id, row.room_display_name?.trim() || row.account_display_name?.trim() || (row.username ? `@${row.username}` : 'Member'));
  }
  return names;
}
