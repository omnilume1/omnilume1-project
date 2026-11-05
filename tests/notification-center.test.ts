import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  ALWAYS_DELIVERED_TYPES,
  activeDoNotDisturb,
  adjustUnread,
  bellAccessibleLabel,
  itemStaggerDelay,
  markItemsRead,
  mergeNotifications,
  nextFocusIndex,
  notificationHref,
  notificationPresentation,
  popoverMotion,
  relativeTime,
  unreadBadgeText,
  type NotificationItem,
} from '../src/lib/notification-center-model.js';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
const item = (id: string, createdAt: string, extra: Partial<NotificationItem> = {}): NotificationItem => ({
  id, room_id: 'room-1', notification_type: 'mention', message: `m ${id}`, metadata: { room_name: 'Room' },
  actor_id: null, entity_id: null, created_at: createdAt, read_at: null, ...extra,
});

test('badge and accessible label', () => {
  assert.equal(unreadBadgeText(0), '');
  assert.equal(unreadBadgeText(3), '3');
  assert.equal(unreadBadgeText(10), '9+');
  assert.equal(bellAccessibleLabel(0), 'Notifications');
  assert.equal(bellAccessibleLabel(4), 'Notifications, 4 unread');
});

test('every notification type has an icon, a label and a destination', () => {
  for (const type of ['mention', 'reply', 'announcement', 'pdf_shared', 'timer', 'recovery_request', 'recovery_decision', 'access', 'security', 'permanent_conversion', 'room_deletion']) {
    const presentation = notificationPresentation(type);
    assert.notEqual(presentation.icon, 'bell', `${type} needs its own icon`);
    assert.ok(presentation.label.length > 0);
  }
  assert.equal(notificationPresentation('unknown').icon, 'bell');
  assert.equal(notificationHref({ notification_type: 'recovery_request', room_id: 'r', entity_id: null, metadata: null }), '/admin/recovery');
  assert.equal(notificationHref({ notification_type: 'mention', room_id: 'r1', entity_id: null, metadata: { message_id: 'm9' } }), '/room/r1#message-m9');
  assert.equal(notificationHref({ notification_type: 'pdf_shared', room_id: 'r1', entity_id: null, metadata: null }), '/room/r1');
});

test('merging keeps newest first, unique ids, applies updates and caps the list', () => {
  const merged = mergeNotifications([item('a', '2026-11-05T10:00:00Z'), item('b', '2026-11-05T09:00:00Z')], [item('c', '2026-11-05T11:00:00Z'), item('b', '2026-11-05T09:00:00Z', { read_at: '2026-11-05T12:00:00Z' })]);
  assert.deepEqual(merged.map((entry) => entry.id), ['c', 'a', 'b']);
  assert.equal(merged[2].read_at, '2026-11-05T12:00:00Z');
  const many = Array.from({ length: 60 }, (_, index) => item(`n${index}`, new Date(Date.UTC(2026, 10, 5, 0, index)).toISOString()));
  assert.equal(mergeNotifications([], many).length, 50);
});

test('read state math never goes negative and only touches the selection', () => {
  const items = [item('a', '2026-11-05T10:00:00Z'), item('b', '2026-11-05T09:00:00Z')];
  assert.deepEqual(markItemsRead(items, ['a'], 'T').map((entry) => entry.read_at), ['T', null]);
  assert.deepEqual(markItemsRead(items, null, 'T').map((entry) => entry.read_at), ['T', 'T']);
  assert.equal(adjustUnread(1, -5), 0);
  assert.equal(adjustUnread(2, 1), 3);
});

test('arrow-key navigation wraps; Home/End jump', () => {
  assert.equal(nextFocusIndex(-1, 3, 'ArrowDown'), 0);
  assert.equal(nextFocusIndex(2, 3, 'ArrowDown'), 0);
  assert.equal(nextFocusIndex(0, 3, 'ArrowUp'), 2);
  assert.equal(nextFocusIndex(-1, 3, 'ArrowUp'), 2);
  assert.equal(nextFocusIndex(1, 3, 'Home'), 0);
  assert.equal(nextFocusIndex(1, 3, 'End'), 2);
  assert.equal(nextFocusIndex(0, 0, 'ArrowDown'), -1);
});

test('motion: spring-like enter, quicker exit, short stagger; reduced motion fades only', () => {
  assert.deepEqual(popoverMotion(false), { enterMs: 180, exitMs: 120, scaleFrom: 0.96, offsetPx: 8, staggerMs: 24 });
  assert.deepEqual(popoverMotion(true), { enterMs: 120, exitMs: 120, scaleFrom: 1, offsetPx: 0, staggerMs: 0 });
  assert.equal(itemStaggerDelay(3, false), 72);
  assert.equal(itemStaggerDelay(30, false), 192);
  assert.equal(itemStaggerDelay(3, true), 0);
  const css = read('src/app/globals.css');
  assert.match(css, /\.notification-popover \{[^}]*transform-origin: top right;[^}]*opacity: 0; transform: translateY\(-8px\) scale\(0\.96\);/);
  assert.match(css, /\.notification-popover\[data-state="open"\] \{ opacity: 1; transform: translateY\(0\) scale\(1\); transition: opacity 180ms/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n  \.notification-popover, \.notification-popover\[data-state="open"\] \{ transform: none !important; transition: opacity 120ms linear !important; \}/);
  assert.match(css, /border-radius: 16px;/);
});

