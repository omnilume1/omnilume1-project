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
};

type ExpiredRoom = {
  id: string;
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
  return normalizedCandidate.startsWith(expectedPrefix)
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
    .select('id, room_id, file_url')
    .lte('expires_at', now)
    .limit(MEDIA_BATCH_SIZE);

  if (error) {
    throw new Error(error.message);
  }

  let removed = 0;
  const failures: string[] = [];

  for (const media of (data ?? []) as ExpiredMedia[]) {
    try {
      if (media.room_id) {
        const storagePath = getRoomStoragePath(media.file_url, media.room_id);

        if (storagePath) {
          await removeStorageFiles(supabase, [storagePath]);
        }
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
      failures.push(
        `temporary_media:${media.id}:${
          cleanupError instanceof Error
            ? cleanupError.message
            : 'cleanup failed'
        }`,
      );
    }
  }

  return { removed, failures };
}

async function cleanupIrreversibleRooms(
  supabase: SupabaseClient,
  now: string,
) {
  const { data, error } = await supabase
    .from('rooms')
    .select('id')
    .eq('expiration_type', 'irreversible')
    .not('expires_at', 'is', null)
    .lte('expires_at', now)
    .limit(ROOM_BATCH_SIZE);

  if (error) {
    throw new Error(error.message);
  }

  let removed = 0;
  const failures: string[] = [];

  for (const room of (data ?? []) as ExpiredRoom[]) {
    try {
      const storagePaths = await listStorageFiles(supabase, room.id);
      await removeStorageFiles(supabase, storagePaths);

      // Room foreign keys cascade room-owned database records. Storage objects
      // are removed first because they are not children of public.rooms.
      const { error: deleteError } = await supabase
        .from('rooms')
        .delete()
        .eq('id', room.id)
        .eq('expiration_type', 'irreversible')
        .lte('expires_at', now);

      if (deleteError) {
        throw new Error(deleteError.message);
      }

      removed += 1;
    } catch (cleanupError) {
      failures.push(
        `room:${room.id}:${
          cleanupError instanceof Error
            ? cleanupError.message
            : 'cleanup failed'
        }`,
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
    const rooms = await cleanupIrreversibleRooms(supabase, now);
    const failures = [...media.failures, ...rooms.failures];

    return NextResponse.json(
      {
        ok: failures.length === 0,
        expiredMediaRemoved: media.removed,
        irreversibleRoomsRemoved: rooms.removed,
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
