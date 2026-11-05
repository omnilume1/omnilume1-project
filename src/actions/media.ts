'use server';

import { createClient } from '@/utils/supabase/server';
import { assertActiveRoom, roomExpirySeconds } from '@/lib/room-lifecycle';
import { isUuid } from '@/lib/message-limits';
import {
  ROOM_ATTACHMENT_BUCKET,
  isLegacyRoomObjectPath,
  hasValidRoomFileMimeExtension,
  isRoomMediaMimeType,
  isRoomObjectPath,
  isRoomSubtitleMimeType,
} from '@/lib/room-file-contract';
import { getServerStorageProvider } from '@/lib/storage/server-provider';
import { createAdminClient } from '@/utils/supabase/admin';
import { cleanText, extractMediaMetadata, metadataFromFileName } from '@/lib/media-metadata';

type MediaType = 'audio' | 'video' | 'url';

// Action 10: read the stored file's own tags (provider-neutral byte-range
// reads), then cache the result on the media row through a service-role-only
// RPC (clients cannot write temporary_media); the database re-checks the
// shape (temporary_media_metadata_shape_check).
async function cacheMediaMetadata(mediaId: string, roomId: string, objectPath: string, fileName: string, mimeType: string, size: number) {
  const read = await getServerStorageProvider().openRangeReader(ROOM_ATTACHMENT_BUCKET, objectPath);
  const extracted = await extractMediaMetadata({ read, size, mimeType, fileName });
  const metadata: Record<string, unknown> = { source: extracted.source, extracted_at: new Date().toISOString() };
  if (extracted.title) metadata.title = extracted.title;
  if (extracted.artist) metadata.artist = extracted.artist;
  if (extracted.album) metadata.album = extracted.album;
  if (extracted.year) metadata.year = extracted.year;
  if (extracted.durationSeconds) metadata.duration_seconds = extracted.durationSeconds;
  if (extracted.artwork) metadata.artwork = { mime_type: extracted.artwork.mimeType, data: Buffer.from(extracted.artwork.bytes).toString('base64') };
  const { error } = await createAdminClient().rpc('cache_temporary_media_metadata', { p_media_id: mediaId, p_room_id: roomId, p_metadata: metadata });
  if (error) throw new Error(error.message);
}

export type RoomMediaDetails = {
  id: string;
  mediaType: 'audio' | 'video' | 'url';
  title: string;
  artist: string | null;
  album: string | null;
  year: string | null;
  durationSeconds: number | null;
  // Where the details came from, shown as attribution.
  source: 'tags' | 'filename' | 'link';
  artworkDataUrl: string | null;
};

function detailsFromRow(row: { id: string; media_type: string; file_name: string; metadata: unknown }): RoomMediaDetails {
  const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : {};
  const mediaType = row.media_type === 'audio' || row.media_type === 'video' ? row.media_type : 'url';
  const fallback = metadataFromFileName(row.file_name);
  const artwork = metadata.artwork && typeof metadata.artwork === 'object' ? metadata.artwork as Record<string, unknown> : null;
  const artworkMime = artwork && (artwork.mime_type === 'image/jpeg' || artwork.mime_type === 'image/png') ? artwork.mime_type : null;
  const artworkData = artwork && typeof artwork.data === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(artwork.data) ? artwork.data : null;
  const duration = typeof metadata.duration_seconds === 'number' && Number.isFinite(metadata.duration_seconds) ? metadata.duration_seconds : null;
  return {
    id: row.id,
    mediaType,
    title: cleanText(metadata.title) ?? (mediaType === 'url' ? cleanText(row.file_name) : fallback.title) ?? 'Untitled media',
    artist: cleanText(metadata.artist) ?? (mediaType === 'url' ? null : fallback.artist),
    album: cleanText(metadata.album),
    year: typeof metadata.year === 'string' && /^[12][0-9]{3}$/.test(metadata.year) ? metadata.year : null,
    durationSeconds: duration,
    source: mediaType === 'url' ? 'link' : metadata.source === 'tags' ? 'tags' : 'filename',
    artworkDataUrl: artworkMime && artworkData ? `data:${artworkMime};base64,${artworkData}` : null,
  };
}

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
    await assertActiveRoom(supabase, roomId);
    await assertCanCast(supabase, roomId, user.id);

    // The stored object's own metadata, not the client's claim, is what gets
    // registered: path shape, MIME allow-list, FLAC extension pairing, size.
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

    // Direct temporary_media writes were revoked in 20260923140000. The RPC
    // re-checks watch_control, validates the <room>/media/<uuid>.<ext> path,
    // MIME type and size, and derives the expiry from the room lifecycle.
    const { data, error } = await supabase.rpc('register_temporary_media', {
      p_room_id: roomId,
      p_file_name: fileName.trim().slice(0, 512),
      p_file_path: filePath,
      p_media_type: mediaType,
      p_mime_type: verifiedMimeType,
      p_file_size: verifiedFileSize,
    });

    if (error) throw new Error(error.message);
    const row = (Array.isArray(data) ? data[0] : data) as { id?: unknown } | null;
    if (!row || typeof row.id !== 'string') throw new Error('Media was not registered.');
    if (mediaType !== 'url' && verifiedMimeType && verifiedFileSize) {
      // Never blocks the cast: on any failure the stage falls back to the
      // file name and generated artwork.
      await cacheMediaMetadata(row.id, roomId, filePath, fileName, verifiedMimeType, verifiedFileSize).catch(() => undefined);
    }
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
  if (!isRoomObjectPath(roomId, objectPath) && !isLegacyRoomObjectPath(roomId, objectPath)) {
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
    if (!isRoomObjectPath(roomId, subtitlePath, 'subtitle')) throw new Error('Invalid subtitle path.');

    const { supabase, user } = await getAuthenticatedUser();
    const room = await assertActiveRoom(supabase, roomId);
    await assertCanCast(supabase, roomId, user.id);
    const metadata = await getServerStorageProvider().getMetadata(ROOM_ATTACHMENT_BUCKET, subtitlePath);
    if (!metadata || !isRoomSubtitleMimeType(metadata.mimeType ?? '')) {
      throw new Error('Uploaded subtitle could not be verified.');
    }

    const { error } = await supabase.rpc('set_temporary_media_subtitle', { p_media_id: mediaId, p_subtitle_path: subtitlePath });
    if (error) throw new Error(error.message);
    return { success: true, subtitleUrl: await signRoomObject(supabase, room, roomId, subtitlePath) };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : 'Unable to attach subtitles.' };
  }
}

