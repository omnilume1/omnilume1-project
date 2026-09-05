'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { getMyProfile } from '@/actions/profiles';
import { getLoginPath } from '@/lib/auth';
import { createClient } from '@/utils/supabase/client';
import { OmniIcon } from '@/components/ui/OmniIcon';

export interface AccountView {
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
  profileDetailsCompleted: boolean;
}

function initials(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return (parts.slice(0, 2).map((part) => part[0]).join('') || 'O').toUpperCase();
}

function fallbackDisplayName(email: string | null, metadata: Record<string, unknown>) {
  const metadataName = metadata.full_name ?? metadata.name;
  if (typeof metadataName === 'string' && metadataName.trim()) return metadataName.trim();
  return email?.split('@')[0] || 'OmniLume member';
}

/** Shared internal-topbar account view using the existing browser session and own-profile action. */
export default function CurrentAccountControls({ account: preloadedAccount }: { account?: AccountView } = {}) {
  const [account, setAccount] = useState<AccountView | null>(preloadedAccount ?? null);
  const [resolved, setResolved] = useState(Boolean(preloadedAccount));
  const [lastPreloaded, setLastPreloaded] = useState<AccountView | undefined>(preloadedAccount);
  const pathname = usePathname();
  const supabase = createClient();

  // When the host page already resolved the account (e.g. the profile page's
  // own bundle), skip the duplicate auth/profile round trips entirely. Props
  // are reconciled during render (React's documented state-adjustment pattern)
  // so a refreshed bundle profile updates the chip without extra fetches.
  if (preloadedAccount !== lastPreloaded) {
    setLastPreloaded(preloadedAccount);
    if (preloadedAccount) {
      setAccount(preloadedAccount);
      setResolved(true);
    }
  }

  useEffect(() => {
    if (preloadedAccount) return;
    let active = true;

    async function loadAccount() {
      const { data: { user }, error } = await supabase.auth.getUser();
      if (!active) return;

      if (error || !user) {
        setAccount(null);
        setResolved(true);
        return;
      }

      try {
        const profile = await getMyProfile();
        if (!active) return;
        const metadata = (user.user_metadata ?? {}) as Record<string, unknown>;
        setAccount({
          displayName: profile?.display_name?.trim() || fallbackDisplayName(user.email ?? null, metadata),
          username: profile?.username ?? null,
          avatarUrl: profile?.avatar_url ?? null,
          profileDetailsCompleted: profile?.profile_details_completed === true,
        });
      } catch {
        if (active) {
          const metadata = (user.user_metadata ?? {}) as Record<string, unknown>;
          setAccount({
            displayName: fallbackDisplayName(user.email ?? null, metadata),
            username: null,
            avatarUrl: null,
            profileDetailsCompleted: false,
          });
        }
      } finally {
        if (active) setResolved(true);
      }
    }

    void loadAccount();
    return () => {
      active = false;
    };
  }, [supabase, preloadedAccount]);

  if (!resolved) {
    return <span className="avatar avatar-small account-avatar-loading" aria-label="Checking account" />;
  }

  if (!account) {
    return <Link href={getLoginPath(pathname)} className="public-login internal-sign-in">Sign in</Link>;
  }

  const profileHref = account.profileDetailsCompleted ? '/profile' : '/profile/setup';
  return (
    <>
      <Link href="/home#notifications" className="icon-button" aria-label="Notifications" title="Notifications">
        <OmniIcon name="bell" />
        <span className="notification-dot" />
      </Link>
      <Link href={profileHref} className="avatar avatar-small public-account-avatar" aria-label="Open your profile" title="Profile">
        {account.avatarUrl ? <img src={account.avatarUrl} alt="" /> : initials(account.displayName)}
      </Link>
    </>
  );
}
