'use server';

import { createClient } from '@/utils/supabase/server';

export async function sendRoomMessage(roomId: string, text: string) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) throw new Error("Unauthorized");

  const { error } = await supabase
    .from('room_messages')
    .insert({
      room_id: roomId,
      user_id: user.id,
      text: text
    });

  if (error) throw new Error(error.message);
}