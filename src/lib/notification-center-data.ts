import { createClient } from '@/utils/supabase/client';
import type { NotificationItem, NotificationPreference } from '@/lib/notification-center-model';

// Notification center data (Action 08), read and written from the browser.
// These are not server actions on purpose: Next.js runs server actions one
// at a time per client, so on the busy room page the bell waited behind
// every room action. Security is unchanged and lives in the database: RLS
// returns only the signed-in recipient's rows, clients may update read_at
// only (column privilege) through mark_room_notifications_read, and
// preferences go through set_notification_preference (membership checked).
// Errors come back as values.

const NOTIFICATION_COLUMNS = 'id, room_id, notification_type, message, metadata, actor_id, entity_id, created_at, read_at';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getMyNotifications(limit = 30) {
  const supabase = createClient();
  const take = Math.min(Math.max(Math.trunc(limit) || 30, 1), 100);
  const [list, unread] = await Promise.all([
    supabase.from('room_notifications').select(NOTIFICATION_COLUMNS).order('created_at', { ascending: false }).limit(take),
    supabase.from('room_notifications').select('id', { count: 'exact', head: true }).is('read_at', null),
  ]);
  if (list.error) return { success: false as const, error: 'Unable to load notifications.' };
  if (unread.error) return { success: false as const, error: 'Unable to count unread notifications.' };
  return { success: true as const, items: (list.data ?? []) as NotificationItem[], unreadCount: unread.count ?? 0 };
}

export async function markNotificationsRead(ids: string[] | null) {
  if (ids !== null && (!Array.isArray(ids) || ids.length > 200 || ids.some((id) => typeof id !== 'string' || !UUID.test(id)))) {
    return { success: false as const, error: 'Invalid notification selection.' };
  }
  const { data, error } = await createClient().rpc('mark_room_notifications_read', { p_ids: ids });
  if (error) return { success: false as const, error: 'Unable to update notifications.' };
  return { success: true as const, marked: Number(data ?? 0) };
}

export async function getMyNotificationPreferences() {
  const { data, error } = await createClient().from('notification_preferences').select('room_id, muted_until, updated_at');
  if (error) return { success: false as const, error: 'Unable to load notification settings.' };
  return { success: true as const, preferences: (data ?? []) as NotificationPreference[] };
}

// roomId null = global do-not-disturb. mutedUntil null = until turned off.
export async function setNotificationPreference(roomId: string | null, muted: boolean, mutedUntil: string | null) {
  if (roomId !== null && !UUID.test(roomId)) return { success: false as const, error: 'Invalid room.' };
  if (mutedUntil !== null && Number.isNaN(Date.parse(mutedUntil))) return { success: false as const, error: 'Invalid mute end time.' };
  const { error } = await createClient().rpc('set_notification_preference', { p_room_id: roomId, p_muted: muted, p_muted_until: mutedUntil });
  if (error) return { success: false as const, error: error.code === '42501' ? 'You can mute only rooms you belong to.' : 'Unable to update notification settings.' };
  return { success: true as const };
}
