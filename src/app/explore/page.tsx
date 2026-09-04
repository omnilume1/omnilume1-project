'use client';

import { useEffect, useMemo, useState } from 'react';
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
  description: string | null;
  username: string | null;
  room_members: Array<{ count: number }>;
}

function safeJoinMessage(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('Room not found')) return 'Room not found. Check the code or link and try again.';
  if (message.includes('expired')) return 'This room has expired and is no longer accepting joins.';
  if (message.includes('Unauthorized')) return 'Please sign in before joining a room.';
  return 'We could not join this room. Please try again.';
}

export default function ExploreRoomsPage() {
  const [rooms, setRooms] = useState<PublicRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [status, setStatus] = useState<{ type: 'error' | 'success'; message: string } | null>(null);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    let active = true;

    async function fetchRooms() {
      try {
        const data = await getPublicRooms();
        if (active) setRooms((data ?? []) as PublicRoom[]);
      } catch {
        if (active) setLoadError('Public rooms could not be loaded right now. Please refresh to try again.');
      } finally {
        if (active) setLoading(false);
      }
    }

    void fetchRooms();
    return () => {
      active = false;
    };
  }, []);

  const handleJoin = async (identifier: string) => {
    if (!identifier.trim()) return;
    setStatus(null);

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
        setStatus({ type: 'success', message: 'Request sent. You can keep browsing until the owner approves you.' });
      } else {
        router.push(`/room/${result.roomId}`);
      }
    } catch (error: unknown) {
      const message = safeJoinMessage(error);
      if (message.startsWith('Please sign in')) {
        router.push(getLoginPath('/explore'));
        return;
      }
      setStatus({ type: 'error', message });
    } finally {
      setProcessingId(null);
    }
  };

  const filteredRooms = useMemo(() => rooms.filter((room) => (
    room.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (room.username?.toLowerCase().includes(searchQuery.toLowerCase()) ?? false)
  )), [rooms, searchQuery]);

  return (
    <div className="omni-internal">
      <InternalTopbar eyebrow="Discover together" title="Explore" description="Find public spaces or use an invite from someone you know." actions={<Link href="/create-room" className="omni-button omni-button-primary"><OmniIcon name="plus" size={15} /> Create room</Link>} />
      <main className="omni-main-content explore-main">
        <section className="explore-intro glass-card-ambient fade-up">
          <div>
            <p className="section-kicker">Public spaces</p>
            <h2 className="section-title">Find your next room</h2>
            <p className="section-copy">Search by room name or username, then join when the space feels right.</p>
          </div>
          <span className="explore-room-count"><OmniIcon name="rooms" size={14} /> {loading ? 'Loading rooms' : `${rooms.length} public rooms`}</span>
        </section>

        <section className="explore-controls">
          <div className="glass-card-ambient explore-control-card">
            <label htmlFor="room-search" className="explore-control-label"><OmniIcon name="search" size={16} /> Search public rooms</label>
            <input id="room-search" type="search" placeholder="Search by name or @username..." value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} className="omni-input" />
          </div>
          <div className="glass-card-ambient explore-control-card">
            <label htmlFor="room-code" className="explore-control-label"><OmniIcon name="lock" size={16} /> Join with a link or code</label>
            <form onSubmit={(event) => { event.preventDefault(); void handleJoin(roomCode); }} className="explore-code-form">
              <input id="room-code" type="text" placeholder="Paste a link, username, or UUID..." value={roomCode} onChange={(event) => setRoomCode(event.target.value)} className="omni-input" />
              <button type="submit" disabled={!roomCode.trim() || processingId === roomCode} className="omni-button omni-button-primary shrink-0">{processingId === roomCode ? 'Joining...' : 'Join'}</button>
            </form>
          </div>
        </section>

        {status && <p className={status.type === 'success' ? 'form-success explore-status' : 'form-error explore-status'} role={status.type === 'error' ? 'alert' : 'status'}>{status.message}</p>}

        <section className="explore-list-section">
          <div className="explore-list-heading"><div><p className="section-kicker !mb-0">Rooms open to everyone</p><p className="mt-2 text-sm text-neutral-500">Showing real public rooms currently available to join.</p></div><span className="text-xs text-neutral-500">{filteredRooms.length} found</span></div>
          {loading ? <div className="glass-card-ambient empty-state">Loading public spaces...</div> : loadError ? <div className="form-error">{loadError}</div> : filteredRooms.length === 0 ? <div className="glass-card-ambient empty-state">No public rooms match your search.</div> : <div className="explore-room-grid">{filteredRooms.map((room) => {
            const memberCount = room.room_members[0]?.count ?? 0;
            return <article key={room.id} className="glass-card-ambient explore-room-card">
              <div className="explore-room-card-top"><span className="room-chip text-cyan-200">Public</span><span className="explore-room-members"><OmniIcon name="users" size={14} /> {memberCount} joined</span></div>
              <div className="min-w-0"><h3 className="truncate text-lg font-semibold text-neutral-100">{room.name}</h3>{room.username && <p className="mt-1 text-xs text-cyan-200">@{room.username}</p>}{room.description && <p className="explore-room-description">{room.description}</p>}</div>
              <button onClick={() => void handleJoin(room.id)} disabled={processingId === room.id} className="omni-button omni-button-ghost mt-auto w-full">{processingId === room.id ? 'Joining...' : 'Join room'} <OmniIcon name="arrow" size={14} /></button>
            </article>;
          })}</div>}
        </section>
      </main>
      <FloatingDock />
    </div>
  );
}
