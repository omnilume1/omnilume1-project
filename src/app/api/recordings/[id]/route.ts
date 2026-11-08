import { NextResponse } from 'next/server';
import { isUuid } from '@/lib/music-upload-validation';
import { RECORDINGS_BUCKET } from '@/lib/room-file-contract';
import { getServerStorageProvider } from '@/lib/storage/server-provider';
import { createClient } from '@/utils/supabase/server';

const noStore = { 'Cache-Control': 'private, no-store' };
const fail = (message: string, status: number) => NextResponse.json({ error: message }, { status, headers: noStore });

/** Signed playback URL. RLS (can_view_room_recording) decides who may see the row. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!isUuid(id)) return fail('This recording is not available to you.', 404);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail('Sign in first.', 401);

  const { data } = await supabase.from('room_recordings').select('storage_path, status').eq('id', id).maybeSingle();
  if (!data?.storage_path || data.status !== 'stopped') return fail('This recording is not available to you.', 404);

  try {
    const url = await getServerStorageProvider().createSignedDownloadUrl(RECORDINGS_BUCKET, data.storage_path, 600);
    return NextResponse.json({ url }, { headers: noStore });
  } catch {
    return fail('This recording is not available to you.', 502);
  }
}

/** The RPC authorizes (requester or room manager) and returns the object path to remove. */
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!isUuid(id)) return fail('Unable to delete the recording.', 404);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail('Sign in first.', 401);

  const { data: path, error } = await supabase.rpc('delete_room_recording', { p_recording_id: id });
  if (error) {
    return error.code === '42501'
      ? fail(error.message, 403)
      : fail('Unable to delete the recording.', 400);
  }
  if (typeof path === 'string' && path) {
    try {
      await getServerStorageProvider().delete(RECORDINGS_BUCKET, path);
    } catch {
      return fail('The recording was deleted, but its file could not be removed. It expires with its retention period.', 502);
    }
  }
  return NextResponse.json({ ok: true }, { headers: noStore });
}
