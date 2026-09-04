'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getMyFriends } from '@/actions/profiles';
import { getPublicRooms } from '@/actions/rooms';
import type { CurrentAccount } from '@/lib/current-account';
import { createClient } from '@/utils/supabase/client';
import FloatingDock from '@/components/ui/FloatingDock';
import InternalTopbar from '@/components/ui/InternalTopbar';
import { OmniIcon } from '@/components/ui/OmniIcon';

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
        getMyFriends(),
        getPublicRooms(),
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

      <aside className={`fixed top-0 right-0 z-40 flex h-full w-80 flex-col justify-between border-l border-white/10 bg-[#0e1122]/95 p-6 backdrop-blur-xl transition-transform duration-300 ${isProfileOpen ? 'translate-x-0' : 'translate-x-full'}`}>
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
        <section className="dashboard-grid fade-up">
          <div className="dashboard-stack">
            <div className="glass-panel dashboard-hero">
              <p className="section-kicker">Good to see you</p>
              <h2>Welcome back, {shortName}.</h2>
              <p>Keep your momentum close. Find a room, start a focus session or pick up where you left off.</p>
              <div className="dashboard-actions">
                <Link href="/explore" className="omni-button omni-button-primary">Find a room <OmniIcon name="arrow" size={15} /></Link>
                <Link href="/create-room" className="omni-button omni-button-ghost"><OmniIcon name="plus" size={15} /> Create room</Link>
              </div>
            </div>

            <div className="dashboard-stat-grid" aria-label="Your OmniLume overview">
              <div className="glass-card-ambient dashboard-stat"><OmniIcon name="users" size={17} /><strong>{dashboardLoading ? '—' : friends.length}</strong><span>Friends</span></div>
              <div className="glass-card-ambient dashboard-stat"><OmniIcon name="rooms" size={17} /><strong>{dashboardLoading ? '—' : publicRooms.length}</strong><span>Public rooms</span></div>
              <div className="glass-card-ambient dashboard-stat"><OmniIcon name="user" size={17} /><strong>{account.profileDetailsCompleted ? 'Ready' : 'Set up'}</strong><span>Profile</span></div>
            </div>

            <section className="glass-panel glass-card-ambient dashboard-empty-section">
              <div className="section-header"><div><p className="section-kicker">Your calendar</p><h2 className="section-title">Upcoming schedules</h2></div></div>
              <div className="dashboard-empty-copy"><OmniIcon name="clock" size={18} /><p>No upcoming schedules yet. Shared room events will appear here when they are available.</p></div>
            </section>

            <section className="glass-panel glass-card-ambient">
              <div className="section-header"><div><p className="section-kicker">Discover</p><h2 className="section-title">Public rooms to explore</h2></div><Link href="/explore" className="text-xs text-cyan-200 hover:text-white">View all</Link></div>
              {dashboardLoading ? <p className="text-sm text-neutral-500">Loading public rooms...</p> : publicRooms.length === 0 ? <p className="text-sm text-neutral-500">There are no public rooms to show right now.</p> : <div className="grid gap-3 md:grid-cols-3">{publicRooms.slice(0, 3).map((room) => {
                const memberCount = room.room_members[0]?.count ?? 0;
                return <article key={room.id} className="glass-card-ambient dashboard-room-card"><div><span className="room-chip">Public</span><h3 className="mt-3 truncate font-semibold text-white">{room.name}</h3>{room.username && <p className="mt-1 text-xs text-cyan-200">@{room.username}</p>}</div><div className="mt-5 flex items-center justify-between"><span className="inline-flex items-center gap-1 text-xs text-neutral-500"><OmniIcon name="users" size={13} /> {memberCount} joined</span><Link href="/explore" className="text-xs text-cyan-200 hover:text-white">Explore</Link></div></article>;
              })}</div>}
            </section>

            <section className="glass-panel glass-card-ambient"><p className="section-kicker">History</p><h2 className="section-title">Recent rooms</h2><p className="mt-4 text-sm text-neutral-500">No recent room history is available yet.</p></section>
          </div>

          <aside className="glass-card-ambient dashboard-profile-card">
            <button onClick={() => setIsProfileOpen(true)} className="absolute top-4 right-4 icon-button" aria-label="Open profile menu"><OmniIcon name="more" size={17} /></button>
            <DashboardAvatar name={account.displayName} src={account.avatarUrl} />
            <h3>{account.displayName}</h3><p>{account.username ? `@${account.username}` : account.email}</p>
            <div className="mt-8 grid grid-cols-3 gap-2 border-y border-white/10 py-4 text-center"><div><strong className="block text-white">{dashboardLoading ? '—' : friends.length}</strong><span className="text-[10px] text-neutral-500">Friends</span></div><div><strong className="block text-white">{dashboardLoading ? '—' : publicRooms.length}</strong><span className="text-[10px] text-neutral-500">Public rooms</span></div><div><strong className="block text-white">{account.profileDetailsCompleted ? '✓' : '—'}</strong><span className="text-[10px] text-neutral-500">Profile</span></div></div>
            <h4 className="mt-7 text-xs font-semibold uppercase tracking-[.18em] text-neutral-500">Friends</h4>
            {dashboardLoading ? <p className="mt-4 text-sm text-neutral-500">Loading friends...</p> : friends.length === 0 ? <p className="mt-4 text-sm text-neutral-500">No friends yet. Connect from a profile when you are ready.</p> : <div className="mt-4 grid gap-3">{friends.slice(0, 5).map((friend) => <Link key={friend.user_id} href={`/profile/${friend.user_id}`} className="dashboard-friend-row"><DashboardAvatar name={friend.display_name || friend.username || 'OmniLume member'} src={friend.avatar_url} compact /><div className="min-w-0"><p className="truncate text-sm font-medium text-white">{friend.display_name || friend.username || 'OmniLume member'}</p><p className="truncate text-xs text-neutral-500">{friend.username ? `@${friend.username}` : 'Friend'}</p></div></Link>)}</div>}
            {dashboardUnavailable && <p className="mt-5 text-xs text-neutral-500">Some dashboard information is temporarily unavailable. You can still explore rooms.</p>}
          </aside>
        </section>
      </main>
      <FloatingDock />
    </div>
  );
}
