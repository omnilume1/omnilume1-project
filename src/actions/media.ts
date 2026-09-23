'use server';

import { createClient } from '@/utils/supabase/server';
import { assertActiveRoom, roomExpirySeconds } from '@/lib/room-lifecycle';
import {
  ROOM_ATTACHMENT_BUCKET,
  isLegacyRoomObjectPath,
  hasValidRoomFileMimeExtension,
  isRoomMediaMimeType,
  isRoomObjectPath,
  isRoomSubtitleMimeType,
} from '@/lib/room-file-contract';
import { getServerStorageProvider } from '@/lib/storage/server-provider';

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
  mimeType?: string,
  fileSize?: number,
) {
  try {
    if (!roomId || !fileName.trim() || !filePath) {
      throw new Error('Invalid media details.');
    }
    if (!['audio', 'video', 'url'].includes(mediaType)) throw new Error('Invalid media type.');

    const { supabase, user } = await getAuthenticatedUser();
    await assertCanCast(supabase, roomId, user.id);

    let verifiedMimeType: string | null = null;
    let verifiedFileSize: number | null = null;
    if (mediaType !== 'url') {
      if (!isRoomObjectPath(roomId, filePath, 'media')
        || !isRoomMediaMimeType(mimeType ?? '')
        || !hasValidRoomFileMimeExtension(fileName, mimeType ?? '')
        || !hasValidRoomFileMimeExtension(filePath, mimeType ?? '')) {
        throw new Error('Invalid temporary-media upload.');
      }
      const metadata = await getServerStorageProvider().getMetadata(ROOM_ATTACHMENT_BUCKET, filePath);
      if (!metadata || metadata.mimeType !== mimeType || metadata.size !== fileSize) {
        throw new Error('Uploaded media could not be verified.');
      }
      verifiedMimeType = metadata.mimeType;
      verifiedFileSize = metadata.size;
    }

    const { data, error } = await supabase.rpc('register_temporary_media', {
      p_room_id: roomId,
      p_file_name: fileName.trim().slice(0, 512),
      p_file_path: filePath,
      p_media_type: mediaType,
      p_mime_type: verifiedMimeType,
      p_file_size: verifiedFileSize,
    });
    if (error) throw new Error(error.message);
    return { success: true, media: data };
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
  return getSignedRoomAttachmentUrl(filePath, roomId, 'files');
}

export async function associateTemporaryMediaSubtitle(mediaId: string, roomId: string, subtitlePath: string) {
  try {
    const { supabase, user } = await getAuthenticatedUser();
    await assertCanCast(supabase, roomId, user.id);
    if (!isRoomObjectPath(roomId, subtitlePath, 'subtitle')) {
      throw new Error('Invalid subtitle path.');
    }
    const metadata = await getServerStorageProvider().getMetadata(ROOM_ATTACHMENT_BUCKET, subtitlePath);
    if (!metadata || !isRoomSubtitleMimeType(metadata.mimeType ?? '')) {
      throw new Error('Uploaded subtitle could not be verified.');
    }
    const { data, error } = await supabase.rpc('set_temporary_media_subtitle', {
      p_media_id: mediaId,
      p_subtitle_path: subtitlePath,
    });
    if (error) throw new Error(error.message);
    return { success: true, media: data };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : 'Unable to attach subtitle.' };
  }
}

// Used after a cancelled upload or a rejected metadata registration. The
// explicit capability and structured path prevent a client from deleting an
// arbitrary object through this server-side cleanup path.
export async function cleanupUnregisteredTemporaryMedia(roomId: string, objectPath: string, kind: 'media' | 'subtitle') {
  try {
    const { supabase, user } = await getAuthenticatedUser();
    await assertCanCast(supabase, roomId, user.id);
    if (!isRoomObjectPath(roomId, objectPath, kind)) throw new Error('Invalid temporary-media path.');
    await getServerStorageProvider().cleanup(ROOM_ATTACHMENT_BUCKET, [objectPath]);
    return { success: true };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : 'Unable to clean up temporary media.' };
  }
}

// Watch playback is separate from the Files surface: a member may be allowed
// to watch shared media even when file browsing/upload is disabled.
export async function getSignedRoomMediaUrl(filePath: string, roomId: string): Promise<{ success: boolean; url?: string; error?: string }> {
  return getSignedRoomAttachmentUrl(filePath, roomId, 'watch');
}

async function getSignedRoomAttachmentUrl(
  filePath: string,
  roomId: string,
  capability: 'files' | 'watch',
): Promise<{ success: boolean; url?: string; error?: string }> {
  try {
    if (!filePath || !roomId) throw new Error('File path and room ID are required.');

    const { supabase, user } = await getAuthenticatedUser();
    const room = await assertActiveRoom(supabase, roomId);
    await assertCapability(supabase, roomId, user.id, capability);

    // Storage paths are opaque identifiers; a URL, traversal, or other-room
    // path is never treated as an attachment.
    if (!isRoomObjectPath(roomId, filePath) && !isLegacyRoomObjectPath(roomId, filePath)) {
      throw new Error('Invalid file path.');
    }

    // Never let a signed URL outlive the room's server-side expiry.
    const roomLifetimeSeconds = roomExpirySeconds(room);
    const signedUrlLifetime = Math.min(15 * 60, roomLifetimeSeconds ?? 15 * 60);
    if (signedUrlLifetime <= 0) throw new Error('This room has expired and is no longer active.');

    if (capability === 'watch') {
      const { data: activeMedia, error: mediaError } = await supabase
        .from('temporary_media')
        .select('id')
        .eq('room_id', roomId)
        .gt('expires_at', new Date().toISOString())
        .or(`storage_path.eq.${filePath},subtitle_path.eq.${filePath},file_url.eq.${filePath}`)
        .maybeSingle();
      if (mediaError) throw new Error(mediaError.message);
      if (!activeMedia) throw new Error('This temporary media is no longer available.');
    }

    const signedUrl = await getServerStorageProvider().createSignedDownloadUrl(
      ROOM_ATTACHMENT_BUCKET,
      filePath,
      signedUrlLifetime,
    );

    return { success: true, url: signedUrl };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : 'Unable to generate signed URL.' };
  }
}
