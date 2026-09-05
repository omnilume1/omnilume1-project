'use client';

import { useState } from 'react';
import Link from 'next/link';
import { getPublicProfileByUsername } from '@/actions/profiles';
import { normalizeUsername } from '@/lib/profile-validation';
import FloatingDock from '@/components/ui/FloatingDock';
import InternalTopbar from '@/components/ui/InternalTopbar';
import { OmniIcon } from '@/components/ui/OmniIcon';

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
      const profile = await getPublicProfileByUsername(username);
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

  return (
    <div className="omni-internal">
      <InternalTopbar eyebrow="Discover people" title="Search" description="Find an OmniLume member by username." />
      <main className="omni-main-content explore-main">
        <section className="explore-intro glass-card-ambient fade-up">
          <div>
            <p className="section-kicker">People discovery</p>
            <h2 className="section-title">Find someone on OmniLume</h2>
            <p className="section-copy">Search a username to open the existing profile experience.</p>
          </div>
        </section>

        <section className="glass-card-ambient explore-control-card">
          <label htmlFor="user-search" className="explore-control-label"><OmniIcon name="search" size={16} /> User search</label>
          <form onSubmit={(event) => void handleSearch(event)} className="explore-code-form">
            <input id="user-search" type="search" placeholder="Search by username..." value={query} onChange={(event) => { setQuery(event.target.value); setResult(null); setSearchState('idle'); }} className="omni-input" />
            <button type="submit" disabled={!query.trim() || searchState === 'loading'} className="omni-button omni-button-primary shrink-0">{searchState === 'loading' ? 'Searching...' : 'Search'}</button>
          </form>
          {result && <Link href={`/profile/${result.id}`} className="person-row explore-user-result"><span className="person-avatar">{result.avatar_url ? <img src={result.avatar_url} alt="" /> : (result.display_name || result.username || 'O').slice(0, 1).toUpperCase()}</span><span><strong>{result.display_name || result.username || 'OmniLume member'}</strong><small>@{result.username || 'member'} {result.is_private ? '· Private profile' : '· Public profile'}</small></span><OmniIcon name="arrow" size={15} /></Link>}
          {searchState === 'empty' && <p className="mt-3 text-sm text-neutral-500">No users found.</p>}
          {searchState === 'error' && <p className="form-error mt-3" role="alert">Enter a valid username to search.</p>}
        </section>
      </main>
      <FloatingDock />
    </div>
  );
}
