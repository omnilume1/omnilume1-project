'use client';

import { unwrapAction } from '@/lib/action-result';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getMyJoinedRooms, processRoomJoin } from '@/actions/rooms';
import { discoverRooms, type DiscoveredRoom } from '@/lib/management-data';
import { DEFAULT_DISCOVER_FILTERS, DISCOVER_PAGE_SIZE, activeFilterCount, type DiscoverFilters } from '@/lib/room-management-model';
import { useBookmarks } from '@/components/room/BookmarkButton';
import { getMyRoomJoinEligibility, joinRoomWithInvite, previewRoomInvite } from '@/actions/room-controls';
import { roomDeletionPolicy } from '@/lib/room-deletion-policy';
import { getLoginPath } from '@/lib/auth';
import { createClient } from '@/utils/supabase/client';
import FloatingDock from '@/components/ui/FloatingDock';
import InternalTopbar from '@/components/ui/InternalTopbar';
import { OmniIcon } from '@/components/ui/OmniIcon';
import { getMinimizedRoomIds, restoreMinimizedRoom } from '@/lib/minimized-rooms';

type InvitePreview = Awaited<ReturnType<typeof previewRoomInvite>> extends { ok: true; data: infer T } | { ok: false; error: string } ? T : never;
type JoinedRoom = { role: string; rooms: { id: string; name: string; username: string | null } | { id: string; name: string; username: string | null }[] };

function safeJoinMessage(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('Invite is invalid') || message.includes('Invalid invite')) return 'This invite is invalid, expired, revoked, or has reached its usage limit.';
  if (message.includes('Room is unavailable')) return 'This room is unavailable. You may be restricted, the room may be locked, or the invite may no longer be valid.';
  if (message.includes('Room not found')) return 'Room not found. Check the code or link and try again.';
  if (message.includes('expired')) return 'This room has expired and is no longer accepting joins.';
  if (message.includes('Unauthorized')) return 'Please sign in before joining a room.';
  return 'We could not join this room. Please try again.';
}

function eligibilityMessage(state: string) {
  if (state === 'banned') return 'You cannot rejoin this room because you have been banned.';
  if (state === 'blocked') return 'You cannot rejoin this room because you have been blocked.';
  if (state === 'restricted') return 'You cannot join this room while its current restrictions apply.';
  if (state === 'guest_expired') return 'Your temporary guest access has expired. Ask a room controller for a new invite.';
  if (state === 'pending') return 'Your request is still awaiting room approval.';
  if (state === 'rejected') return 'Your previous request was not approved. Ask a room controller for access.';
  if (state === 'unavailable') return 'This room is unavailable or no longer accepting joins.';
  return 'You are not currently eligible to join this room.';
}

