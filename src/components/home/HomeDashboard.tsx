'use client';

import { unwrapAction } from '@/lib/action-result';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getMyFriends } from '@/actions/profiles';
import { getPublicRooms } from '@/actions/rooms';
import type { CurrentAccount } from '@/lib/current-account';
import { createClient } from '@/utils/supabase/client';
import FloatingDock from '@/components/ui/FloatingDock';
import InternalTopbar from '@/components/ui/InternalTopbar';
import HomeOverview from '@/components/home/HomeOverview';
import { OmniIcon } from '@/components/ui/OmniIcon';
import RoomArt, { roomArtFor } from '@/components/ui/RoomArt';

// Children rise in one after another (concept video: 45ms apart).
const stagger = (index: number) => ({ ['--i' as string]: index });

interface Friend {
  user_id: string;
  display_name: string | null;
  username: string | null;
  avatar_url: string | null;
}

interface PublicRoom {
  id: string;
  name: string;
  username: string | null;
  room_members: Array<{ count: number }>;
}

function initials(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return (parts.slice(0, 2).map((part) => part[0]).join('') || 'O').toUpperCase();
}

function DashboardAvatar({ name, src, compact = false }: { name: string; src?: string | null; compact?: boolean }) {
  return (
    <span className={`dashboard-profile-avatar ${compact ? '!h-9 !w-9 !text-xs' : ''}`}>
      {src ? <img src={src} alt="" /> : initials(name)}
    </span>
  );
}

