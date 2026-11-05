// Action 13 pure logic: activity wording, smart organization, discovery
// query building and trust labels. No imports, so unit tests and the probe
// can load it directly.

// --- Activity / room history ----------------------------------------------
export const ACTIVITY_KINDS = [
  'member_joined', 'member_left', 'role_changed', 'announcement', 'file_shared', 'poll_created',
  'event_scheduled', 'task_created', 'task_done', 'note_created', 'queue_added', 'clip_saved', 'group_converted',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export type ActivityRow = {
  id: number;
  kind: ActivityKind;
  actor_id: string | null;
  actor_name: string;
  entity_id: string | null;
  detail: string | null;
  label: string | null;
  created_at: string;
};

const quoted = (label: string | null) => (label ? ` “${label}”` : '');

export function describeActivity(row: Pick<ActivityRow, 'kind' | 'actor_name' | 'detail' | 'label'>): string {
  const who = row.actor_name || 'A member';
  switch (row.kind) {
    case 'member_joined': return `${who} joined the room`;
    case 'member_left': return `${who} left the room`;
    case 'role_changed': return `${who} changed a member’s role${row.detail ? ` to ${row.detail}` : ''}`;
    case 'announcement': return `${who} posted an announcement${quoted(row.label)}`;
    case 'file_shared': return row.label ? `${who} shared ${row.label}` : `${who} shared a file`;
    case 'poll_created': return `${who} started a poll${quoted(row.label)}`;
    case 'event_scheduled': return `${who} scheduled${row.label ? quoted(row.label) : ' an event'}`;
    case 'task_created': return `${who} added a task${quoted(row.label)}`;
    case 'task_done': return `${who} finished a task${quoted(row.label)}`;
    case 'note_created': return `${who} created a note${quoted(row.label)}`;
    case 'queue_added': return `${who} queued${row.label ? quoted(row.label) : ' media'}`;
    case 'clip_saved': return `${who} saved a clip${quoted(row.label)}`;
    case 'group_converted': return `${row.label ? quoted(row.label).trim() : 'This room'} was converted into a group`;
    default: return 'Room activity';
  }
}

// Newest first, no duplicates by id (a live insert and a refetch can overlap).
export function mergeActivity(current: ActivityRow[], incoming: ActivityRow[]): ActivityRow[] {
  const byId = new Map<number, ActivityRow>();
  for (const row of [...current, ...incoming]) byId.set(row.id, row);
  return [...byId.values()].sort((left, right) => (right.created_at.localeCompare(left.created_at)) || right.id - left.id);
}

export function dayLabel(iso: string, now: Date = new Date()): string {
  const day = new Date(iso);
  const startOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(day)) / 86_400_000);
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function groupActivityByDay(rows: ActivityRow[], now: Date = new Date()): Array<{ label: string; items: ActivityRow[] }> {
  const groups: Array<{ label: string; items: ActivityRow[] }> = [];
  for (const row of rows) {
    const label = dayLabel(row.created_at, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(row);
    else groups.push({ label, items: [row] });
  }
  return groups;
}

// --- Room Pulse --------------------------------------------------------------
export type RoomPulse = {
  members: number;
  chat_15m: number | null;
  activity_1h: number;
  next_event: { id: string; title: string; starts_at: string } | null;
  open_tasks_mine: number | null;
};

export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  const unit = abs < 90 ? `${abs}s` : abs < 5_400 ? `${Math.round(abs / 60)}m` : abs < 129_600 ? `${Math.round(abs / 3_600)}h` : `${Math.round(abs / 86_400)}d`;
  return seconds >= 0 ? `in ${unit}` : `${unit} ago`;
}

export function pulseChips(pulse: RoomPulse | null, online: number, now: number = Date.now()): string[] {
  const chips = [`${online} online`];
  if (!pulse) return chips;
  if (pulse.chat_15m !== null) chips.push(`${pulse.chat_15m} message${pulse.chat_15m === 1 ? '' : 's'} in 15 min`);
  chips.push(`${pulse.activity_1h} update${pulse.activity_1h === 1 ? '' : 's'} this hour`);
  if (pulse.next_event) chips.push(`Next: ${pulse.next_event.title} ${relativeTime(pulse.next_event.starts_at, now)}`);
  if (pulse.open_tasks_mine) chips.push(`${pulse.open_tasks_mine} task${pulse.open_tasks_mine === 1 ? '' : 's'} for you`);
  return chips;
}

// --- Smart auto-organization -------------------------------------------------
export type OverviewRoom = {
  room_id: string;
  name: string;
  role: string;
  expiration_type: string;
  expires_at: string | null;
  is_group: boolean;
  member_count: number;
  unread_count: number;
  last_activity_at: string | null;
  next_event_at: string | null;
  open_tasks: number;
  bookmarked: boolean;
};