test('do-not-disturb state and the server-side guarantees', () => {
  const now = Date.parse('2026-11-05T10:00:00Z');
  assert.equal(activeDoNotDisturb([], now), null);
  assert.ok(activeDoNotDisturb([{ room_id: null, muted_until: null, updated_at: '' }], now));
  assert.equal(activeDoNotDisturb([{ room_id: null, muted_until: '2026-11-05T09:00:00Z', updated_at: '' }], now), null);
  assert.equal(activeDoNotDisturb([{ room_id: 'r1', muted_until: null, updated_at: '' }], now), null);
  assert.ok(['access', 'security', 'recovery_request', 'recovery_decision', 'room_deletion'].every((type) => ALWAYS_DELIVERED_TYPES.has(type)));

  const sql = read('supabase/migrations/20261105160000_action08_notification_preferences_and_delivery.sql');
  assert.match(sql, /IF p_type NOT IN \('recovery_request', 'recovery_decision', 'access', 'security', 'room_deletion'\)\n     AND public\.notifications_suppressed\(p_recipient_id, p_room_id\) THEN/);
  assert.match(sql, /REVOKE UPDATE ON public\.room_notifications FROM PUBLIC, anon, authenticated;\nGRANT UPDATE \(read_at\) ON public\.room_notifications TO authenticated;/);
  assert.match(sql, /ALTER PUBLICATION supabase_realtime ADD TABLE public\.room_notifications;/);
  assert.match(sql, /IF p_room_id IS NOT NULL AND public\.room_user_role\(p_room_id, auth\.uid\(\)\) IS NULL THEN/);
  assert.match(sql, /ALTER TABLE public\.notification_preferences ENABLE ROW LEVEL SECURITY;/);
  assert.match(sql, /USING \(user_id = auth\.uid\(\)\);/);
});

test('the bell is an anchored, accessible popover on the shared realtime channel', () => {
  const bell = read('src/components/ui/NotificationBell.tsx');
  for (const marker of ['aria-haspopup="dialog"', 'aria-expanded={isOpen}', 'aria-controls=', "event.key === 'Escape'", "document.addEventListener('pointerdown'", 'buttonRef.current?.focus()', 'nextFocusIndex(', 'Mark all read', 'You are all caught up.', 'Retry', 'role="switch"']) {
    assert.ok(bell.includes(marker), `missing ${marker}`);
  }
  const hook = read('src/hooks/usePersonalMessageNotifications.ts');
  assert.match(hook, /table: 'room_notifications', filter: `recipient_id=eq\.\$\{state\.userId\}`/);
  assert.equal((hook.match(/\.channel\(/g) ?? []).length, 1, 'still exactly one per-user channel');
  // This project allows only private channels; the per-user topic is
  // authorized for its own user only and nobody may publish to it.
  assert.match(hook, /\.channel\(`personal_message_notifications_\$\{state\.userId\}`, \{ config: \{ private: true \} \}\)/);
  const channelPolicy = read('supabase/migrations/20261105170000_action08_private_personal_notification_channel.sql');
  assert.match(channelPolicy, /FOR SELECT\nTO authenticated\nUSING \(/);
  assert.match(channelPolicy, /\(SELECT realtime\.topic\(\)\) = 'personal_message_notifications_' \|\| \(SELECT auth\.uid\(\)\)::text/);
  assert.doesNotMatch(channelPolicy, /FOR (INSERT|ALL)/);
  assert.equal(relativeTime('2026-11-05T09:59:50Z', Date.parse('2026-11-05T10:00:00Z')), 'just now');
  assert.equal(relativeTime('2026-11-05T09:00:00Z', Date.parse('2026-11-05T10:00:00Z')), '1h ago');
});

test('walkthrough regressions: the bell is not queued behind server actions and floats above the room', () => {
  const hook = read('src/hooks/useNotificationCenter.ts');
  assert.match(hook, /from '@\/lib\/notification-center-data';/);
  const data = read('src/lib/notification-center-data.ts');
  assert.doesNotMatch(data, /'use server'/);
  assert.match(data, /rpc\('mark_room_notifications_read', \{ p_ids: ids \}\)/);
  assert.match(data, /rpc\('set_notification_preference'/);
  const css = read('src/app/globals.css');
  assert.match(css, /\.room-header \{ position: relative; z-index: 60;/, 'header popovers paint above the workspace (modals use z-70+)');
});
