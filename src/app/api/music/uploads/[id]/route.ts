import { NextResponse } from 'next/server';
import { isUuid, MUSIC_BUCKET } from '@/lib/music-upload-validation';
import { createAdminClient } from '@/utils/supabase/admin';
import { createClient } from '@/utils/supabase/server';

/** Owner deletes an upload: the RPC checks ownership and stops playback, then storage, then the row. */
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!isUuid(id)) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });

  const { data, error } = await supabase.rpc('begin_music_upload_delete', { p_upload_id: id });
  if (error) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  const paths = (data ?? []) as string[];
  if (paths.length === 0) return NextResponse.json({ ok: true });

  const admin = createAdminClient();
  const { error: removeError } = await admin.storage.from(MUSIC_BUCKET).remove(paths);
  const { error: completeError } = await admin.rpc('complete_music_upload_cleanup', {
    p_upload_id: id,
    p_error: removeError ? removeError.message : null,
  });
  // The song is already unplayable; a failed removal is retried by the daily cleanup.
  if (removeError || completeError) return NextResponse.json({ ok: false, retrying: true }, { status: 207 });
  return NextResponse.json({ ok: true });
}
