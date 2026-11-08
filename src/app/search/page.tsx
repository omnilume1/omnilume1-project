'use client';

import { unwrapAction } from '@/lib/action-result';
import { useState } from 'react';
import Link from 'next/link';
import { getPublicProfileByUsername } from '@/actions/profiles';
import { normalizeUsername } from '@/lib/profile-validation';
import FloatingDock from '@/components/ui/FloatingDock';
import InternalTopbar from '@/components/ui/InternalTopbar';
import { OmniIcon } from '@/components/ui/OmniIcon';
import styles from './search.module.css';

interface UserSearchResult {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  is_private: boolean;
}

export default function SearchPage() {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<UserSearchResult | null>(null);
  const [searchState, setSearchState] = useState<'idle' | 'loading' | 'empty' | 'error'>('idle');

  async function handleSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const username = normalizeUsername(query);
    if (!username) return;

    setSearchState('loading');
    setResult(null);
    try {
      const profile = await getPublicProfileByUsername(username).then(unwrapAction);
      if (!profile) {
        setSearchState('empty');
        return;
      }
      setResult(profile as UserSearchResult);
      setSearchState('idle');
    } catch {
      setSearchState('error');
    }
  }

  const needle = query.trim().replace(/^@/, '');
  function hit(text: string) {
    const i = needle ? text.toLowerCase().indexOf(needle.toLowerCase()) : -1;
    if (i < 0) return text;
    return <>{text.slice(0, i)}<span className={styles.hit}>{text.slice(i, i + needle.length)}</span>{text.slice(i + needle.length)}</>;
  }

  return (
    <div className="omni-internal">
      <div className={styles.spot} aria-hidden="true" />
      <InternalTopbar eyebrow="Discover people" title="Search" description="Find an OmniLume member by username." />
      <main className={`omni-main-content ${styles.main}`}>
        <div className={styles.col}>
          <h2 className={styles.title}>Find someone on OmniLume</h2>
          <form onSubmit={(event) => void handleSearch(event)} className={styles.bar}>
            <OmniIcon name="search" size={20} />
            <label htmlFor="user-search" className="sr-only">User search</label>
            <input id="user-search" type="search" autoFocus placeholder="Search by username..." value={query} onChange={(event) => { setQuery(event.target.value); setResult(null); setSearchState('idle'); }} className={styles.input} />
            <button type="submit" disabled={!query.trim() || searchState === 'loading'} className={`omni-button omni-button-primary ${styles.go}`}>{searchState === 'loading' ? 'Searching...' : 'Search'}</button>
          </form>
          {result && (
            <section className={styles.group} aria-label="People">
              <p className={styles.label}>People</p>
              <Link href={`/profile/${result.id}`} className={styles.row}>
                <span className="person-avatar">{result.avatar_url ? <img src={result.avatar_url} alt="" /> : (result.display_name || result.username || 'O').slice(0, 1).toUpperCase()}</span>
                <span><strong>{hit(result.display_name || result.username || 'OmniLume member')}</strong><small>@{hit(result.username || 'member')} {result.is_private ? '· Private profile' : '· Public profile'}</small></span>
                <OmniIcon name="arrow" size={15} />
              </Link>
            </section>
          )}
          {searchState === 'empty' && <p className={styles.note}>No users found.</p>}
          {searchState === 'error' && <p className={`form-error ${styles.error}`} role="alert">Enter a valid username to search.</p>}
          {!result && searchState === 'idle' && <p className={styles.hint}>Press Enter to search</p>}
        </div>
      </main>
      <FloatingDock />
    </div>
  );
}