export type RoomBucket = 'expiring' | 'attention' | 'active' | 'saved' | 'quiet';
export const BUCKET_LABELS: Record<RoomBucket, string> = {
  expiring: 'Expiring soon',
  attention: 'Needs your attention',
  active: 'Active today',
  saved: 'Saved',
  quiet: 'Quiet',
};
const BUCKET_ORDER: RoomBucket[] = ['expiring', 'attention', 'active', 'saved', 'quiet'];
const DAY_MS = 86_400_000;
// Temporary rooms are common (default 24 h), so only the last 3 hours count as
// "expiring soon"; otherwise nearly every temporary room would be flagged.
const EXPIRING_MS = 3 * 3_600_000;

export function bucketRoom(room: OverviewRoom, now: number = Date.now()): RoomBucket {
  if (room.expiration_type !== 'permanent' && room.expires_at) {
    const left = new Date(room.expires_at).getTime() - now;
    if (left > 0 && left <= EXPIRING_MS) return 'expiring';
  }
  const eventSoon = room.next_event_at ? new Date(room.next_event_at).getTime() - now <= DAY_MS : false;
  if (room.unread_count > 0 || room.open_tasks > 0 || eventSoon) return 'attention';
  if (room.last_activity_at && now - new Date(room.last_activity_at).getTime() <= DAY_MS) return 'active';
  if (room.bookmarked) return 'saved';
  return 'quiet';
}

export function organizeRooms(rooms: OverviewRoom[], now: number = Date.now()): Array<{ bucket: RoomBucket; label: string; rooms: OverviewRoom[] }> {
  const buckets = new Map<RoomBucket, OverviewRoom[]>();
  for (const room of rooms) {
    const key = bucketRoom(room, now);
    buckets.set(key, [...(buckets.get(key) ?? []), room]);
  }
  return BUCKET_ORDER.filter((key) => buckets.has(key)).map((key) => ({
    bucket: key,
    label: BUCKET_LABELS[key],
    rooms: (buckets.get(key) ?? []).slice().sort((left, right) =>
      (right.unread_count - left.unread_count)
      || (right.last_activity_at ?? '').localeCompare(left.last_activity_at ?? '')
      || left.name.localeCompare(right.name)),
  }));
}

// --- Discovery -----------------------------------------------------------------
export type DiscoverFilters = {
  query: string;
  lifespan: '' | 'permanent' | 'recoverable' | 'irreversible';
  feature: '' | 'chat' | 'watch' | 'files' | 'study' | 'announcements';
  minMembers: number | null;
  sort: 'newest' | 'members' | 'active';
  scope: 'public' | 'mine';
};
export const DEFAULT_DISCOVER_FILTERS: DiscoverFilters = { query: '', lifespan: '', feature: '', minMembers: null, sort: 'newest', scope: 'public' };
export const DISCOVER_PAGE_SIZE = 24;

export function discoverArgs(filters: DiscoverFilters, offset = 0) {
  const minMembers = filters.minMembers !== null && Number.isFinite(filters.minMembers)
    ? Math.min(100_000, Math.max(0, Math.trunc(filters.minMembers))) : null;
  return {
    p_query: filters.query.trim().slice(0, 100) || null,
    p_lifespan: filters.lifespan || null,
    p_min_members: minMembers,
    p_feature: filters.feature || null,
    p_sort: filters.sort,
    p_scope: filters.scope,
    p_limit: DISCOVER_PAGE_SIZE,
    p_offset: Math.max(0, Math.trunc(offset)),
  };
}

export function activeFilterCount(filters: DiscoverFilters): number {
  return (filters.lifespan ? 1 : 0) + (filters.feature ? 1 : 0) + (filters.minMembers ? 1 : 0)
    + (filters.sort !== 'newest' ? 1 : 0) + (filters.scope !== 'public' ? 1 : 0);
}

// --- Trust ------------------------------------------------------------------------
export type TrustLevel = 'new' | 'member' | 'trusted' | 'steward';
export const TRUST_LABELS: Record<TrustLevel, string> = { new: 'New', member: 'Member', trusted: 'Trusted', steward: 'Steward' };
export const TRUST_HINTS: Record<TrustLevel, string> = {
  new: 'Joined recently or has few contributions.',
  member: 'Established member.',
  trusted: 'Active for a week or more with many contributions.',
  steward: 'Room owner or admin.',
};
export function isTrustLevel(value: unknown): value is TrustLevel {
  return value === 'new' || value === 'member' || value === 'trusted' || value === 'steward';
}

// --- Events / RSVP -------------------------------------------------------------------
export type RsvpResponse = 'going' | 'maybe' | 'declined';
export const RSVP_LABELS: Record<RsvpResponse, string> = { going: 'Going', maybe: 'Maybe', declined: "Can't go" };

// --- Export -----------------------------------------------------------------------------
export function exportFileName(roomName: string, isoDate: string): string {
  const slug = roomName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'room';
  return `omnilume-${slug}-${isoDate.slice(0, 10)}.json`;
}
