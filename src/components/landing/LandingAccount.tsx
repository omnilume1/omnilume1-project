'use client';

import Link from 'next/link';
import { useLayoutEffect, useState } from 'react';
import { SESSION_COOKIE } from '@/lib/session-hint';
import LandingBell from './LandingBell';
import styles from '@/app/landing.module.css';

type Account = { displayName: string; avatarUrl: string | null };

function initials(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return (parts.slice(0, 2).map((part) => part[0]).join('') || 'O').toUpperCase();
}

// The landing is static (served straight from the CDN), so the member parts of its nav fill in here.
// html[data-account] picks the guest or member version before paint; the avatar and bell follow.
export default function LandingAccount() {
  const [account, setAccount] = useState<Account | null>(null);

  useLayoutEffect(() => {
    const root = document.documentElement;
    // Also runs after a client-side visit, where the page's inline hint script does not.
    if (!SESSION_COOKIE.test(document.cookie)) {
      delete root.dataset.account;
      return;
    }
    root.dataset.account = '';
    let cancelled = false;
    fetch('/api/account', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: Account | null) => {
        if (cancelled) return;
        if (data) setAccount(data);
        else delete root.dataset.account; // the cookie outlived its session
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return (
    <span className={`${styles.account} ${styles.memberOnly}`}>
      {account ? <LandingBell /> : <span className={styles.bellSlot} aria-hidden="true" />}
      <Link href="/profile" className="avatar avatar-small" aria-label="Open your profile" title="Profile">
        {account?.avatarUrl ? <img src={account.avatarUrl} alt="" width={34} height={34} /> : account ? initials(account.displayName) : null}
      </Link>
    </span>
  );
}
