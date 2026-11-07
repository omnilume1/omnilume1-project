'use server';

import { actionResult } from '@/lib/action-result';
import { createAdminClient } from '@/utils/supabase/admin';
import { createClient } from '@/utils/supabase/server';
import { ACCOUNT_DELETION_CONFIRMATION, isRecentAuthentication, sessionAuthenticatedAt } from '@/lib/account-deletion';
import { MUSIC_BUCKET } from '@/lib/music-upload-validation';
import { getServerStorageProvider } from '@/lib/storage/server-provider';

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

  const storage = getServerStorageProvider();
  if (storage.name === 'r2') {
    const musicPaths = await storage.list(MUSIC_BUCKET, userId);
    await storage.cleanup(MUSIC_BUCKET, musicPaths);
  }

  for (const { id: bucket } of buckets ?? []) {
    // Room attachments belong to the room lifecycle, never an individual
    // account deletion. Dedicated personal buckets scope uploads by account
    // UUID, which lets cleanup remain ownership-safe without reading the
    // non-exposed storage database schema.
    if (bucket === 'room_attachments' || (bucket === MUSIC_BUCKET && storage.name === 'r2')) continue;

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
 * confirmation and a recent sign-in. Shared room attachments are preserved;
 * the database helper first transfers or removes owned rooms safely before
 * auth-user cascades run.
 *
 * A stale session gets `{ reauthRequired: true }` (a value, not a thrown error,
 * so the client can show the sign-in step in production builds) and nothing is
 * deleted.
 */
export async function deleteMyAccount(confirmation: string) {
  return actionResult(async (): Promise<{ success: true } | { success: false; reauthRequired: true }> => {
    if (confirmation !== ACCOUNT_DELETION_CONFIRMATION) {
      throw new Error(`Type ${ACCOUNT_DELETION_CONFIRMATION} to confirm account deletion.`);
    }

    const { supabase, user } = await requireUser();

    // Read the sign-in time from the verified token of this exact session.
    // Checked before any deletion work starts.
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
    if (claimsError || !claimsData || claimsData.claims.sub !== user.id) throw new Error('Unauthorized');
    if (!isRecentAuthentication(sessionAuthenticatedAt(claimsData.claims.amr), Date.now())) {
      return { success: false as const, reauthRequired: true as const };
    }

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
  });
}
