'use client';

import { useState } from 'react';
import Link from 'next/link';

export default function RoomPage({ params }: { params: { id: string } }) {
  const [isMicOn, setIsMicOn] = useState(false);
  const [isCamOn, setIsCamOn] = useState(false);
  const [activeTab, setActiveTab] = useState<'chat' | 'people'>('chat');

  return (
    <div className="h-screen bg-[#0a0c16] text-white flex flex-col font-sans overflow-hidden">
      {/* Top Navbar */}
      <header className="h-16 flex items-center justify-between px-6 border-b border-white/10 bg-white/5">
        <div className="flex items-center gap-4">
          <span className="font-bold text-lg">Room: {params.id || 'Lobby'}</span>
          <span className="px-2 py-1 rounded bg-red-500/20 text-red-400 text-xs font-semibold border border-red-500/30 animate-pulse">
            REC
          </span>
        </div>
        <Link
          href="/home"
          className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium transition shadow-lg shadow-red-500/20"
        >
          Leave Room
        </Link>
      </header>

      {/* Main Content Area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Video / Media Area */}
        <main className="flex-1 p-4 flex flex-col gap-4 relative">
          <div className="flex-1 bg-[#15192b] rounded-2xl border border-white/5 flex items-center justify-center relative overflow-hidden shadow-2xl">
            {/* Mock Video Stream */}
            <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-indigo-900/20 to-purple-900/20">
              <p className="text-gray-400 font-medium">Waiting for media stream...</p>
            </div>
            {/* Floating Participant */}
            <div className="absolute bottom-4 right-4 w-48 h-32 bg-black/50 rounded-xl border border-white/10 flex items-center justify-center backdrop-blur-md">
              <div className="w-10 h-10 rounded-full bg-purple-600 flex items-center justify-center font-bold text-lg shadow-lg">JD</div>
            </div>
          </div>

          {/* Bottom Controls */}
          <div className="h-20 bg-white/5 rounded-2xl border border-white/10 flex items-center justify-center gap-4 px-6 backdrop-blur-md">
            <button
              onClick={() => setIsMicOn(!isMicOn)}
              className={`h-12 w-12 rounded-full flex items-center justify-center text-xl transition ${isMicOn ? 'bg-white/10 hover:bg-white/20' : 'bg-red-500/20 text-red-400 hover:bg-red-500/30'}`}
            >
              {isMicOn ? '🎙️' : '🔇'}
            </button>
            <button
              onClick={() => setIsCamOn(!isCamOn)}
              className={`h-12 w-12 rounded-full flex items-center justify-center text-xl transition ${isCamOn ? 'bg-white/10 hover:bg-white/20' : 'bg-red-500/20 text-red-400 hover:bg-red-500/30'}`}
            >
              {isCamOn ? '📷' : '🚫'}
            </button>
            <button className="h-12 w-12 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-xl transition">
              💻
            </button>
            <button className="h-12 w-12 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-xl transition">
              ⚙️
            </button>
          </div>
        </main>

        {/* Right Sidebar (Chat & Participants) */}
        <aside className="w-80 border-l border-white/10 bg-[#0e1122]/80 flex flex-col backdrop-blur-xl">
          {/* Tabs */}
          <div className="flex p-2 gap-2 border-b border-white/10">
            <button
              onClick={() => setActiveTab('chat')}
              className={`flex-1 py-2 text-sm font-medium rounded-lg transition ${activeTab === 'chat' ? 'bg-white/10 text-white shadow-sm' : 'text-gray-400 hover:text-white'}`}
            >
              Chat
            </button>
            <button
              onClick={() => setActiveTab('people')}
              className={`flex-1 py-2 text-sm font-medium rounded-lg transition ${activeTab === 'people' ? 'bg-white/10 text-white shadow-sm' : 'text-gray-400 hover:text-white'}`}
            >
              People (2)
            </button>
          </div>

          {/* Tab Content */}
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
            {activeTab === 'chat' ? (
              <>
                <div className="flex flex-col gap-4 flex-1">
                  <div className="flex gap-3">
                    <div className="w-8 h-8 rounded-full bg-indigo-600 flex-shrink-0 flex items-center justify-center text-xs font-bold">SM</div>
                    <div className="bg-white/5 p-3 rounded-2xl rounded-tl-none text-sm text-gray-200 border border-white/5">
                      Hey! Ready to start the study session?
                    </div>
                  </div>
                  <div className="flex gap-3 flex-row-reverse">
                    <div className="w-8 h-8 rounded-full bg-purple-600 flex-shrink-0 flex items-center justify-center text-xs font-bold">JD</div>
                    <div className="bg-indigo-600 p-3 rounded-2xl rounded-tr-none text-sm text-white shadow-lg shadow-indigo-500/20">
                      Yeah, I'm ready. Let me share my screen.
                    </div>
                  </div>
                </div>
                {/* Chat Input */}
                <div className="mt-auto pt-4 relative">
                  <input
                    type="text"
                    placeholder="Type a message..."
                    className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition text-white placeholder-gray-500"
                  />
                </div>
              </>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3 p-2 rounded-lg bg-white/5 border border-white/10">
                  <div className="w-8 h-8 rounded-full bg-purple-600 flex items-center justify-center text-xs font-bold">JD</div>
                  <span className="text-sm font-medium">John Doe (You)</span>
                </div>
                <div className="flex items-center gap-3 p-2 rounded-lg hover:bg-white/5 transition cursor-pointer">
                  <div className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center text-xs font-bold">SM</div>
                  <span className="text-sm font-medium text-gray-300">Sarah Miller</span>
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}