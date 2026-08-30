'use server';

import { createClient } from '@/utils/supabase/server';

export async function logTemporaryMedia(roomId: string, fileName: string, fileUrl: string, mediaType: string) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) throw new Error("Unauthorized");

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { error } = await supabase.from('temporary_media').insert({ room_id: roomId, user_id: user.id, file_name: fileName, file_url: fileUrl, media_type: mediaType, expires_at: expiresAt });

    if (error) throw new Error(error.message);
    return { success: true };
  } catch (error: any) { return { success: false, error: error.message }; }
}

export async function getActiveTemporaryMedia(roomId: string) {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.from('temporary_media').select('*').eq('room_id', roomId).gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false });
    if (error) throw error;
    return { success: true, media: data };
  } catch (error: any) { return { success: false, error: error.message }; }
}