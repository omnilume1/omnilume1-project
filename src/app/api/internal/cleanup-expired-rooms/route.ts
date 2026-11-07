import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { cleanupMusicUploads } from '@/lib/music-cleanup';
import { cleanupDestroyedRooms, cleanupExpiredMedia, cleanupExpiredRecordings, cleanupPendingRoomFiles, type RoomAttachmentStorage } from '@/lib/room-cleanup';
import { getServerStorageProvider } from '@/lib/storage/server-provider';

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
    const provider = getServerStorageProvider();
    const roomStorage: RoomAttachmentStorage | undefined = provider.name === 'r2' ? provider : undefined;
    const musicStorage: RoomAttachmentStorage | undefined = provider.name === 'r2' ? provider : undefined;
    const media = await cleanupExpiredMedia(supabase, now, roomStorage);
    const files = await cleanupPendingRoomFiles(supabase, roomStorage);
    const rooms = roomStorage
      ? await cleanupDestroyedRooms(supabase, now, roomStorage)
      : await cleanupDestroyedRooms(supabase, now);
    const recordings = await cleanupExpiredRecordings(supabase);
    const music = musicStorage
      ? await cleanupMusicUploads(supabase, musicStorage)
      : await cleanupMusicUploads(supabase);
    const failures = [...media.failures, ...files.failures, ...rooms.failures, ...recordings.failures, ...music.failures];

    return NextResponse.json(
      {
        ok: failures.length === 0,
        expiredMediaRemoved: media.removed,
        pendingRoomFilesRemoved: files.removed,
        destroyedRoomsRemoved: rooms.removed,
        expiredRecordingsRemoved: recordings.removed,
        expiredMusicUploadsRemoved: music.removed,
        orphanMusicObjectsRemoved: music.orphansRemoved,
        // Items an overlapping run had already cleaned (not failures).
        alreadyCleanedSkipped: media.skipped + rooms.skipped,
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
