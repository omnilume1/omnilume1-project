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
  const { data: member, error } = await supabase
    .from('room_members')
    .select('role, join_status')
    .eq('room_id', roomId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!member || member.join_status !== 'approved' || !['owner', 'admin'].includes(member.role)) {
    throw new Error('Only an approved room owner or admin can cast media.');
  }
}

export async function logTemporaryMedia(
  roomId: string,
  fileName: string,
  filePath: string,
  mediaType: MediaType,
) {
  try {
    if (!roomId || !fileName.trim() || !filePath) {
      throw new Error('Invalid media details.');
    }
    if (!['audio', 'video', 'url'].includes(mediaType)) throw new Error('Invalid media type.');

    const { supabase, user } = await getAuthenticatedUser();
    const room = await assertActiveRoom(supabase, roomId);
    await assertCanCast(supabase, roomId, user.id);

    const mediaLifetimeSeconds = Math.min(
      24 * 60 * 60,
      roomExpirySeconds(room) ?? 24 * 60 * 60,
    );
    if (mediaLifetimeSeconds <= 0) throw new Error('This room has expired and is no longer active.');
    const expiresAt = new Date(Date.now() + mediaLifetimeSeconds * 1000).toISOString();
    // Store the file path instead of public URL for private storage compatibility
    const { error } = await supabase.from('temporary_media').insert({
      room_id: roomId,
      user_id: user.id,
      file_name: fileName.trim().slice(0, 512),
      file_url: filePath, // Now stores file path, not URL
      media_type: mediaType,
      expires_at: expiresAt,
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
    const { data: member, error: memberError } = await supabase
      .from('room_members')
      .select('join_status')
      .eq('room_id', roomId)
      .eq('user_id', user.id)
      .maybeSingle();
    if (memberError) throw new Error(memberError.message);
    if (!member || member.join_status !== 'approved') throw new Error('You are not an approved room member.');

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

    const { supabase, user } = await getAuthenticatedUser();
    const room = await assertActiveRoom(supabase, roomId);

    // Verify user is an approved room member
    const { data: member, error: memberError } = await supabase
      .from('room_members')
      .select('join_status')
      .eq('room_id', roomId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (memberError) throw new Error(memberError.message);
    if (!member || member.join_status !== 'approved') {
      throw new Error('You are not an approved room member.');
    }

    // Verify the file path belongs to this room
    if (!filePath.startsWith(`${roomId}/`)) {
      throw new Error('Invalid file path.');
    }

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
