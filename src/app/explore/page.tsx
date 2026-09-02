'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getPublicRooms, processRoomJoin } from '@/actions/rooms';

interface PublicRoom {
  id: string;
  name: string;
  username: string | null;
  room_members: Array<{ count: number }>;
}

export default function ExploreRoomsPage() {
  const [rooms, setRooms] = useState<PublicRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [processingId, setProcessingId] = useState<string | null>(null);
  
  const [searchQuery, setSearchQuery] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [codeStatus, setCodeStatus] = useState<{ type: 'error' | 'success', msg: string } | null>(null);

  const router = useRouter();

  useEffect(() => {
    async function fetchRooms() {
      try {
        const data = await getPublicRooms();
        setRooms(data || []);
      } catch (error: unknown) {
        console.error("Failed to load rooms:", error instanceof Error ? error.message : "unknown error");
      } finally {
        setLoading(false);
      }
    }
    fetchRooms();
  }, []);

  const handleJoin = async (identifier: string, isFromBox: boolean = false) => {
    if (isFromBox) {
      if (!identifier.trim()) return;
      setCodeStatus(null);
    }
    
    setProcessingId(identifier);

    try {
      const result = await processRoomJoin(identifier);
      
      if (result.status === 'pending') {
        // UX FIX: Do NOT route them to the room. Just show a message.
        if (isFromBox) {
          setCodeStatus({ type: 'success', msg: "Request Sent! You can keep browsing until approved." });
        } else {
          alert("Request Sent! You can keep browsing until the owner approves you.");
        }
      } else {
        // If approved (public room, or already approved private room), go straight in
        router.push(`/room/${result.roomId}`);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Something went wrong. Please try again.";
      if (message.toLowerCase().includes('unauthorized')) {
        router.push('/login?next=/explore');
        return;
      }
      if (isFromBox) setCodeStatus({ type: 'error', msg: message });
      else alert(message);
    } finally {
      setProcessingId(null);
    }
  };

  const filteredRooms = rooms.filter(room => 
    room.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
    (room.username && room.username.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  return (
    <div className="min-h-screen bg-[#050505] text-white p-8 font-sans selection:bg-neutral-800">
      <div className="max-w-5xl mx-auto flex flex-col gap-8">
        
        <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-neutral-800 pb-6">
          <div>
            <h1 className="text-2xl font-semibold">Explore Spaces</h1>
            <p className="text-neutral-500 text-sm mt-1">Discover public rooms or enter a private invite link.</p>
          </div>
          <Link href="/create-room" className="px-4 py-2 bg-white text-black text-sm font-semibold rounded-md hover:bg-neutral-200 transition text-center">
            + Create Room
          </Link>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-[#0a0a0a] border border-neutral-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-neutral-300 mb-3">Search Public Rooms</h2>
            <input type="text" placeholder="Search by name or @username..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="w-full bg-[#050505] border border-neutral-800 rounded-md px-4 py-2.5 text-sm text-white focus:outline-none focus:border-neutral-500 transition" />
          </div>

          <div className="bg-[#0a0a0a] border border-neutral-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-neutral-300 mb-3">Have a Secret Link or Code?</h2>
            <form onSubmit={(e) => { e.preventDefault(); handleJoin(roomCode, true); }} className="flex gap-2">
              <input type="text" placeholder="Paste link, username, or UUID..." value={roomCode} onChange={(e) => setRoomCode(e.target.value)} className="flex-1 bg-[#050505] border border-neutral-800 rounded-md px-4 py-2.5 text-sm text-white focus:outline-none focus:border-neutral-500 transition" />
              <button type="submit" disabled={!roomCode.trim() || processingId === roomCode} className="px-4 py-2.5 bg-neutral-200 text-black font-semibold text-sm rounded-md disabled:opacity-50 hover:bg-white transition">
                {processingId === roomCode ? '...' : 'Join'}
              </button>
            </form>
            {codeStatus && (
              <p className={`text-xs mt-2 font-medium ${codeStatus.type === 'success' ? 'text-emerald-500' : 'text-red-500'}`}>
                {codeStatus.msg}
              </p>
            )}
          </div>
        </div>

        <div>
          <h2 className="text-[10px] text-neutral-500 mb-4 uppercase tracking-wider">Public Spaces</h2>
          {loading ? (
            <div className="text-neutral-500 text-sm animate-pulse">Loading public spaces...</div>
          ) : filteredRooms.length === 0 ? (
            <div className="border border-neutral-800 border-dashed rounded-xl p-12 text-center text-neutral-500 text-sm">No public rooms found.</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredRooms.map((room) => {
                const memberCount = room.room_members[0]?.count || 0;
                return (
                  <div key={room.id} className="bg-[#0a0a0a] border border-neutral-800 rounded-xl p-5 flex flex-col gap-4 hover:border-neutral-700 transition">
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-[10px] font-bold text-emerald-500 bg-emerald-500/10 px-2 py-1 rounded tracking-wider">PUBLIC</span>
                        <span className="text-xs text-neutral-500">👥 {memberCount} joined</span>
                      </div>
                      <h3 className="font-semibold text-lg text-neutral-200 truncate">{room.name}</h3>
                      {room.username && <p className="text-xs text-emerald-500 mt-1 font-medium">@{room.username}</p>}
                    </div>

                    <button onClick={() => handleJoin(room.id)} disabled={processingId === room.id} className="w-full mt-auto py-2.5 bg-neutral-900 border border-neutral-800 hover:bg-neutral-800 text-white rounded-md text-sm font-medium transition disabled:opacity-50">
                      {processingId === room.id ? 'Joining...' : 'Join Room'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
