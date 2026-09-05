'use server';

import { createAdminClient } from '@/utils/supabase/admin';
import { createClient } from '@/utils/supabase/server';
import { ACCOUNT_DELETION_CONFIRMATION } from '@/lib/account-deletion';

async function requireUser() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw new Error('Unauthorized');
  return { supabase, user };
}

async function removePersonalStorage(admin: ReturnType<typeof createAdminClient>, userId: string) {
  // `storage` is intentionally not exposed through PostgREST in this project,
  // so querying storage.objects makes every deletion fail before cleanup. The
  // privileged Storage API is the supported server-side interface instead.
  const { data: buckets, error: bucketError } = await admin.storage.listBuckets();
  if (bucketError) throw new Error('Unable to prepare personal file deletion.');

  for (const { id: bucket } of buckets ?? []) {
    // Room attachments belong to the room lifecycle, never an individual
    // account deletion. Dedicated personal buckets scope uploads by account
    // UUID, which lets cleanup remain ownership-safe without reading the
    // non-exposed storage database schema.
    if (bucket === 'room_attachments') continue;

    const { data: objects, error: listError } = await admin.storage.from(bucket).list(userId, { limit: 1000 });
    if (listError) throw new Error('Unable to prepare personal file deletion.');

    const paths = (objects ?? [])
      .filter((object) => object.id !== null)
      .map((object) => `${userId}/${object.name}`);
    if (paths.length === 0) continue;

    const { error: removeError } = await admin.storage.from(bucket).remove(paths);
    if (removeError) throw new Error('Unable to delete personal files.');
  }
}

/**
 * Permanently deletes the authenticated account after an exact, deliberate
 * confirmation. Shared room attachments are preserved; the database helper
 * first transfers or removes owned rooms safely before auth-user cascades run.
 */
export async function deleteMyAccount(confirmation: string) {
  if (confirmation !== ACCOUNT_DELETION_CONFIRMATION) {
    throw new Error(`Type ${ACCOUNT_DELETION_CONFIRMATION} to confirm account deletion.`);
  }

  const { supabase, user } = await requireUser();
  const admin = createAdminClient();

  const { error: prepareError } = await supabase.rpc('prepare_account_deletion', {
    p_user_id: user.id,
  });
  if (prepareError) throw new Error('Unable to prepare account deletion.');

  await removePersonalStorage(admin, user.id);

  const { error: deleteError } = await admin.auth.admin.deleteUser(user.id);
  if (deleteError) throw new Error('Unable to complete account deletion.');

  await supabase.auth.signOut().catch(() => undefined);
  return { success: true as const };
}
