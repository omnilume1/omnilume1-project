import 'server-only';

import { createClient } from '@/utils/supabase/server';

export interface CurrentAccount {
  id: string;
  email: string | null;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
  profileCompleted: boolean;
  profileDetailsCompleted: boolean;
}

function fallbackDisplayName(email: string | null, metadata: Record<string, unknown>) {
  const metadataName = metadata.full_name ?? metadata.name;
  if (typeof metadataName === 'string' && metadataName.trim()) return metadataName.trim();
  if (email) return email.split('@')[0];
  return 'OmniLume member';
}

/**
 * Returns the authenticated account's presentation-safe identity view. This
 * reads the existing Supabase session and profiles row without creating a
 * separate client-side auth source or exposing sensitive profile fields.
 */
export async function getCurrentAccount(): Promise<CurrentAccount | null> {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) return null;

  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name, username, avatar_url, profile_completed, profile_details_completed')
    .eq('id', user.id)
    .maybeSingle();

  const metadata = (user.user_metadata ?? {}) as Record<string, unknown>;
  const displayName = profile?.display_name?.trim() || fallbackDisplayName(user.email ?? null, metadata);

  return {
    id: user.id,
    email: user.email ?? null,
    displayName,
    username: profile?.username ?? null,
    avatarUrl: profile?.avatar_url ?? null,
    profileCompleted: profile?.profile_completed === true,
    profileDetailsCompleted: profile?.profile_details_completed === true,
  };
}
