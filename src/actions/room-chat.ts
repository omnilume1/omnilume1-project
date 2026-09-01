'use server';

import { createClient } from '@/utils/supabase/server';
import { assertActiveRoom } from '@/lib/room-lifecycle';

export async function sendRoomMessage(roomId: string, text: string) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) throw new Error("Unauthorized");
  await assertActiveRoom(supabase, roomId);

  const { error } = await supabase
    .from('room_messages')
    .insert({
      room_id: roomId,
      user_id: user.id,
      text: text
    });

  if (error) throw new Error(error.message);
}
