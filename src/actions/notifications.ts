'use server';

import { createClient } from '@/utils/supabase/server';

export type RoomNotification = {
  id: string;
  room_id: string;
  recipient_id: string;
  notification_type: string;
  message: string;
  metadata: Record<string, unknown>;
  created_at: string;
  read_at: string | null;
};

export async function getRoomNotifications(roomId: string) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return { success: false, error: 'Unauthorized', notifications: [] as RoomNotification[] };

  const { data, error } = await supabase
    .from('room_notifications')
    .select('id, room_id, recipient_id, notification_type, message, metadata, created_at, read_at')
    .eq('room_id', roomId)
    .eq('recipient_id', user.id)
    .order('created_at', { ascending: false })
    .limit(5);

  if (error) return { success: false, error: 'Unable to load room notifications.', notifications: [] as RoomNotification[] };
  return { success: true, notifications: (data ?? []) as RoomNotification[] };
}

export async function markRoomNotificationRead(notificationId: string) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return { success: false, error: 'Unauthorized' };

  const { error } = await supabase
    .from('room_notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', notificationId)
    .eq('recipient_id', user.id);

  return error ? { success: false, error: 'Unable to update notification.' } : { success: true };
}
