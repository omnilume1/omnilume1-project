import { NextResponse } from 'next/server';
import { assertActiveRoom } from '@/lib/room-lifecycle';
import {
  ROOM_ATTACHMENT_BUCKET,
  assertRoomFileInput,
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
    const form = await request.formData();
    const bucket = form.get('bucket');
    const path = form.get('path');
    const file = form.get('file');
    if (typeof bucket !== 'string' || typeof path !== 'string' || !(file instanceof File)) {
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
      assertRoomFileInput(file, kind);
    } else if (bucket === MUSIC_BUCKET) {
      const [ownerId, objectName] = path.split('/');
      if (ownerId !== user.id || !isUuid(objectName?.split('.')[0])) return failure('Invalid music upload path.', 400);
      const isCover = objectName.endsWith('.cover.jpg');
      const extension = musicUploadType(path);
      if (isCover && file.type !== 'image/jpeg') return failure('Invalid music upload.', 400);
      if (!isCover && !extension) return failure('Invalid music upload.', 400);
      if (file.size <= 0 || file.size > (isCover ? MUSIC_MAX_COVER_BYTES : MUSIC_MAX_FILE_BYTES)) return failure('This file is too large.', 413);
      if (!isCover && extension && file.type !== MUSIC_AUDIO_TYPES[extension]) return failure('Invalid music MIME type.', 400);
    } else {
      return failure('Unsupported storage bucket.', 400);
    }

    const metadata = await getServerStorageProvider().upload(bucket, path, file);
    return NextResponse.json({ path: metadata.path }, { headers: noStore });
  } catch (error) {
    return failure(error instanceof Error ? error.message : 'Upload failed.', 400);
  }
}
