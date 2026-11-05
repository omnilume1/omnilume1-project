// Notification center model (Action 08): pure helpers shared by the bell
// popover and its unit tests. No imports.

export type NotificationType =
  | 'mention'
  | 'reply'
  | 'announcement'
  | 'pdf_shared'
  | 'timer'
  | 'recovery_request'
  | 'recovery_decision'
  | 'access'
  | 'security'
  | 'permanent_conversion'
  | 'room_deletion'
  | 'task'
  | 'room_event'
  | 'group_conversion';

export type NotificationItem = {
  id: string;
  room_id: string;
  notification_type: NotificationType | string;
  message: string;
  metadata: Record<string, unknown> | null;
  actor_id: string | null;
  entity_id: string | null;
  created_at: string;
  read_at: string | null;
};

export type NotificationPreference = {
  room_id: string | null;
  muted_until: string | null;
  updated_at: string;
};

export const NOTIFICATION_LIST_LIMIT = 50;

// Never suppressed by do-not-disturb or room mute (enforced server-side).
export const ALWAYS_DELIVERED_TYPES: ReadonlySet<string> = new Set(['recovery_request', 'recovery_decision', 'access', 'security', 'room_deletion']);

type Presentation = { icon: 'at' | 'reply' | 'megaphone' | 'file' | 'clock' | 'shield' | 'trash' | 'spark' | 'bell'; label: string };

const PRESENTATION: Record<string, Presentation> = {
  mention: { icon: 'at', label: 'Mention' },
  reply: { icon: 'reply', label: 'Reply' },
  announcement: { icon: 'megaphone', label: 'Announcement' },
  pdf_shared: { icon: 'file', label: 'Shared PDF' },
  timer: { icon: 'clock', label: 'Focus timer' },
  recovery_request: { icon: 'shield', label: 'Recovery request' },
  recovery_decision: { icon: 'shield', label: 'Recovery decision' },
  access: { icon: 'shield', label: 'Access' },
  security: { icon: 'shield', label: 'Security' },
  permanent_conversion: { icon: 'spark', label: 'Room update' },
  room_deletion: { icon: 'trash', label: 'Room deletion' },
  task: { icon: 'spark', label: 'Task' },
  room_event: { icon: 'clock', label: 'Room event' },
  group_conversion: { icon: 'spark', label: 'Group' },
};

export function notificationPresentation(type: string): Presentation {
  return PRESENTATION[type] ?? { icon: 'bell', label: 'Notification' };
}

// Where a notification leads. Recovery requests go to the site-owner queue;
// everything else to its room (the room page enforces access).
export function notificationHref(item: Pick<NotificationItem, 'notification_type' | 'room_id' | 'entity_id' | 'metadata'>) {
  if (item.notification_type === 'recovery_request') return '/admin/recovery';
  const messageId = typeof item.metadata?.message_id === 'string' ? item.metadata.message_id : null;
  const base = `/room/${encodeURIComponent(item.room_id)}`;
  return messageId ? `${base}#message-${encodeURIComponent(messageId)}` : base;
}

export function notificationRoomName(item: Pick<NotificationItem, 'metadata'>) {
  const name = item.metadata?.room_name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

export function unreadBadgeText(count: number) {
  if (!Number.isFinite(count) || count <= 0) return '';
  return count > 9 ? '9+' : String(Math.trunc(count));
}

export function bellAccessibleLabel(count: number) {
  return count > 0 ? `Notifications, ${count} unread` : 'Notifications';
}

// Newest first, unique by id, capped. Incoming rows replace stale copies
// (for example a read_at change from another tab).
export function mergeNotifications(current: NotificationItem[], incoming: NotificationItem[], limit = NOTIFICATION_LIST_LIMIT) {
  const byId = new Map<string, NotificationItem>();
  for (const item of current) byId.set(item.id, item);
  for (const item of incoming) byId.set(item.id, { ...byId.get(item.id), ...item });
  return [...byId.values()]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : (a.id < b.id ? 1 : -1)))
    .slice(0, limit);
}

export function markItemsRead(items: NotificationItem[], ids: string[] | null, at: string) {
  const target = ids ? new Set(ids) : null;
  return items.map((item) => (item.read_at || (target && !target.has(item.id)) ? item : { ...item, read_at: at }));
}

// Unread count after a local change, never below zero.
export function adjustUnread(count: number, delta: number) {
  return Math.max(0, Math.trunc(count) + Math.trunc(delta));
}

export type NavigationKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';

// Roving focus across the list; wraps at both ends.
export function nextFocusIndex(current: number, length: number, key: NavigationKey) {
  if (length <= 0) return -1;
  switch (key) {
    case 'Home': return 0;
    case 'End': return length - 1;
    case 'ArrowDown': return current < 0 ? 0 : (current + 1) % length;
    case 'ArrowUp': return current < 0 ? length - 1 : (current - 1 + length) % length;
    default: return current;
  }
}

// Motion spec: spring-like enter (scale .96 → 1, 8px rise from the bell,
// ~180 ms), quicker exit (~120 ms), short stagger; reduced motion = fade only.
export function popoverMotion(reducedMotion: boolean) {
  return reducedMotion
    ? { enterMs: 120, exitMs: 120, scaleFrom: 1, offsetPx: 0, staggerMs: 0 }
    : { enterMs: 180, exitMs: 120, scaleFrom: 0.96, offsetPx: 8, staggerMs: 24 };
}

export function itemStaggerDelay(index: number, reducedMotion: boolean) {
  const { staggerMs } = popoverMotion(reducedMotion);
  return Math.min(Math.max(index, 0), 8) * staggerMs;
}

export function relativeTime(iso: string, now = Date.now()) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 7 ? `${days}d ago` : new Date(then).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Active do-not-disturb (global preference whose end time has not passed).
// A per-room mute is active until its end time (or until turned off).
export function isRoomMuted(preferences: NotificationPreference[], roomId: string, now = Date.now()) {
  const room = preferences.find((preference) => preference.room_id === roomId);
  if (!room) return false;
  return !room.muted_until || Date.parse(room.muted_until) > now;
}

export function activeDoNotDisturb(preferences: NotificationPreference[], now = Date.now()) {
  const global = preferences.find((preference) => preference.room_id === null);
  if (!global) return null;
  if (global.muted_until && Date.parse(global.muted_until) <= now) return null;
  return global;
}
