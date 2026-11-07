// Daily space reclaim for music uploads (called by the cleanup-expired-rooms
// cron route). Expiry itself is enforced by the database; this only removes
// objects. Order is always storage first, then the row (tombstone), so a failed
// removal is retried on the next run instead of leaving an unreferenced object.
// Framework-free so unit tests can drive it with a fake client.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getServerStorageProvider } from '@/lib/storage/server-provider';

const BUCKET = 'music_uploads';
const BATCH = 200;

type DueUpload = { id: string; object_path: string; cover_path: string | null };

export async function cleanupMusicUploads(supabase: SupabaseClient) {
  const failures: string[] = [];
  let removed = 0;
  let orphansRemoved = 0;

  const due = await supabase.rpc('list_music_uploads_due_for_cleanup', { p_limit: BATCH });
  if (due.error) throw new Error(due.error.message);

  for (const upload of (due.data ?? []) as DueUpload[]) {
    const paths = [upload.object_path, upload.cover_path].filter((path): path is string => Boolean(path));
    let removeError: Error | null = null;
    try {
      await getServerStorageProvider().cleanup(BUCKET, paths);
    } catch (error) {
      removeError = error instanceof Error ? error : new Error('Unable to remove upload objects.');
    }
    const { error: completeError } = await supabase.rpc('complete_music_upload_cleanup', {
      p_upload_id: upload.id,
      p_error: removeError ? removeError.message : null,
    });
    if (removeError || completeError) failures.push(`music upload ${upload.id}: ${(removeError ?? completeError)!.message}`);
    else removed += 1;
  }

  const orphans = await supabase.rpc('list_music_orphan_objects', { p_limit: BATCH });
  if (orphans.error) throw new Error(orphans.error.message);
  const names = ((orphans.data ?? []) as { name: string }[]).map((row) => row.name);
  if (names.length > 0) {
    try {
      await getServerStorageProvider().cleanup(BUCKET, names);
      orphansRemoved = names.length;
    } catch (error) {
      failures.push(`music orphans: ${error instanceof Error ? error.message : 'Unable to remove upload objects.'}`);
    }
  }

  return { removed, orphansRemoved, failures };
}
