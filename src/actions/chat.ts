'use server';

import { createClient } from '@/utils/supabase/server';

export async function deleteMessageForEveryone(messageId: string, roomId: string) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    
    if (authError || !user) throw new Error("Unauthorized");

    const { error } = await supabase
      .from('messages')
      .update({ 
        is_deleted: true, 
        content: '🚫 This message was deleted',
        file_url: null 
      })
      .eq('id', messageId)
      .eq('sender_id', user.id); // Validates against the sender

    if (error) throw new Error(error.message);
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}