// The details behind the stage's now-playing card. Only members who can
// watch this room right now receive them; nothing travels over Broadcast.
export async function getRoomMediaDetails(roomId: string, mediaId: string): Promise<{ success: true; details: RoomMediaDetails } | { success: false; error: string }> {
  try {
    if (!isUuid(roomId) || !isUuid(mediaId)) throw new Error('Invalid media reference.');
    const { supabase, user } = await getAuthenticatedUser();
    await assertActiveRoom(supabase, roomId);
    await assertCapability(supabase, roomId, user.id, 'watch');
    const { data, error } = await supabase
      .from('temporary_media')
      .select('id, media_type, file_name, metadata')
      .eq('id', mediaId)
      .eq('room_id', roomId)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error('This media is no longer available.');
    return { success: true, details: detailsFromRow(data) };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : 'Unable to load media details.' };
  }
}

export async function getActiveTemporaryMedia(roomId: string) {
  try {
    if (!roomId) throw new Error('Room is required.');

    const { supabase, user } = await getAuthenticatedUser();
    await assertActiveRoom(supabase, roomId);
    await assertCapability(supabase, roomId, user.id, 'watch');

    // Cached text details only; artwork is fetched per item on the stage.
    const { data, error } = await supabase
      .from('temporary_media')
      .select('id, room_id, file_name, file_url, media_type, mime_type, file_size, storage_path, subtitle_path, expires_at, created_at, title:metadata->>title, artist:metadata->>artist, metadata_source:metadata->>source')
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
    if (!isRoomObjectPath(roomId, filePath) && !isLegacyRoomObjectPath(roomId, filePath)) {
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

// Used after a cancelled upload or a rejected metadata registration. The
// explicit capability and structured path prevent a client from deleting an
// arbitrary object through this server-side cleanup path.
export async function cleanupUnregisteredTemporaryMedia(roomId: string, objectPath: string, kind: 'media' | 'subtitle') {
  try {
    const { supabase, user } = await getAuthenticatedUser();
    await assertCanCast(supabase, roomId, user.id);
    if (!isRoomObjectPath(roomId, objectPath, kind)) throw new Error('Invalid temporary-media path.');
    // The service-role delete below must never remove media that was
    // registered (by this or another member). The path passed the strict
    // UUID contract above, so it is safe inside the filter expression.
    const { data: registered, error: lookupError } = await supabase
      .from('temporary_media')
      .select('id')
      .eq('room_id', roomId)
      .or(`storage_path.eq.${objectPath},subtitle_path.eq.${objectPath},file_url.eq.${objectPath}`)
      .limit(1);
    if (lookupError) throw new Error(lookupError.message);
    if (registered && registered.length > 0) throw new Error('Registered media cannot be cleaned up here.');
    await getServerStorageProvider().cleanup(ROOM_ATTACHMENT_BUCKET, [objectPath]);
    return { success: true };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : 'Unable to clean up temporary media.' };
  }
}

