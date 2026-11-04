'use server';

import { createClient } from '@/utils/supabase/server';
import { assertActiveRoom, roomExpirySeconds } from '@/lib/room-lifecycle';

type MediaType = 'audio' | 'video' | 'url';

async function getAuthenticatedUser() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw new Error('Unauthorized');
  return { supabase, user };
}
async function assertCanCast(supabase: Awaited<ReturnType<typeof createClient>>, roomId: string, userId: string) {
  const { data, error } = await supabase.rpc('room_has_capability', {
    p_room_id: roomId,
    p_user_id: userId,
    p_capability: 'watch_control',
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error('You do not have permission to control Watch in this room.');
}

async function assertCapability(
  supabase: Awaited<ReturnType<typeof createClient>>,
  roomId: string,
  userId: string,
  capability: 'watch' | 'files',
) {
  const { data, error } = await supabase.rpc('room_has_capability', {
    p_room_id: roomId,
    p_user_id: userId,
    p_capability: capability,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`You do not have permission to use ${capability === 'watch' ? 'Watch' : 'Files'} in this room.`);
}

export async function logTemporaryMedia(
  roomId: string,
  fileName: string,
  filePath: string,
  mediaType: MediaType,
  upload?: { mimeType: string; sizeBytes: number },
) {
  try {
    if (!roomId || !fileName.trim() || !filePath) {
      throw new Error('Invalid media details.');
    }
    if (!['audio', 'video', 'url'].includes(mediaType)) throw new Error('Invalid media type.');
    if (mediaType !== 'url' && !upload) throw new Error('Uploaded media requires its type and size.');

    const { supabase, user } = await getAuthenticatedUser();
    await assertActiveRoom(supabase, roomId);
    await assertCanCast(supabase, roomId, user.id);

    // Direct temporary_media writes were revoked in 20260923140000. The RPC
    // re-checks watch_control, validates the <room>/media/<uuid>.<ext> path,
    // MIME type and size, and derives the expiry from the room lifecycle.
    const { error } = await supabase.rpc('register_temporary_media', {
      p_room_id: roomId,
      p_file_name: fileName.trim().slice(0, 512),
      p_file_path: filePath,
      p_media_type: mediaType,
      p_mime_type: mediaType === 'url' ? null : upload?.mimeType ?? null,
      p_file_size: mediaType === 'url' ? null : upload?.sizeBytes ?? null,
    });

    if (error) throw new Error(error.message);
    return { success: true };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : 'Unable to save media.' };
  }
}

export async function getActiveTemporaryMedia(roomId: string) {
  try {
    if (!roomId) throw new Error('Room is required.');

    const { supabase, user } = await getAuthenticatedUser();
    await assertActiveRoom(supabase, roomId);
    await assertCapability(supabase, roomId, user.id, 'watch');

    const { data, error } = await supabase
      .from('temporary_media')
      .select('*')
      .eq('room_id', roomId)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });
    if (error) throw error;
    return { success: true, media: data };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : 'Unable to load media.' };
  }
}

// URL casts use the same 24-hour room history as uploaded media. Nothing is
// downloaded or proxied: the room only stores the URL and title for replay.
export async function logCastHistory(roomId: string, title: string, url: string) {
  return logTemporaryMedia(roomId, title, url, 'url');
}

// Generate a signed URL for private storage access
// This is required for Action 2 (RLS lockdown) - storage bucket is private
export async function getSignedStorageUrl(filePath: string, roomId: string): Promise<{ success: boolean; url?: string; error?: string }> {
  try {
    if (!filePath || !roomId) throw new Error('File path and room ID are required.');

    // Verify the file path belongs to this room
    if (!filePath.startsWith(`${roomId}/`) || filePath.includes('..') || filePath.includes('\\')) {
      throw new Error('Invalid file path.');
    }

    const { supabase, user } = await getAuthenticatedUser();
    const room = await assertActiveRoom(supabase, roomId);
    // Mirror the storage SELECT policy: Watch media and subtitles need the
    // watch capability, and shared files need files.
    const pathKind = filePath.slice(roomId.length + 1).split('/')[0];
    await assertCapability(supabase, roomId, user.id, pathKind === 'media' || pathKind === 'subtitles' ? 'watch' : 'files');

    // Never let a signed URL outlive the room's server-side expiry.
    const roomLifetimeSeconds = roomExpirySeconds(room);
    const signedUrlLifetime = Math.min(60 * 60, roomLifetimeSeconds ?? 60 * 60);
    if (signedUrlLifetime <= 0) throw new Error('This room has expired and is no longer active.');

    const { data, error } = await supabase.storage
      .from('room_attachments')
      .createSignedUrl(filePath, signedUrlLifetime);

    if (error) throw new Error(error.message);
    if (!data?.signedUrl) throw new Error('Failed to generate signed URL.');

    return { success: true, url: data.signedUrl };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : 'Unable to generate signed URL.' };
  }
}
