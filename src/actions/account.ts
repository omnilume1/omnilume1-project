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
  const { data: objects, error } = await admin
    .schema('storage')
    .from('objects')
    .select('bucket_id, name')
    .eq('owner_id', userId)
    .neq('bucket_id', 'room_attachments')
    .limit(1000);

  if (error) throw new Error('Unable to prepare personal file deletion.');

  const byBucket = new Map<string, string[]>();
  for (const object of objects ?? []) {
    const paths = byBucket.get(object.bucket_id) ?? [];
    paths.push(object.name);
    byBucket.set(object.bucket_id, paths);
  }

  for (const [bucket, paths] of byBucket) {
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
