'use client';

import { unwrapAction } from '@/lib/action-result';
import { useEffect, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getMyFriends } from '@/actions/profiles';
import { getPublicRooms } from '@/actions/rooms';
import type { CurrentAccount } from '@/lib/current-account';
import { listMyRoomOverview } from '@/lib/management-data';
import type { OverviewRoom } from '@/lib/room-management-model';
import { useFriendsListening } from '@/hooks/useFriendsListening';
import { useCloseOnBack } from '@/hooks/useCloseOnBack';
import { createClient } from '@/utils/supabase/client';
import FloatingDock from '@/components/ui/FloatingDock';
import InternalTopbar from '@/components/ui/InternalTopbar';
import HomeOverview, { useLoaded } from '@/components/home/HomeOverview';
import { Avatar, ComingUpTile, ContinueTile, ExploreTile, FriendsTile, NowPlayingTile, type Friend, type PublicRoom } from '@/components/home/HomeTiles';
import { OmniIcon } from '@/components/ui/OmniIcon';
import styles from '@/components/home/home.module.css';

// The greeting and date depend on the visitor's clock, so they are only known in the browser.
// They fill in before the greeting has finished fading in.
const everyMinute = (onChange: () => void) => { const timer = window.setInterval(onChange, 60_000); return () => window.clearInterval(timer); };
const currentMinute = () => Math.floor(Date.now() / 60_000);
const noMinuteOnServer = () => null;

function greeting(hour: number) {
  return hour >= 5 && hour < 12 ? 'Good morning' : hour >= 12 && hour < 17 ? 'Good afternoon' : 'Good evening';
}

const loadOverview = () => listMyRoomOverview();

export default function HomeDashboard({ account }: { account: CurrentAccount }) {
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [switchingAccount, setSwitchingAccount] = useState(false);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [publicRooms, setPublicRooms] = useState<PublicRoom[]>([]);
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [dashboardUnavailable, setDashboardUnavailable] = useState(false);
  const [rooms, retryRooms] = useLoaded<OverviewRoom[]>(loadOverview);
  const listening = useFriendsListening();
  const minute = useSyncExternalStore(everyMinute, currentMinute, noMinuteOnServer);
  const router = useRouter();
  const supabase = createClient();
  const shortName = account.displayName.split(/\s+/)[0] || account.displayName;
  useCloseOnBack(isProfileOpen, () => setIsProfileOpen(false));

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

  const now = minute === null ? null : new Date(minute * 60_000);
  const waiting = rooms.state === 'ready' ? rooms.data.filter((room) => room.unread_count > 0).length : 0;
  const summary = [
    now?.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }),
    !dashboardLoading && `${friends.length} friend${friends.length === 1 ? '' : 's'}${listening.length ? `, ${listening.length} listening` : ''}`,
    waiting > 0 && `${waiting} room${waiting === 1 ? '' : 's'} waiting for you`,
  ].filter(Boolean).join(' · ');

  return (
    <div className="omni-internal omni-dashboard">
      <InternalTopbar
        title="Home"
        actions={<>
          <Link href="/explore" className="omni-button omni-button-ghost">Explore <OmniIcon name="arrow" size={15} /></Link>
          <button type="button" onClick={() => setIsProfileOpen(true)} className="icon-button" aria-label="Open account menu" aria-expanded={isProfileOpen}><OmniIcon name="more" size={17} /></button>
        </>}
      />

      {isProfileOpen && <div className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm" onClick={() => setIsProfileOpen(false)} />}

      <aside className={`fixed top-0 right-0 z-40 flex h-full w-80 flex-col justify-between glass-strong rounded-none border-y-0 border-r-0 p-6 transition-transform duration-300 ${isProfileOpen ? 'translate-x-0' : 'translate-x-full'}`} aria-hidden={!isProfileOpen} inert={!isProfileOpen}>
        <div>
          <div className="mb-8 flex items-center justify-between">
            <h2 className="text-lg font-bold text-white">Account</h2>
            <button onClick={() => setIsProfileOpen(false)} className="icon-button" aria-label="Close account menu"><OmniIcon name="close" size={17} /></button>
          </div>
          <div className="glass-card-ambient mb-6 flex items-center gap-3 p-3">
            <Avatar name={account.displayName} src={account.avatarUrl} size={36} />
            <div className="min-w-0"><p className="truncate font-semibold text-white">{account.displayName}</p><p className="truncate text-xs text-neutral-500">{account.username ? `@${account.username}` : account.email}</p></div>
          </div>
          <nav className="grid gap-1" aria-label="Account shortcuts">
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
        <div className={styles.greet}>
          <h2>{now ? greeting(now.getHours()) : 'Welcome back'}, {shortName}</h2>
          <p className="mono">{summary || ' '}</p>
          {dashboardUnavailable && <p className={styles.empty} role="status">Some of your dashboard is unavailable right now. You can still explore rooms.</p>}
        </div>

        <div className={styles.bento}>
          <ContinueTile rooms={rooms} />
          <FriendsTile friends={friends} listening={listening} loading={dashboardLoading} />
          <ComingUpTile />
          <NowPlayingTile listening={listening} />
          <ExploreTile rooms={publicRooms} loading={dashboardLoading} />
          <HomeOverview rooms={rooms} retryRooms={retryRooms} />
        </div>
      </main>
      <FloatingDock />
    </div>
  );
}
