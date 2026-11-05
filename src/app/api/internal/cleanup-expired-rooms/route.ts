import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const STORAGE_BUCKET = 'room_attachments';
const MEDIA_BATCH_SIZE = 500;
const ROOM_BATCH_SIZE = 100;
const STORAGE_PAGE_SIZE = 1_000;
const STORAGE_REMOVE_BATCH_SIZE = 100;

type ExpiredMedia = {
  id: string;
  room_id: string | null;
  file_url: string;
  storage_path: string | null;
  subtitle_path: string | null;
};

type PendingRoomFile = {
  id: string;
  object_path: string;
};

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    return null;
  }

  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

function isAuthorized(request: Request) {
  const cronSecret = process.env.CRON_SECRET;

  return Boolean(
    cronSecret &&
      request.headers.get('authorization') === `Bearer ${cronSecret}`,
  );
}

function joinStoragePath(prefix: string, name: string) {
  return prefix ? `${prefix}/${name}` : name;
}

/**
 * Returns a storage path only when it is safely inside the room's directory.
 * URLs from older rows are supported, but arbitrary URLs are never deleted.
 */
function getRoomStoragePath(fileUrl: string, roomId: string) {
  const expectedPrefix = `${roomId}/`;
  let candidate = fileUrl;

  if (/^https?:\/\//i.test(fileUrl)) {
    try {
      const parsed = new URL(fileUrl);
      const marker = '/storage/v1/object/';
      const markerIndex = parsed.pathname.indexOf(marker);

      if (markerIndex === -1) {
        return null;
      }

      const objectPath = parsed.pathname.slice(markerIndex + marker.length);
      const accessPrefix = ['public/', 'sign/', 'authenticated/'].find((prefix) =>
        objectPath.startsWith(prefix),
      );

      if (!accessPrefix) {
        return null;
      }

      const bucketAndPath = objectPath.slice(accessPrefix.length);
      const separatorIndex = bucketAndPath.indexOf('/');

      if (separatorIndex === -1) {
        return null;
      }

      const bucket = decodeURIComponent(bucketAndPath.slice(0, separatorIndex));
      if (bucket !== STORAGE_BUCKET) {
        return null;
      }

      candidate = decodeURIComponent(bucketAndPath.slice(separatorIndex + 1));
    } catch {
      return null;
    }
  }

  const normalizedCandidate = candidate.replace(/^\/+/, '');
  return !normalizedCandidate.includes('..')
    && !normalizedCandidate.includes('\\')
    && normalizedCandidate.startsWith(expectedPrefix)
    ? normalizedCandidate
    : null;
}

async function listStorageFiles(
  supabase: SupabaseClient,
  prefix: string,
): Promise<string[]> {
  const paths: string[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .list(prefix, {
        limit: STORAGE_PAGE_SIZE,
        offset,
      });

    if (error) {
      throw new Error(error.message);
    }

    const entries = data ?? [];
    for (const entry of entries) {
      const path = joinStoragePath(prefix, entry.name);

      if (entry.id) {
        paths.push(path);
      } else {
        paths.push(...(await listStorageFiles(supabase, path)));
      }
    }

    if (entries.length < STORAGE_PAGE_SIZE) {
      break;
    }

    offset += entries.length;
  }

  return paths;
}

async function removeStorageFiles(
  supabase: SupabaseClient,
  paths: string[],
) {
  for (
    let index = 0;
    index < paths.length;
    index += STORAGE_REMOVE_BATCH_SIZE
  ) {
    const batch = paths.slice(index, index + STORAGE_REMOVE_BATCH_SIZE);
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .remove(batch);

    if (error) {
      throw new Error(error.message);
    }
  }
}

