import type { Metadata } from 'next';
import Link from 'next/link';
import { getMyJoinedRooms } from '@/actions/rooms';
import { findLink } from '@/lib/cast-url';
import { isRoomExpired, type RoomLifecycleRow } from '@/lib/room-lifecycle';

export const metadata: Metadata = { title: 'Share to a room · OmniLume' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
type JoinedRoom = RoomLifecycleRow & { name: string | null };

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? '';

// "Share to OmniLume": the phone share sheet (installed app) and the browser
// extension send a link here; the person picks a room and the room opens with
// the link ready to play or queue (see MediaStage, ?link=). Signed-in only
// (src/lib/auth.ts), and the room still checks Watch control before adding it.
export default async function SharePage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const link = findLink(`${first(params.url)} ${first(params.text)}`);

  if (!link) {
    return (
      <main className="omni-state-screen">
        <div className="omni-state-card glass-card-ambient">
          <h1 className="text-xl font-semibold text-white">Nothing to share</h1>
          <p className="mt-3 text-sm text-neutral-400">Share a YouTube, Twitch or video link to OmniLume to play it in one of your rooms.</p>
          <Link href="/home" className="omni-button omni-button-primary mt-6">Go to Home</Link>
        </div>
      </main>
    );
  }

  const joined = await getMyJoinedRooms();
  const rooms = joined.ok
    ? joined.data
      .map((row) => (Array.isArray(row.rooms) ? row.rooms[0] : row.rooms) as JoinedRoom | undefined)
      .filter((room): room is JoinedRoom => Boolean(room) && !isRoomExpired(room as JoinedRoom))
    : [];

  return (
    <main className="omni-state-screen">
      <div className="omni-state-card glass-card-ambient share-card">
        <h1 className="text-xl font-semibold text-white">Share to a room</h1>
        <p className="share-link" title={link}>{link}</p>
        {!joined.ok ? (
          <p className="mt-4 text-sm text-red-300">Your rooms could not be loaded. Try again.</p>
        ) : rooms.length === 0 ? (
          <>
            <p className="mt-4 text-sm text-neutral-400">You are not in any open rooms yet.</p>
            <Link href="/create-room" className="omni-button omni-button-primary mt-6">Create a room</Link>
          </>
        ) : (
          <>
            <p className="mt-4 text-sm text-neutral-400">Pick the room to play it in.</p>
            <ul className="share-rooms">
              {rooms.map((room) => (
                <li key={room.id}><Link href={`/room/${room.id}?link=${encodeURIComponent(link)}`} className="share-room">{room.name || 'Untitled room'}</Link></li>
              ))}
            </ul>
          </>
        )}
      </div>
    </main>
  );
}
