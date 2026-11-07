import { NextResponse } from 'next/server';
import { assertActiveRoom } from '@/lib/room-lifecycle';
import {
  ROOM_ATTACHMENT_BUCKET,
  assertRoomFileInput,
  extensionForFileName,
  isRoomObjectPath,
  type RoomFileKind,
} from '@/lib/room-file-contract';
import {
  MUSIC_AUDIO_TYPES,
  MUSIC_BUCKET,
  MUSIC_MAX_COVER_BYTES,
  MUSIC_MAX_FILE_BYTES,
  isUuid,
} from '@/lib/music-upload-validation';
import { getServerStorageProvider } from '@/lib/storage/server-provider';
import { createClient } from '@/utils/supabase/server';

const noStore = { 'Cache-Control': 'private, no-store' };

function failure(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: noStore });
}

async function assertRoomUploadAccess(
  supabase: Awaited<ReturnType<typeof createClient>>,
  roomId: string,
  userId: string,
  capability: 'files' | 'watch_control',
) {
  await assertActiveRoom(supabase, roomId);
  const { data, error } = await supabase.rpc('room_has_capability', {
    p_room_id: roomId,
    p_user_id: userId,
    p_capability: capability,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error('You do not have permission to upload here.');
}

function musicUploadType(path: string) {
  const match = path.match(/^[^/]+\/[^/]+\.([a-z0-9]{2,5})$/i);
  if (!match) return null;
  const extension = match[1].toLowerCase();
  return extension in MUSIC_AUDIO_TYPES ? extension as keyof typeof MUSIC_AUDIO_TYPES : null;
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const { bucket, path, fileName, contentType, size } = body ?? {};
    if (typeof bucket !== 'string' || typeof path !== 'string' || typeof fileName !== 'string'
      || typeof contentType !== 'string' || !Number.isSafeInteger(size) || typeof size !== 'number') {
      return failure('Invalid upload request.', 400);
    }

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return failure('Sign in first.', 401);

    if (bucket === ROOM_ATTACHMENT_BUCKET) {
      const [roomId, prefix] = path.split('/');
      const kind: RoomFileKind | null = prefix === 'files' ? 'file' : prefix === 'media' ? 'media' : prefix === 'subtitles' ? 'subtitle' : null;
      if (!kind || !isUuid(roomId) || !isRoomObjectPath(roomId, path, kind)) return failure('Invalid room upload path.', 400);
      await assertRoomUploadAccess(supabase, roomId, user.id, kind === 'file' ? 'files' : 'watch_control');
      const checked = assertRoomFileInput({ name: fileName, size, type: contentType }, kind);
      const expectedExtension = extensionForFileName(checked.fileName, kind === 'subtitle' ? 'vtt' : 'bin');
      if (!path.toLowerCase().endsWith(`.${expectedExtension}`)) return failure('Upload path and file name do not match.', 400);
    } else if (bucket === MUSIC_BUCKET) {
      const [ownerId, objectName, extraSegment] = path.split('/');
      if (extraSegment || ownerId !== user.id || !isUuid(objectName?.split('.')[0])) return failure('Invalid music upload path.', 400);
      const isCover = objectName.endsWith('.cover.jpg');
      const extension = musicUploadType(path);
      if (isCover && (objectName !== `${objectName.split('.')[0]}.cover.jpg` || contentType !== 'image/jpeg')) return failure('Invalid music upload.', 400);
      if (!isCover && !extension) return failure('Invalid music upload.', 400);
      if (size <= 0 || size > (isCover ? MUSIC_MAX_COVER_BYTES : MUSIC_MAX_FILE_BYTES)) return failure('This file is too large.', 413);
      if (!isCover && extension && contentType !== MUSIC_AUDIO_TYPES[extension]) return failure('Invalid music MIME type.', 400);
    } else {
      return failure('Unsupported storage bucket.', 400);
    }

    const storage = getServerStorageProvider();
    if (storage.name === 'r2') {
      if (!storage.createSignedUploadUrl) return failure('R2 uploads are not configured.', 503);
      const uploadUrl = await storage.createSignedUploadUrl(bucket, path, contentType);
      return NextResponse.json({ provider: 'r2', uploadUrl, contentType }, { headers: noStore });
    }
    return NextResponse.json({ provider: 'supabase' }, { headers: noStore });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Upload failed.';
    const status = message === 'Unauthorized' ? 401 : message.includes('permission') ? 403 : 400;
    return failure(message, status);
  }
}