async function cleanupExpiredMedia(supabase: SupabaseClient, now: string) {
  const { data, error } = await supabase
    .from('temporary_media')
    .select('id, room_id, file_url, storage_path, subtitle_path')
    .lte('expires_at', now)
    .limit(MEDIA_BATCH_SIZE);

  if (error) {
    throw new Error(error.message);
  }

  let removed = 0;
  const failures: string[] = [];

  for (const media of (data ?? []) as ExpiredMedia[]) {
    const { data: existingJob, error: existingJobError } = await supabase
      .from('temporary_media_cleanup_jobs')
      .select('attempts')
      .eq('media_id', media.id)
      .maybeSingle();
    if (existingJobError) throw new Error(existingJobError.message);
    const attempts = (existingJob?.attempts ?? 0) + 1;
    const { error: jobError } = await supabase
      .from('temporary_media_cleanup_jobs')
      .upsert({
        media_id: media.id,
        status: 'pending',
        attempts,
        last_error: null,
        last_attempt_at: now,
        updated_at: now,
      }, { onConflict: 'media_id' });
    if (jobError) throw new Error(jobError.message);

    try {
      if (media.room_id) {
        const storagePath = getRoomStoragePath(media.storage_path ?? media.file_url, media.room_id);

        const subtitlePath = media.subtitle_path
          ? getRoomStoragePath(media.subtitle_path, media.room_id)
          : null;
        await removeStorageFiles(supabase, [storagePath, subtitlePath].filter((path): path is string => Boolean(path)));
      }

      const { error: deleteError } = await supabase
        .from('temporary_media')
        .delete()
        .eq('id', media.id);

      if (deleteError) {
        throw new Error(deleteError.message);
      }

      removed += 1;
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : 'cleanup failed';
      await supabase
        .from('temporary_media_cleanup_jobs')
        .update({
          status: 'failed',
          attempts,
          last_error: message.slice(0, 1_000),
          last_attempt_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('media_id', media.id);
      failures.push(`temporary_media:${media.id}:${message}`);
    }
  }

  return { removed, failures };
}

// Permanent files are never selected by temporary-media expiry. This retry
// queue only finishes an explicit, authorized permanent-file deletion.
async function cleanupPendingRoomFiles(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('room_files')
    .select('id, object_path')
    .eq('retention_state', 'delete_pending')
    .limit(MEDIA_BATCH_SIZE);
  if (error) throw new Error(error.message);

  let removed = 0;
  const failures: string[] = [];
  for (const file of (data ?? []) as PendingRoomFile[]) {
    try {
      await removeStorageFiles(supabase, [file.object_path]);
      const { error: completeError } = await supabase.rpc('complete_room_file_delete', {
        p_file_id: file.id,
        p_error: null,
      });
      if (completeError) throw new Error(completeError.message);
      removed += 1;
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : 'cleanup failed';
      await supabase.rpc('complete_room_file_delete', { p_file_id: file.id, p_error: message });
      failures.push(`room_file:${file.id}:${message}`);
    }
  }
  return { removed, failures };
}

// Rooms whose lifecycle has ended: irreversible rooms at expiry, and
// recoverable rooms once their 7-day recovery window closes without a pending
// recovery request (public.room_lifecycle_state). The database chooses the
// rooms and re-checks each one under a row lock before deleting it, so a
// recovery approved in the meantime is never overridden.
async function cleanupDestroyedRooms(
  supabase: SupabaseClient,
  now: string,
) {
  const { data, error } = await supabase.rpc('list_rooms_due_for_destruction', {
    p_limit: ROOM_BATCH_SIZE,
  });

  if (error) {
    throw new Error(error.message);
  }

  let removed = 0;
  const failures: string[] = [];
  const roomIds = ((data ?? []) as Array<string | { list_rooms_due_for_destruction?: string }>)
    .map((row) => (typeof row === 'string' ? row : row.list_rooms_due_for_destruction))
    .filter((id): id is string => typeof id === 'string');

  for (const roomId of roomIds) {
    // Persist intent before destructive storage work so a failed worker run is
    // visible and retried on the next authorized cleanup invocation.
    const { data: existingJob, error: existingJobError } = await supabase
      .from('room_cleanup_jobs')
      .select('attempts')
      .eq('room_id', roomId)
      .maybeSingle();
    if (existingJobError) throw new Error(existingJobError.message);
    const attempts = (existingJob?.attempts ?? 0) + 1;
    const { error: jobError } = await supabase
      .from('room_cleanup_jobs')
      .upsert({
        room_id: roomId,
        status: 'pending',
        attempts,
        last_error: null,
        updated_at: now,
        last_attempt_at: now,
      }, { onConflict: 'room_id' });
    if (jobError) throw new Error(jobError.message);

    try {
      // Storage objects are not children of public.rooms, so they are removed
      // first. Every room-owned table cascades from the room delete.
      const storagePaths = await listStorageFiles(supabase, roomId);
      await removeStorageFiles(supabase, storagePaths);

      const { data: destroyed, error: destroyError } = await supabase.rpc('destroy_expired_room', {
        p_room_id: roomId,
      });

      if (destroyError) {
        throw new Error(destroyError.message);
      }
      if (destroyed !== true) {
        throw new Error('Room is no longer due for destruction.');
      }

      removed += 1;
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : 'cleanup failed';
      await supabase
        .from('room_cleanup_jobs')
        .update({
          status: 'failed',
          attempts,
          last_error: message.slice(0, 1_000),
          updated_at: new Date().toISOString(),
          last_attempt_at: new Date().toISOString(),
        })
        .eq('room_id', roomId);
      failures.push(
        `room:${roomId}:${message}`,
      );
    }
  }

  return { removed, failures };
}

async function cleanupExpiredRooms(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const supabase = getAdminClient();
  if (!supabase) {
    return NextResponse.json(
      {
        error:
          'Cleanup is not configured. Set the Supabase service-role and cron secrets.',
      },
      { status: 503 },
    );
  }

  try {
    const now = new Date().toISOString();
    const media = await cleanupExpiredMedia(supabase, now);
    const files = await cleanupPendingRoomFiles(supabase);
    const rooms = await cleanupDestroyedRooms(supabase, now);
    const failures = [...media.failures, ...files.failures, ...rooms.failures];

    return NextResponse.json(
      {
        ok: failures.length === 0,
        expiredMediaRemoved: media.removed,
        pendingRoomFilesRemoved: files.removed,
        destroyedRoomsRemoved: rooms.removed,
        failures,
      },
      { status: failures.length === 0 ? 200 : 207 },
    );
  } catch (error: unknown) {
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : 'Expired-room cleanup failed.',
      },
      { status: 500 },
    );
  }
}

// Vercel Cron uses GET. POST also supports another trusted scheduler.
export const GET = cleanupExpiredRooms;
export const POST = cleanupExpiredRooms;

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
