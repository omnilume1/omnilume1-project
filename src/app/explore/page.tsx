'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getPublicRooms, processRoomJoin } from '@/actions/rooms';
import { getLoginPath } from '@/lib/auth';
import { createClient } from '@/utils/supabase/client';
import FloatingDock from '@/components/ui/FloatingDock';
import InternalTopbar from '@/components/ui/InternalTopbar';
import { OmniIcon } from '@/components/ui/OmniIcon';

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
  const supabase = createClient();

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

    try {
      const { data: { user }, error: sessionError } = await supabase.auth.getUser();
      if (sessionError || !user) {
        router.push(getLoginPath('/explore'));
        return;
      }
    } catch {
      router.push(getLoginPath('/explore'));
      return;
    }

    setProcessingId(identifier);

    try {
      const result = await processRoomJoin(identifier);
      if (result.status === 'pending') {
        if (isFromBox) {
          setCodeStatus({ type: 'success', msg: "Request sent. You can keep browsing until the owner approves you." });
        } else {
          alert("Request sent. You can keep browsing until the owner approves you.");
        }
      } else {
        router.push(`/room/${result.roomId}`);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Something went wrong. Please try again.";
      if (message.toLowerCase().includes('unauthorized') || message.includes('React error #441')) {
        router.push(getLoginPath('/explore'));
        return;
      }
      if (isFromBox) setCodeStatus({ type: 'error', msg: message });
      else alert(message);
    } finally {
      setProcessingId(null);
    }
  };

  const filteredRooms = rooms.filter((room) => room.name.toLowerCase().includes(searchQuery.toLowerCase()) || (room.username && room.username.toLowerCase().includes(searchQuery.toLowerCase())));

  return (
    <div className="omni-internal">
      <InternalTopbar eyebrow="Discover together" title="Explore" description="Find public spaces or use an invite from someone you know." actions={<Link href="/create-room" className="omni-button omni-button-primary"><OmniIcon name="plus" size={15} /> Create room</Link>} />
      <main className="omni-main-content">
        <section className="section-header fade-up">
          <div><p className="section-kicker">Public spaces</p><h2 className="section-title">Find your next room</h2><p className="section-copy">Search by room name or username, then join when the space feels right.</p></div>
        </section>

        <section className="grid gap-4 md:grid-cols-2">
          <div className="glass-panel">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-neutral-200"><OmniIcon name="search" size={16} /> Search public rooms</div>
            <input type="text" placeholder="Search by name or @username..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="omni-input" aria-label="Search public rooms" />
          </div>
          <div className="glass-panel">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-neutral-200"><OmniIcon name="lock" size={16} /> Have a secret link or code?</div>
            <form onSubmit={(e) => { e.preventDefault(); void handleJoin(roomCode, true); }} className="flex gap-2">
              <input type="text" placeholder="Paste link, username, or UUID..." value={roomCode} onChange={(e) => setRoomCode(e.target.value)} className="omni-input" aria-label="Room invite link or code" />
              <button type="submit" disabled={!roomCode.trim() || processingId === roomCode} className="omni-button omni-button-primary shrink-0">{processingId === roomCode ? '...' : 'Join'}</button>
            </form>
            {codeStatus && <p className={codeStatus.type === 'success' ? 'form-success mt-3' : 'form-error mt-3'}>{codeStatus.msg}</p>}
          </div>
        </section>

        <section className="mt-10">
          <div className="mb-4 flex items-center justify-between"><p className="section-kicker !mb-0">Rooms open to everyone</p><span className="text-xs text-neutral-500">{filteredRooms.length} found</span></div>
          {loading ? <div className="glass-panel text-sm text-neutral-500">Loading public spaces...</div> : filteredRooms.length === 0 ? <div className="glass-panel border-dashed text-center text-sm text-neutral-500">No public rooms found.</div> : <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{filteredRooms.map((room) => {
            const memberCount = room.room_members[0]?.count || 0;
            return <article key={room.id} className="glass-card flex flex-col gap-5">
              <div><div className="mb-4 flex items-center justify-between"><span className="room-chip text-cyan-200">PUBLIC</span><span className="flex items-center gap-2 text-xs text-neutral-500"><OmniIcon name="users" size={14} /> {memberCount} joined</span></div><h3 className="truncate text-lg font-semibold text-neutral-100">{room.name}</h3>{room.username && <p className="mt-1 text-xs text-cyan-200">@{room.username}</p>}</div>
              <button onClick={() => void handleJoin(room.id)} disabled={processingId === room.id} className="omni-button omni-button-ghost mt-auto w-full">{processingId === room.id ? 'Joining...' : 'Join room'} <OmniIcon name="arrow" size={14} /></button>
            </article>;
          })}</div>}
        </section>
      </main>
      <FloatingDock />
    </div>
  );
}
