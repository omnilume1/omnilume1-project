'use server';

import { createClient } from '@/utils/supabase/server';
import {
  ROOM_ATTACHMENT_BUCKET,
  assertRoomFileInput,
  hasValidRoomFileMimeExtension,
  isRoomObjectPath,
  normalizeRoomFileName,
} from '@/lib/room-file-contract';
import { getServerStorageProvider } from '@/lib/storage/server-provider';

type RoomFileRow = {
  id: string;
  room_id: string;
  owner_id: string;
  object_path: string;
  original_name: string;
  normalized_name: string;
  mime_type: string;
  size_bytes: number;
  metadata: Record<string, unknown>;
  retention_state: 'active' | 'delete_pending' | 'deleted';
  created_at: string;
  delete_requested_at: string | null;
  last_cleanup_error: string | null;
};

async function authenticatedClient() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw new Error('Unauthorized');
  return { supabase, user };
}

async function assertFilesCapability(
  supabase: Awaited<ReturnType<typeof createClient>>,
  roomId: string,
  userId: string,
) {
  const { data, error } = await supabase.rpc('room_has_capability', {
    p_room_id: roomId,
    p_user_id: userId,
    p_capability: 'files',
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error('You do not have permission to use Files in this room.');
}

export async function listRoomFiles(roomId: string): Promise<RoomFileRow[]> {
  const { supabase } = await authenticatedClient();
  const { data, error } = await supabase.rpc('list_room_files', { p_room_id: roomId });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    ...row,
    size_bytes: Number((row as { size_bytes: number | string }).size_bytes),
  })) as RoomFileRow[];
}

export async function registerRoomFile(input: {
  roomId: string;
  objectPath: string;
  fileName: string;
  mimeType: string;
  size: number;
}) {
  const { supabase, user } = await authenticatedClient();
  await assertFilesCapability(supabase, input.roomId, user.id);
  const fileName = normalizeRoomFileName(input.fileName);
  const checked = assertRoomFileInput({ name: fileName, type: input.mimeType, size: input.size } as File, 'file');
  if (!isRoomObjectPath(input.roomId, input.objectPath, 'file')
    || !hasValidRoomFileMimeExtension(input.objectPath, checked.mimeType)) {
    throw new Error('Invalid room file path.');
  }

  const metadata = await getServerStorageProvider().getMetadata(ROOM_ATTACHMENT_BUCKET, input.objectPath);
  if (!metadata || metadata.size !== checked.size || metadata.mimeType !== checked.mimeType) {
    throw new Error('Uploaded file could not be verified.');
  }

  const { data, error } = await supabase.rpc('register_room_file', {
    p_room_id: input.roomId,
    p_object_path: input.objectPath,
    p_original_name: checked.fileName,
    p_normalized_name: checked.fileName.toLocaleLowerCase(),
    p_mime_type: checked.mimeType,
    p_size_bytes: checked.size,
    p_metadata: {},
  });
  if (error) throw new Error(error.message);
  return data as RoomFileRow;
}

export async function getRoomFileDownloadUrl(fileId: string) {
  const { supabase } = await authenticatedClient();
  const { data: objectPath, error } = await supabase.rpc('get_room_file_download_path', { p_file_id: fileId });
  if (error || !objectPath) throw new Error(error?.message || 'Unable to authorize this room-file download.');
  const url = await getServerStorageProvider().createSignedDownloadUrl(
    ROOM_ATTACHMENT_BUCKET,
    objectPath as string,
    15 * 60,
  );
  return { url };
}

export async function deleteRoomFile(fileId: string) {
  const { supabase } = await authenticatedClient();
  const { data: objectPath, error } = await supabase.rpc('begin_room_file_delete', { p_file_id: fileId });
  if (error) throw new Error(error.message);
  if (!objectPath) return { success: true, alreadyDeleted: true };

  try {
    await getServerStorageProvider().delete(ROOM_ATTACHMENT_BUCKET, objectPath as string);
    const { error: completeError } = await supabase.rpc('complete_room_file_delete', {
      p_file_id: fileId,
      p_error: null,
    });
    if (completeError) throw new Error(completeError.message);
    return { success: true, alreadyDeleted: false };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Storage cleanup failed.';
    try {
      const { error: stateError } = await supabase.rpc('complete_room_file_delete', { p_file_id: fileId, p_error: message });
      if (stateError) throw new Error(stateError.message);
    } catch {
      // The pending database state remains visible to the authorized cleanup job.
    }
    throw new Error(`File deletion is queued for retry: ${message}`);
  }
}

// This cleans an object only after the caller proves the same room-scoped path
// they just uploaded. It handles cancellation and registration failures without
// exposing the service-role credential to the browser.
export async function cleanupUnregisteredRoomFile(roomId: string, objectPath: string) {
  const { supabase, user } = await authenticatedClient();
  await assertFilesCapability(supabase, roomId, user.id);
  if (!isRoomObjectPath(roomId, objectPath, 'file')) {
    throw new Error('Invalid room file path.');
  }
  await getServerStorageProvider().cleanup(ROOM_ATTACHMENT_BUCKET, [objectPath]);
}

export type { RoomFileRow };