export default function ExploreRoomsPage() {
  const [rooms, setRooms] = useState<DiscoveredRoom[]>([]);
  const [joinedRooms, setJoinedRooms] = useState<JoinedRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [filters, setFilters] = useState<DiscoverFilters>(DEFAULT_DISCOVER_FILTERS);
  const [debouncedFilters, setDebouncedFilters] = useState<DiscoverFilters>(DEFAULT_DISCOVER_FILTERS);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const roomBookmarks = useBookmarks('room');
  const [roomCode, setRoomCode] = useState('');
  const [status, setStatus] = useState<{ type: 'error' | 'success'; message: string } | null>(null);
  // An invite shows the room and its deletion policy before joining (§9).
  const [invitePreview, setInvitePreview] = useState<{ token: string; room: InvitePreview } | null>(null);
  const [minimizedRoomIds] = useState<string[]>(() => getMinimizedRoomIds());
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedFilters(filters), 300);
    return () => window.clearTimeout(timer);
  }, [filters]);

  // Search and filters run in discover_rooms, so what a viewer sees is decided
  // by the database (public/unlocked rooms, or only their own for "My rooms").
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      void discoverRooms(debouncedFilters).then((result) => {
        if (!active) return;
        if (!result.ok) { setLoadError(result.error); setLoading(false); return; }
        setLoadError(null);
        setRooms(result.data);
        setHasMore(result.data.length === DISCOVER_PAGE_SIZE);
        setLoading(false);
      });
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [debouncedFilters, reloadToken]);

  useEffect(() => {
    let active = true;
    void getMyJoinedRooms().then(unwrapAction).then((joined) => { if (active) setJoinedRooms((joined ?? []) as JoinedRoom[]); }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  const loadMore = async () => {
    setLoadingMore(true);
    const result = await discoverRooms(debouncedFilters, rooms.length);
    setLoadingMore(false);
    if (!result.ok) { setLoadError(result.error); return; }
    setRooms((current) => [...current, ...result.data.filter((room) => !current.some((existing) => existing.id === room.id))]);
    setHasMore(result.data.length === DISCOVER_PAGE_SIZE);
  };

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const notice = searchParams.get('roomNotice');
    const timer = window.setTimeout(() => {
      if (notice === 'kicked') setStatus({ type: 'error', message: 'You were kicked from this room.' });
      if (notice === 'blocked') setStatus({ type: 'error', message: 'You have been blocked from this room.' });
      if (notice === 'minimized') setStatus({ type: 'success', message: 'Room minimized. You are still a member and can reopen it below.' });
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const minimizedRooms = useMemo(() => {
    const ids = new Set(minimizedRoomIds);
    return joinedRooms.filter((entry) => ids.has(Array.isArray(entry.rooms) ? entry.rooms[0]?.id : entry.rooms?.id));
  }, [joinedRooms, minimizedRoomIds]);

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
      const token = identifier.trim().split('?')[0].split('#')[0].split('/').filter(Boolean).pop() ?? '';
      const isInvite = /^[a-f0-9]{48}$/i.test(token);
      if (isInvite) {
        if (invitePreview?.token !== token) {
          const room = await previewRoomInvite(token).then(unwrapAction);
          setInvitePreview({ token, room });
          return;
        }
        const result = await joinRoomWithInvite(token).then(unwrapAction);
        setInvitePreview(null);
        setStatus({ type: 'success', message: result.role === 'guest' ? 'Temporary guest access granted.' : 'Invite accepted. Opening the room…' });
        router.push(`/room/${result.room_id}`);
        return;
      }
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identifier.trim())) {
        const eligibility = await getMyRoomJoinEligibility(identifier.trim()).then(unwrapAction);
        if (eligibility.state === 'already_joined') {
          router.push(`/room/${identifier.trim()}`);
          return;
        }
        if (!eligibility.can_join) {
          setStatus({ type: 'error', message: eligibilityMessage(eligibility.state) });
          return;
        }
      }
      const result = await processRoomJoin(identifier).then(unwrapAction);
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

  const filteredRooms = rooms;
  const filterCount = activeFilterCount(filters);
  const setFilter = <K extends keyof DiscoverFilters>(key: K, value: DiscoverFilters[K]) => setFilters((current) => ({ ...current, [key]: value }));

  return (
    <div className="omni-internal">
      <InternalTopbar eyebrow="Discover together" title="Explore" description="Find public spaces or use an invite from someone you know." actions={<Link href="/create-room" className="omni-button omni-button-primary"><OmniIcon name="plus" size={15} /> Create room</Link>} />
      <main className="omni-main-content explore-main">
        {minimizedRooms.length > 0 && <section className="glass-card-ambient mb-5 p-5"><p className="section-kicker !mb-0">Your joined rooms</p><p className="mt-2 text-sm text-neutral-500">Rooms you minimized remain joined and can be reopened instantly.</p><div className="mt-4 flex flex-wrap gap-3">{minimizedRooms.map((entry) => { const room = Array.isArray(entry.rooms) ? entry.rooms[0] : entry.rooms; if (!room) return null; return <button key={room.id} type="button" onClick={() => { restoreMinimizedRoom(room.id); router.push(`/room/${room.id}`); }} className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-left hover:bg-white/[0.07]"><span className="block text-sm font-semibold text-white">{room.name}</span><span className="mt-1 block text-xs capitalize text-violet-200">{entry.role} · Reopen room</span></button>; })}</div></section>}
        <section className="explore-intro rise" style={{ ['--i' as string]: 0 }}>
          <div>
            <p className="section-kicker">Public spaces</p>
            <h2 className="section-title">Find your next room</h2>
            <p className="section-copy">Search by room name or username, then join when the space feels right.</p>
          </div>
          <span className="explore-room-count"><OmniIcon name="rooms" size={14} /> {loading ? 'Loading rooms' : `${rooms.length}${hasMore ? '+' : ''} ${filters.scope === 'mine' ? 'of your rooms' : 'public rooms'}`}</span>
        </section>

        <section className="explore-controls rise" style={{ ['--i' as string]: 1 }}>
          <div className="glass explore-search">
            <label htmlFor="room-search" className="sr-only">Search {filters.scope === 'mine' ? 'your rooms' : 'public rooms'}</label>
            <OmniIcon name="search" size={20} />
            <input id="room-search" type="search" placeholder="Search by name, @username or topic..." value={filters.query} maxLength={100} onChange={(event) => setFilter('query', event.target.value)} />
          </div>
          <form onSubmit={(event) => { event.preventDefault(); void handleJoin(roomCode); }} className="glass explore-code-form">
            <label htmlFor="room-code" className="sr-only">Join with a link or code</label>
            <OmniIcon name="lock" size={16} />
            <input id="room-code" type="text" placeholder="Paste an invite code, link, username, or UUID..." value={roomCode} onChange={(event) => setRoomCode(event.target.value)} />
            <button type="submit" disabled={!roomCode.trim() || processingId === roomCode} className="omni-button omni-button-ghost omni-button-sm shrink-0">{processingId === roomCode ? 'Joining...' : 'Join'}</button>
          </form>
        </section>

        <section className="discover-filters rise" style={{ ['--i' as string]: 2 }} aria-label="Room filters">
          <div className="discover-scope" role="group" aria-label="Where to search">
            <button type="button" className="fchip" aria-pressed={filters.scope === 'public'} onClick={() => setFilter('scope', 'public')}>Public rooms</button>
            <button type="button" className="fchip" aria-pressed={filters.scope === 'mine'} onClick={() => setFilter('scope', 'mine')}>My rooms</button>
          </div>
          <span className="discover-sep" aria-hidden="true" />
          <div className="discover-scope" role="group" aria-label="Has feature">
            {([['', 'Any feature', null], ['watch', 'Watch', 'tv'], ['study', 'Study', 'book'], ['chat', 'Chat', 'message'], ['files', 'Files', 'file']] as const).map(([value, label, icon]) => (
              <button key={value || 'any'} type="button" className="fchip" aria-pressed={filters.feature === value} onClick={() => setFilter('feature', value as DiscoverFilters['feature'])}>{icon && <OmniIcon name={icon} size={14} />}{label}</button>
            ))}
          </div>
          <div className="discover-selects">
            <label className="discover-field"><span>Lifespan</span>
              <select className="omni-input" value={filters.lifespan} onChange={(event) => setFilter('lifespan', event.target.value as DiscoverFilters['lifespan'])}>
                <option value="">Any</option><option value="permanent">Permanent</option><option value="recoverable">Temporary (recoverable)</option><option value="irreversible">Temporary (final)</option>
              </select></label>
            <label className="discover-field"><span>Min. members</span>
              <input className="omni-input" type="number" min={0} max={100000} inputMode="numeric" value={filters.minMembers ?? ''} onChange={(event) => setFilter('minMembers', event.target.value === '' ? null : Number(event.target.value))} placeholder="Any" /></label>
            <label className="discover-field"><span>Sort by</span>
              <select className="omni-input" value={filters.sort} onChange={(event) => setFilter('sort', event.target.value as DiscoverFilters['sort'])}>
                <option value="newest">Newest</option><option value="members">Most members</option><option value="active">Recently active</option>
              </select></label>
            {(filterCount > 0 || filters.query) && <button type="button" className="omni-button omni-button-ghost omni-button-sm discover-reset" onClick={() => setFilters(DEFAULT_DISCOVER_FILTERS)}>Clear{filterCount > 0 ? ` (${filterCount})` : ''}</button>}
          </div>
        </section>

        {invitePreview && (() => {
          const policy = roomDeletionPolicy({ expiration_type: invitePreview.room.expiration_type, deletion_scheduled_at: invitePreview.room.deletion_scheduled_at });
          return <section className="glass-card-ambient mb-5 p-5" aria-labelledby="invite-preview-heading">
            <p className="section-kicker !mb-0">Invite</p>
            <h2 id="invite-preview-heading" className="mt-2 text-lg font-semibold text-white">{invitePreview.room.room_name}</h2>
            <p className="mt-1 text-xs text-neutral-400">{invitePreview.room.is_private ? 'Private room' : 'Public room'}{invitePreview.room.guest_lifetime_minutes ? ` · guest access for ${invitePreview.room.guest_lifetime_minutes} minutes` : ''}</p>
            <p className="mt-3"><span className="room-chip text-amber-100">{policy.label}</span></p>
            <p className="mt-2 text-sm text-neutral-400">{policy.description}</p>
            <div className="mt-4 flex flex-wrap gap-3">
              <button type="button" onClick={() => void handleJoin(invitePreview.token)} disabled={processingId === invitePreview.token} className="omni-button omni-button-primary">{processingId === invitePreview.token ? 'Joining...' : 'Join room'}</button>
              <button type="button" onClick={() => setInvitePreview(null)} className="omni-button omni-button-ghost">Cancel</button>
            </div>
          </section>;
        })()}
        {status && <p className={status.type === 'success' ? 'form-success explore-status' : 'form-error explore-status'} role={status.type === 'error' ? 'alert' : 'status'}>{status.message}</p>}

        <section className="explore-list-section">
          <div className="explore-list-heading"><div><p className="section-kicker !mb-0">Rooms open to everyone</p><p className="mt-2 text-sm text-neutral-500">Showing real public rooms currently available to join.</p></div><span className="text-xs text-neutral-500">{filteredRooms.length} found</span></div>
          {loading ? <div className="glass-card-ambient empty-state" aria-busy="true">Loading rooms...</div> : loadError ? <div className="form-error" role="alert">{loadError} <button type="button" className="underline" onClick={() => setReloadToken((value) => value + 1)}>Retry</button></div> : filteredRooms.length === 0 ? <div className="glass-card-ambient empty-state">{filters.scope === 'mine' ? 'None of your rooms match.' : 'No public rooms match your search.'}</div> : <div className="explore-room-grid">{filteredRooms.map((room) => {
            const memberCount = room.member_count;
            const policy = roomDeletionPolicy(room);
            const joinedAlready = room.viewer_role !== null;
            return <article key={room.id} className="glass-card explore-room-card lift glow">
              <div className="explore-room-card-top"><span className="room-chip">{room.is_private ? 'Private' : 'Public'}</span><span className="room-chip" title={policy.description}>{policy.label}<span className="sr-only">: {policy.description}</span></span><span className="explore-room-members"><span className="status-dot" aria-hidden="true" /> {memberCount} joined</span></div>
              <div className="min-w-0"><h3 className="explore-room-name">{room.name}</h3>{room.username && <p className="explore-room-handle">@{room.username}</p>}{room.description && <p className="explore-room-description">{room.description}</p>}</div>
              <div className="explore-room-foot">
                <button type="button" className="icon-button explore-save" aria-pressed={roomBookmarks.saved.has(room.id)} disabled={roomBookmarks.busy === room.id} aria-label={roomBookmarks.saved.has(room.id) ? `Remove ${room.name} from saved` : `Save ${room.name}`} onClick={() => void roomBookmarks.toggle(room.id, room.id)}>{roomBookmarks.saved.has(room.id) ? '★' : '☆'}</button>
                <button onClick={() => joinedAlready ? router.push(`/room/${room.id}`) : void handleJoin(room.id)} disabled={processingId === room.id} className={`omni-button omni-button-sm ${joinedAlready ? 'omni-button-ghost' : 'omni-button-primary'}`}>{processingId === room.id ? 'Joining...' : joinedAlready ? 'Open room' : 'Join room'} <OmniIcon name="arrow" size={14} /></button>
              </div>
            </article>;
          })}</div>}
          {!loading && !loadError && hasMore && <div className="mt-4 text-center"><button type="button" className="omni-button omni-button-ghost" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? 'Loading…' : 'Show more rooms'}</button></div>}
          {roomBookmarks.error && <p role="alert" className="form-error mt-3">{roomBookmarks.error}</p>}
        </section>
      </main>
      <FloatingDock />
    </div>
  );
}
