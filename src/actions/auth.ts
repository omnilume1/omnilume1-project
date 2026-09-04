'use server';

import { createClient } from '@/utils/supabase/server';

export type IdentitySetupResult =
  | { success: true }
  | { success: false; error: string };

/**
 * Creates the minimum identity record needed to leave the first-run gate.
 * Full profile fields belong to the later Profiles action.
 */
export async function completeIdentitySetup(): Promise<IdentitySetupResult> {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return { success: false, error: 'Your session has expired. Please sign in again.' };
  }

  const { error } = await supabase
    .from('profiles')
    .upsert(
      { id: user.id, profile_completed: true },
      { onConflict: 'id' },
    );

  if (error) {
    return { success: false, error: 'We could not finish account setup. Please try again.' };
  }

  return { success: true };
}
