'use server';

import { createClient } from '@/utils/supabase/server';
import type { NotificationItem, NotificationPreference } from '@/lib/notification-center-model';

// Notification center (Action 08). Every query runs as the signed-in user:
// RLS limits rows to the recipient; writes are read-state only (column
// privilege) and preferences go through set_notification_preference.
// Errors are returned as values (production masks thrown action errors).

const NOTIFICATION_COLUMNS = 'id, room_id, notification_type, message, metadata, actor_id, entity_id, created_at, read_at';

async function requireUser() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw new Error('Please sign in again.');
  return { supabase, user };
}

const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

export async function getMyNotifications(limit = 30) {
  try {
    const { supabase, user } = await requireUser();
    const take = Math.min(Math.max(Math.trunc(limit) || 30, 1), 100);
    const [list, unread] = await Promise.all([
      supabase.from('room_notifications').select(NOTIFICATION_COLUMNS).eq('recipient_id', user.id).order('created_at', { ascending: false }).limit(take),
      supabase.from('room_notifications').select('id', { count: 'exact', head: true }).eq('recipient_id', user.id).is('read_at', null),
    ]);
    if (list.error) throw new Error('Unable to load notifications.');
    if (unread.error) throw new Error('Unable to count unread notifications.');
    return { success: true as const, items: (list.data ?? []) as NotificationItem[], unreadCount: unread.count ?? 0 };
  } catch (error: unknown) {
    return { success: false as const, error: message(error, 'Unable to load notifications.') };
  }
}

export async function markNotificationsRead(ids: string[] | null) {
  try {
    if (ids !== null && (!Array.isArray(ids) || ids.length > 200 || ids.some((id) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)))) {
      throw new Error('Invalid notification selection.');
    }
    const { supabase } = await requireUser();
    const { data, error } = await supabase.rpc('mark_room_notifications_read', { p_ids: ids });
    if (error) throw new Error('Unable to update notifications.');
    return { success: true as const, marked: Number(data ?? 0) };
  } catch (error: unknown) {
    return { success: false as const, error: message(error, 'Unable to update notifications.') };
  }
}

export async function getMyNotificationPreferences() {
  try {
    const { supabase, user } = await requireUser();
    const { data, error } = await supabase.from('notification_preferences').select('room_id, muted_until, updated_at').eq('user_id', user.id);
    if (error) throw new Error('Unable to load notification settings.');
    return { success: true as const, preferences: (data ?? []) as NotificationPreference[] };
  } catch (error: unknown) {
    return { success: false as const, error: message(error, 'Unable to load notification settings.') };
  }
}

// roomId null = global do-not-disturb. mutedUntil null = until turned off.
export async function setNotificationPreference(roomId: string | null, muted: boolean, mutedUntil: string | null) {
  try {
    if (roomId !== null && !/^[0-9a-f-]{36}$/i.test(roomId)) throw new Error('Invalid room.');
    if (mutedUntil !== null && Number.isNaN(Date.parse(mutedUntil))) throw new Error('Invalid mute end time.');
    const { supabase } = await requireUser();
    const { error } = await supabase.rpc('set_notification_preference', { p_room_id: roomId, p_muted: muted, p_muted_until: mutedUntil });
    if (error) throw new Error(error.code === '42501' ? 'You can mute only rooms you belong to.' : error.message);
    return { success: true as const };
  } catch (error: unknown) {
    return { success: false as const, error: message(error, 'Unable to update notification settings.') };
  }
}