export default function HomeDashboard({ account }: { account: CurrentAccount }) {
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [switchingAccount, setSwitchingAccount] = useState(false);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [publicRooms, setPublicRooms] = useState<PublicRoom[]>([]);
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [dashboardUnavailable, setDashboardUnavailable] = useState(false);
  const router = useRouter();
  const supabase = createClient();
  const shortName = account.displayName.split(/\s+/)[0] || account.displayName;

  useEffect(() => {
    let active = true;

    async function loadDashboardData() {
      const [friendsResult, roomsResult] = await Promise.allSettled([
        getMyFriends().then(unwrapAction),
        getPublicRooms().then(unwrapAction),
      ]);

      if (!active) return;

      if (friendsResult.status === 'fulfilled') setFriends(friendsResult.value as Friend[]);
      if (roomsResult.status === 'fulfilled') setPublicRooms((roomsResult.value ?? []) as PublicRoom[]);
      if (friendsResult.status === 'rejected' || roomsResult.status === 'rejected') setDashboardUnavailable(true);
      setDashboardLoading(false);
    }

    void loadDashboardData();
    return () => {
      active = false;
    };
  }, []);

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await supabase.auth.signOut();
      router.replace('/login');
    } catch {
      setLoggingOut(false);
    }
  };

  const handleSwitchAccount = async () => {
    setSwitchingAccount(true);
    const { error } = await supabase.auth.signOut({ scope: 'local' });
    if (error) {
      setSwitchingAccount(false);
      return;
    }
    router.replace('/login?next=%2Fhome&switch=1');
  };

  return (
    <div className="omni-internal omni-dashboard">
      <InternalTopbar
        eyebrow="Your shared spaces"
        title="Home"
        description="A calm place to find your rooms, people and next moment of progress."
        actions={<Link href="/explore" className="omni-button omni-button-ghost">Explore spaces <OmniIcon name="arrow" size={15} /></Link>}
      />

      {isProfileOpen && <div className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm" onClick={() => setIsProfileOpen(false)} />}

      <aside className={`fixed top-0 right-0 z-40 flex h-full w-80 flex-col justify-between glass-strong rounded-none border-y-0 border-r-0 p-6 transition-transform duration-300 ${isProfileOpen ? 'translate-x-0' : 'translate-x-full'}`}>
        <div>
          <div className="mb-8 flex items-center justify-between">
            <h2 className="text-lg font-bold text-white">Profile menu</h2>
            <button onClick={() => setIsProfileOpen(false)} className="icon-button" aria-label="Close profile menu"><OmniIcon name="close" size={17} /></button>
          </div>
          <div className="glass-card-ambient mb-6 flex items-center gap-3 p-3">
            <DashboardAvatar name={account.displayName} src={account.avatarUrl} compact />
            <div className="min-w-0"><p className="truncate font-semibold text-white">{account.displayName}</p><p className="truncate text-xs text-neutral-500">{account.username ? `@${account.username}` : account.email}</p></div>
          </div>
          <nav className="grid gap-1" aria-label="Profile shortcuts">
            <Link href="/profile" onClick={() => setIsProfileOpen(false)} className="flex items-center gap-3 rounded-xl px-3 py-3 text-sm text-neutral-300 transition hover:bg-white/5"><OmniIcon name="user" size={16} />Profile</Link>
            <Link href="/settings" onClick={() => setIsProfileOpen(false)} className="flex items-center gap-3 rounded-xl px-3 py-3 text-sm text-neutral-300 transition hover:bg-white/5"><OmniIcon name="settings" size={16} />Settings</Link>
          </nav>
        </div>
        <div className="border-t border-white/10 pt-4">
          <button onClick={() => void handleSwitchAccount()} disabled={loggingOut || switchingAccount} className="omni-button omni-button-ghost mb-3 w-full">{switchingAccount ? 'Switching account...' : 'Switch account'}</button>
          <button onClick={() => void handleLogout()} disabled={loggingOut} className="w-full rounded-full border border-red-400/20 bg-red-400/10 py-3 text-sm font-semibold text-red-200 transition hover:bg-red-400/15 disabled:opacity-50">{loggingOut ? 'Signing out...' : 'Log out'}</button>
        </div>
      </aside>

      <main className="omni-main-content">
        <section className="home-grid">
          <div className="home-main">
            <div className="home-greet rise" style={stagger(0)}>
              <div>
                <p className="section-kicker">Good to see you</p>
                <h2>Welcome back, {shortName}.</h2>
                <p>Keep your momentum close. Find a room, start a focus session or pick up where you left off.</p>
              </div>
              <div className="home-greet-actions">
                <Link href="/explore" className="omni-button omni-button-primary">Find a room <OmniIcon name="arrow" size={16} /></Link>
                <Link href="/create-room" className="omni-button omni-button-ghost"><OmniIcon name="plus" size={16} /> Create room</Link>
              </div>
            </div>

            <section className="rise" style={stagger(1)} aria-labelledby="home-discover">
              <div className="home-label"><h2 id="home-discover">Public rooms to explore <span className="section-kicker">Discover</span></h2><Link href="/explore">View all</Link></div>
              {dashboardLoading ? <div className="home-rcards">{[0, 1, 2].map((index) => <div key={index} className="glass-card home-rcard home-rcard-skeleton" aria-hidden="true" />)}</div> : publicRooms.length === 0 ? <p className="glass-card home-empty">There are no public rooms to show right now.</p> : <div className="home-rcards">{publicRooms.slice(0, 3).map((room) => {
                const memberCount = room.room_members[0]?.count ?? 0;
                return (
                  <article key={room.id} className="glass-card home-rcard lift glow">
                    <div className="home-rprev"><RoomArt kind={roomArtFor(room.id)} /><span className="home-live">Public</span></div>
                    <div className="home-rbody">
                      <h3>{room.name}</h3>
                      {room.username ? <p className="home-rmeta">@{room.username}</p> : <p className="home-rmeta">Public room</p>}
                      <div className="home-rfoot"><span><OmniIcon name="users" size={14} /> {memberCount} joined</span><Link href="/explore">Explore</Link></div>
                    </div>
                  </article>
                );
              })}</div>}
            </section>

            <div className="home-stats rise" style={stagger(2)} aria-label="Your OmniLume overview">
              <div className="glass-card home-stat"><span className="section-kicker">Friends</span><strong className="mono">{dashboardLoading ? '—' : friends.length}</strong></div>
              <div className="glass-card home-stat"><span className="section-kicker">Public rooms</span><strong className="mono">{dashboardLoading ? '—' : publicRooms.length}</strong></div>
              <div className="glass-card home-stat"><span className="section-kicker">Profile</span><strong>{account.profileDetailsCompleted ? 'Ready' : 'Set up'}</strong></div>
            </div>

            <div className="home-overview rise" style={stagger(3)}><HomeOverview /></div>
          </div>

          <aside className="home-aside">
            <section className="glass-card home-friends rise" style={stagger(1)} aria-labelledby="home-friends">
              <div className="home-label"><h2 id="home-friends">Friends</h2><span>{dashboardLoading ? '' : friends.length}</span></div>
              {dashboardLoading ? <p className="home-muted">Loading friends...</p> : friends.length === 0 ? <p className="home-muted">No friends yet. Connect from a profile when you are ready.</p> : <div className="home-friend-list">{friends.slice(0, 5).map((friend) => <Link key={friend.user_id} href={`/profile/${friend.user_id}`} className="home-fr"><DashboardAvatar name={friend.display_name || friend.username || 'OmniLume member'} src={friend.avatar_url} compact /><span className="min-w-0"><strong>{friend.display_name || friend.username || 'OmniLume member'}</strong><small>{friend.username ? `@${friend.username}` : 'Friend'}</small></span><OmniIcon name="chevronRight" size={16} className="home-go" /></Link>)}</div>}
            </section>

            <section className="glass-card home-profile rise" style={stagger(2)} aria-label="Your profile">
              <button onClick={() => setIsProfileOpen(true)} className="dashboard-profile-menu-button icon-button" aria-label="Open profile menu"><OmniIcon name="more" size={17} /></button>
              <DashboardAvatar name={account.displayName} src={account.avatarUrl} />
              <h3>{account.displayName}</h3><p>{account.username ? `@${account.username}` : account.email}</p>
              <div className="home-profile-stats"><div><strong className="mono">{dashboardLoading ? '—' : friends.length}</strong><span>Friends</span></div><div><strong className="mono">{dashboardLoading ? '—' : publicRooms.length}</strong><span>Public rooms</span></div><div><strong>{account.profileDetailsCompleted ? '✓' : '—'}</strong><span>Profile</span></div></div>
              {dashboardUnavailable && <p className="home-muted">Some dashboard information is temporarily unavailable. You can still explore rooms.</p>}
            </section>
          </aside>
        </section>
      </main>
      <FloatingDock />
    </div>
  );
}
