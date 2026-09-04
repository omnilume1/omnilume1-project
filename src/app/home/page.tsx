'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/utils/supabase/client';
import FloatingDock from '@/components/ui/FloatingDock';
import InternalTopbar from '@/components/ui/InternalTopbar';
import { OmniIcon } from '@/components/ui/OmniIcon';

export default function HomePage() {
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [switchingAccount, setSwitchingAccount] = useState(false);
  const router = useRouter();
  const supabase = createClient();

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
            <h2 className="text-lg font-bold text-white">Profile Menu</h2>
            <button onClick={() => setIsProfileOpen(false)} className="icon-button" aria-label="Close profile menu"><OmniIcon name="close" size={17} /></button>
          </div>
          <div className="glass-card mb-6 flex items-center gap-3">
            <div className="dashboard-profile-avatar">JD</div>
            <div><p className="font-semibold text-white">John Doe</p><p className="text-xs text-neutral-500">@johndoe</p></div>
          </div>
          <nav className="grid gap-1" aria-label="Profile shortcuts">
            <Link href="/profile" onClick={() => setIsProfileOpen(false)} className="flex items-center gap-3 rounded-xl px-3 py-3 text-sm text-neutral-300 transition hover:bg-white/5"><OmniIcon name="user" size={16} />Profile</Link>
            <a href="#history" className="flex items-center gap-3 rounded-xl px-3 py-3 text-sm text-neutral-300 transition hover:bg-white/5"><OmniIcon name="clock" size={16} />History</a>
            <a href="#notifications" className="flex items-center gap-3 rounded-xl px-3 py-3 text-sm text-neutral-300 transition hover:bg-white/5"><OmniIcon name="bell" size={16} />Notifications</a>
            <Link href="/settings" onClick={() => setIsProfileOpen(false)} className="flex items-center gap-3 rounded-xl px-3 py-3 text-sm text-neutral-300 transition hover:bg-white/5"><OmniIcon name="settings" size={16} />Settings</Link>
          </nav>
        </div>
        <div className="border-t border-white/10 pt-4">
          <button onClick={() => void handleSwitchAccount()} disabled={loggingOut || switchingAccount} className="omni-button omni-button-ghost mb-3 w-full">{switchingAccount ? 'Switching account...' : 'Switch account'}</button>
          <button onClick={handleLogout} disabled={loggingOut} className="w-full rounded-full border border-red-400/20 bg-red-400/10 py-3 text-sm font-semibold text-red-200 transition hover:bg-red-400/15 disabled:opacity-50">{loggingOut ? 'Signing out...' : 'Log out'}</button>
        </div>
      </aside>

      <main className="omni-main-content">
        <section className="dashboard-grid fade-up">
          <div className="dashboard-stack">
            <div className="glass-panel dashboard-hero">
              <p className="section-kicker">Good to see you</p>
              <h2>Welcome back, John.</h2>
              <p>Keep your momentum close. Find a room, start a focus session or pick up where you left off.</p>
              <div className="dashboard-actions">
                <Link href="/explore" className="omni-button omni-button-primary">Find a room <OmniIcon name="arrow" size={15} /></Link>
                <Link href="/create-room" className="omni-button omni-button-ghost"><OmniIcon name="plus" size={15} /> Create room</Link>
              </div>
            </div>

            <div className="dashboard-stat-grid">
              <div className="glass-card dashboard-stat"><OmniIcon name="clock" size={17} /><strong>12h</strong><span>Focus this week</span></div>
              <div className="glass-card dashboard-stat"><OmniIcon name="rooms" size={17} /><strong>04</strong><span>Active rooms</span></div>
              <div className="glass-card dashboard-stat"><OmniIcon name="users" size={17} /><strong>28</strong><span>People connected</span></div>
            </div>

            <section className="glass-panel">
              <div className="section-header"><div><p className="section-kicker">Your calendar</p><h2 className="section-title">Upcoming schedules</h2></div><span className="room-chip"><OmniIcon name="clock" size={13} /> 2 this week</span></div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="glass-card"><p className="section-kicker text-purple-200">Today · 8:00 PM</p><h3 className="font-semibold text-white">Movie Night: Interstellar</h3><p className="mt-2 text-xs text-neutral-500">Hosted by @alex_dev</p></div>
                <div className="glass-card"><p className="section-kicker text-cyan-200">Tomorrow · 4:00 PM</p><h3 className="font-semibold text-white">Math Study Group</h3><p className="mt-2 text-xs text-neutral-500">Focus: Calculus Review</p></div>
              </div>
            </section>

            <section className="glass-panel">
              <div className="section-header"><div><p className="section-kicker">Live now</p><h2 className="section-title">Active public rooms</h2></div><Link href="/explore" className="text-xs text-cyan-200 hover:text-white">View all</Link></div>
              <div className="grid gap-3 md:grid-cols-3">
                {[{ title: 'Lofi Chill & Code', users: 12, tag: 'Music' }, { title: 'Late Night Physics', users: 5, tag: 'Study' }, { title: 'Anime Watch Party', users: 24, tag: 'Watch' }].map((room) => (
                  <div key={room.title} className="glass-card flex flex-col justify-between">
                    <div><span className="room-chip">{room.tag}</span><h3 className="mt-3 font-semibold text-white">{room.title}</h3></div>
                    <div className="mt-5 flex items-center justify-between"><span className="text-xs text-neutral-500"><span className="status-dot mr-2" />{room.users} online</span><Link href="/room/demo" className="text-xs text-cyan-200 hover:text-white">Join</Link></div>
                  </div>
                ))}
              </div>
            </section>

            <section className="glass-panel"><p className="section-kicker">History</p><h2 className="section-title">Recent rooms</h2><p className="mt-4 text-sm text-neutral-500">No recent room history found yet.</p></section>
          </div>

          <aside className="glass-card dashboard-profile-card">
            <button onClick={() => setIsProfileOpen(true)} className="absolute top-4 right-4 icon-button" aria-label="Open profile menu"><OmniIcon name="more" size={17} /></button>
            <div className="dashboard-profile-avatar">JD</div>
            <h3>John Doe</h3><p>@johndoe</p>
            <div className="mt-8 grid grid-cols-3 gap-2 border-y border-white/10 py-4 text-center"><div><strong className="block text-white">24</strong><span className="text-[10px] text-neutral-500">Rooms</span></div><div><strong className="block text-white">186</strong><span className="text-[10px] text-neutral-500">Hours</span></div><div><strong className="block text-white">48</strong><span className="text-[10px] text-neutral-500">Friends</span></div></div>
            <h4 className="mt-7 text-xs font-semibold uppercase tracking-[.18em] text-neutral-500">Online friends</h4>
            <div className="mt-4 grid gap-4">{[{ name: 'Sarah Miller', status: 'In Study Room' }, { name: 'Alex Chen', status: 'Listening to Music' }, { name: 'Rohan Gupta', status: 'Online' }].map((friend) => <div key={friend.name} className="flex items-center gap-3"><div className="relative"><div className="dashboard-profile-avatar !h-9 !w-9 !text-xs">{friend.name[0]}</div><span className="absolute right-0 bottom-0 h-2.5 w-2.5 rounded-full bg-emerald-300 ring-2 ring-[#111217]" /></div><div><p className="text-sm font-medium text-white">{friend.name}</p><p className="text-xs text-neutral-500">{friend.status}</p></div></div>)}</div>
          </aside>
        </section>
      </main>
      <FloatingDock />
    </div>
  );
}
