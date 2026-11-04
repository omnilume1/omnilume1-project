'use server';

import { createClient } from '@/utils/supabase/server';
import { assertActiveRoom, roomExpirySeconds } from '@/lib/room-lifecycle';
import { isUuid } from '@/lib/message-limits';

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
    const { data, error } = await supabase.rpc('register_temporary_media', {
      p_room_id: roomId,
      p_file_name: fileName.trim().slice(0, 512),
      p_file_path: filePath,
      p_media_type: mediaType,
      p_mime_type: mediaType === 'url' ? null : upload?.mimeType ?? null,
      p_file_size: mediaType === 'url' ? null : upload?.sizeBytes ?? null,
    });

    if (error) throw new Error(error.message);
    const row = (Array.isArray(data) ? data[0] : data) as { id?: unknown } | null;
    if (!row || typeof row.id !== 'string') throw new Error('Media was not registered.');
    // Room members learn about a cast only through this id. They resolve the
    // playable URL themselves through resolveRoomMedia, which never travels
    // over Broadcast (see src/lib/room-broadcast-contract.ts).
    return { success: true, mediaId: row.id };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : 'Unable to save media.' };
  }
}

type SignableRoom = Awaited<ReturnType<typeof assertActiveRoom>>;

async function signRoomObject(
  supabase: Awaited<ReturnType<typeof createClient>>,
  room: SignableRoom,
  roomId: string,
  objectPath: string,
) {
  if (!objectPath.startsWith(`${roomId}/`) || objectPath.includes('..') || objectPath.includes('\\')) {
    throw new Error('Invalid file path.');
  }
  // Never let a signed URL outlive the room's server-side expiry.
  const signedUrlLifetime = Math.min(60 * 60, roomExpirySeconds(room) ?? 60 * 60);
  if (signedUrlLifetime <= 0) throw new Error('This room has expired and is no longer active.');
  const { data, error } = await supabase.storage.from('room_attachments').createSignedUrl(objectPath, signedUrlLifetime);
  if (error) throw new Error(error.message);
  if (!data?.signedUrl) throw new Error('Failed to generate signed URL.');
  return data.signedUrl;
}

export type ResolvedRoomMedia = {
  id: string;
  url: string;
  title: string;
  subtitleUrl: string | null;
  sourceType: 'url' | 'upload';
};

// The protected fetch behind every Watch Broadcast: a member who receives a
// mediaId gets the playable URL, title and subtitle only if they can still
// watch this room right now. A removed member's call fails here, even if
// their stale Realtime connection still delivers the id.
export async function resolveRoomMedia(roomId: string, mediaId: string): Promise<{ success: boolean; media?: ResolvedRoomMedia; error?: string }> {
  try {
    if (!isUuid(roomId) || !isUuid(mediaId)) throw new Error('Invalid media reference.');

    const { supabase, user } = await getAuthenticatedUser();
    const room = await assertActiveRoom(supabase, roomId);
    await assertCapability(supabase, roomId, user.id, 'watch');

    const { data: media, error } = await supabase
      .from('temporary_media')
      .select('id, file_name, file_url, media_type, storage_path, subtitle_path')
      .eq('id', mediaId)
      .eq('room_id', roomId)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!media) throw new Error('This media is no longer available.');

    let url: string;
    if (media.media_type === 'url') {
      if (typeof media.file_url !== 'string' || !/^https?:\/\//i.test(media.file_url)) throw new Error('Invalid cast URL.');
      url = media.file_url;
    } else {
      url = await signRoomObject(supabase, room, roomId, media.storage_path ?? media.file_url);
    }
    const subtitleUrl = media.subtitle_path ? await signRoomObject(supabase, room, roomId, media.subtitle_path) : null;

    return {
      success: true,
      media: {
        id: media.id,
        url,
        title: media.file_name,
        subtitleUrl,
        sourceType: media.media_type === 'url' ? 'url' : 'upload',
      },
    };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : 'Unable to load media.' };
  }
}

// Binds an uploaded <room>/subtitles/<uuid>.(vtt|srt) object to its media row
// so other members resolve it through resolveRoomMedia rather than receiving
// a signed URL over Broadcast.
export async function attachRoomMediaSubtitle(roomId: string, mediaId: string, subtitlePath: string): Promise<{ success: boolean; subtitleUrl?: string; error?: string }> {
  try {
    if (!isUuid(roomId) || !isUuid(mediaId)) throw new Error('Invalid media reference.');
    if (!subtitlePath.startsWith(`${roomId}/subtitles/`)) throw new Error('Invalid subtitle path.');

    const { supabase, user } = await getAuthenticatedUser();
    const room = await assertActiveRoom(supabase, roomId);
    await assertCanCast(supabase, roomId, user.id);

    const { error } = await supabase.rpc('set_temporary_media_subtitle', { p_media_id: mediaId, p_subtitle_path: subtitlePath });
    if (error) throw new Error(error.message);
    return { success: true, subtitleUrl: await signRoomObject(supabase, room, roomId, subtitlePath) };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : 'Unable to attach subtitles.' };
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

    return { success: true, url: await signRoomObject(supabase, room, roomId, filePath) };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : 'Unable to generate signed URL.' };
  }
}
