'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/utils/supabase/client';

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
    <div className="min-h-screen bg-[#0a0c16] text-white font-sans relative overflow-x-hidden">
      {/* Navigation Bar */}
      <nav className="flex items-center justify-between px-6 py-4 border-b border-white/10 backdrop-blur-md bg-white/5 sticky top-0 z-20">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-full bg-gradient-to-tr from-purple-500 to-indigo-500 flex items-center justify-center font-bold text-lg">
            O
          </div>
          <span className="text-xl font-extrabold tracking-wide text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-indigo-200">
            Omnilume
          </span>
        </div>

        {/* Profile Avatar Button */}
        <button
          onClick={() => setIsProfileOpen(true)}
          className="h-10 w-10 rounded-full bg-indigo-600 hover:ring-2 hover:ring-purple-400 transition-all flex items-center justify-center font-bold border border-white/20 cursor-pointer"
        >
          JD
        </button>
      </nav>

      {/* Profile Slide-over Menu Overlay */}
      {isProfileOpen && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-30 transition-opacity"
          onClick={() => setIsProfileOpen(false)}
        />
      )}

      {/* Slide-over Panel */}
      <div
        className={`fixed top-0 right-0 h-full w-80 bg-[#0e1122]/95 border-l border-white/10 backdrop-blur-xl p-6 z-40 transition-transform duration-300 flex flex-col justify-between ${
          isProfileOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div>
          <div className="flex items-center justify-between mb-8">
            <h3 className="text-lg font-bold text-white">Profile Menu</h3>
            <button
              onClick={() => setIsProfileOpen(false)}
              className="text-gray-400 hover:text-white text-xl cursor-pointer"
            >
              ✕
            </button>
          </div>

          <div className="flex items-center gap-3 p-3 bg-white/5 rounded-xl border border-white/10 mb-6">
            <div className="h-12 w-12 rounded-full bg-indigo-600 flex items-center justify-center font-bold">
              JD
            </div>
            <div>
              <p className="font-semibold text-white">John Doe</p>
              <p className="text-xs text-gray-400">@johndoe</p>
            </div>
          </div>

          <ul className="space-y-2">
            <li>
              <a href="#profile" className="block px-4 py-3 rounded-lg hover:bg-white/10 transition text-sm text-gray-200">
                👤 Profile
              </a>
            </li>
            <li>
              <a href="#history" className="block px-4 py-3 rounded-lg hover:bg-white/10 transition text-sm text-gray-200">
                📜 History
              </a>
            </li>
            <li>
              <a href="#notifications" className="block px-4 py-3 rounded-lg hover:bg-white/10 transition text-sm text-gray-200">
                🔔 Notifications
              </a>
            </li>
            <li>
              <a href="#settings" className="block px-4 py-3 rounded-lg hover:bg-white/10 transition text-sm text-gray-200">
                ⚙️ Settings
              </a>
            </li>
          </ul>
        </div>

        <div className="pt-4 border-t border-white/10">
          <button
            onClick={() => void handleSwitchAccount()}
            disabled={loggingOut || switchingAccount}
            className="mb-3 block w-full rounded-lg border border-white/10 bg-white/5 py-2.5 text-center text-sm font-medium text-gray-200 transition hover:bg-white/10 disabled:cursor-wait disabled:opacity-50"
          >
            {switchingAccount ? 'Switching account...' : 'Switch account'}
          </button>
          <button
            onClick={handleLogout}
            disabled={loggingOut}
            className="block w-full text-center py-2.5 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-300 font-medium transition text-sm border border-red-500/30 disabled:opacity-50 cursor-pointer"
          >
            {loggingOut ? 'Signing out...' : 'Log Out'}
          </button>
        </div>
      </div>

      {/* Main Dashboard */}
      <main className="max-w-7xl mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-4 gap-8">
        <div className="lg:col-span-3 space-y-8">
          {/* Greeting */}
          <div>
            <h1 className="text-3xl font-bold">Welcome back, John 👋</h1>
            <p className="text-gray-400 text-sm mt-1">
              Here is what is happening in your shared spaces today.
            </p>
          </div>

          {/* Upcoming Schedules */}
          <div className="bg-white/5 border border-white/10 rounded-2xl p-6 backdrop-blur-md">
            <h2 className="text-xl font-semibold mb-4">📅 Upcoming Schedules</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-4 rounded-xl bg-white/5 border border-white/5 hover:border-purple-500/40 transition">
                <p className="text-xs text-purple-400 font-semibold mb-1">TODAY • 8:00 PM</p>
                <h3 className="font-bold text-white">Movie Night: Interstellar</h3>
                <p className="text-xs text-gray-400 mt-2">Hosted by @alex_dev</p>
              </div>
              <div className="p-4 rounded-xl bg-white/5 border border-white/5 hover:border-purple-500/40 transition">
                <p className="text-xs text-indigo-400 font-semibold mb-1">TOMORROW • 4:00 PM</p>
                <h3 className="font-bold text-white">Math Study Group</h3>
                <p className="text-xs text-gray-400 mt-2">Focus: Calculus Review</p>
              </div>
            </div>
          </div>

          {/* Active Public Rooms */}
          <div className="bg-white/5 border border-white/10 rounded-2xl p-6 backdrop-blur-md">
            <h2 className="text-xl font-semibold mb-4">🔥 Active Public Rooms</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {[
                { title: 'Lofi Chill & Code', users: 12, tag: 'Music' },
                { title: 'Late Night Physics', users: 5, tag: 'Study' },
                { title: 'Anime Watch Party', users: 24, tag: 'Watch' },
              ].map((room, i) => (
                <div key={i} className="p-4 rounded-xl bg-white/5 border border-white/10 flex flex-col justify-between">
                  <div>
                    <span className="text-[10px] px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30 font-semibold uppercase">
                      {room.tag}
                    </span>
                    <h4 className="font-semibold text-white mt-2">{room.title}</h4>
                  </div>
                  <div className="flex items-center justify-between mt-4">
                    <span className="text-xs text-gray-400">👥 {room.users} online</span>
                    <Link
                      href="/room/demo"
                      className="text-xs bg-indigo-600 hover:bg-indigo-500 px-3 py-1.5 rounded-lg text-white transition"
                    >
                      Join
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Recent Rooms */}
          <div className="bg-white/5 border border-white/10 rounded-2xl p-6 backdrop-blur-md">
            <h2 className="text-xl font-semibold mb-4">🕒 Recent Rooms</h2>
            <p className="text-sm text-gray-400">No recent room history found yet.</p>
          </div>
        </div>

        {/* Right Sidebar: Online Friends */}
        <div className="lg:col-span-1">
          <div className="bg-white/5 border border-white/10 rounded-2xl p-6 backdrop-blur-md sticky top-24">
            <h2 className="text-lg font-semibold mb-4">🟢 Online Friends</h2>
            <div className="space-y-4">
              {[
                { name: 'Sarah Miller', status: 'In Study Room' },
                { name: 'Alex Chen', status: 'Listening to Music' },
                { name: 'Rohan Gupta', status: 'Online' },
              ].map((friend, i) => (
                <div key={i} className="flex items-center gap-3 p-2 rounded-xl hover:bg-white/5 transition">
                  <div className="relative">
                    <div className="h-9 w-9 rounded-full bg-purple-600 flex items-center justify-center font-bold text-xs">
                      {friend.name[0]}
                    </div>
                    <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-green-500 ring-2 ring-[#0a0c16]" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-white">{friend.name}</p>
                    <p className="text-xs text-gray-400">{friend.status}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
