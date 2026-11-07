import { NextResponse } from 'next/server';
import { getServerStorageProvider } from '@/lib/storage/server-provider';
import { MUSIC_BUCKET, MUSIC_MAX_COVER_BYTES, MUSIC_MAX_FILE_BYTES, musicCoverPath, musicObjectPath, parseRegisterBody, sniffAudio } from '@/lib/music-upload-validation';
import { createAdminClient } from '@/utils/supabase/admin';
import { createClient } from '@/utils/supabase/server';

// Validation and cap errors from register_music_upload carry a user-facing message.
const USER_ERRORS = new Set(['22023', '54000']);
const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

/**
 * Registers a music file the browser already uploaded into its own prefix.
 * The first bytes are sniffed here (the bucket's MIME list trusts the client's
 * Content-Type); only then does the service role register the row.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail(401, 'Sign in to upload music.');

  const input = parseRegisterBody(await request.json().catch(() => null));
  if (typeof input === 'string') return fail(400, input);

  const audioPath = musicObjectPath(user.id, input.uploadId, input.ext);
  const paths = [audioPath, ...(input.hasCover ? [musicCoverPath(user.id, input.uploadId)] : [])];
  const storage = getServerStorageProvider();
  const discard = () => storage.cleanup(MUSIC_BUCKET, paths).catch(() => undefined);

  let head: Uint8Array;
  try {
    head = await (await storage.openRangeReader(MUSIC_BUCKET, audioPath))(0, 15);
  } catch {
    // Missing or unreadable: nothing registered; the orphan sweep reclaims any stray object.
    return fail(400, 'The uploaded file was not found. Please try again.');
  }
  if (!sniffAudio(head, input.ext)) {
    await discard();
    return fail(422, 'This file is not a supported audio file.');
  }

  const audioObject = await storage.getMetadata(MUSIC_BUCKET, audioPath).catch(() => null);
  if (!audioObject || audioObject.size === null || audioObject.mimeType !== input.mimeType) {
    await discard();
    return fail(400, 'The uploaded file could not be verified. Please try again.');
  }
  if (audioObject.size <= 0 || audioObject.size > MUSIC_MAX_FILE_BYTES) {
    await discard();
    return fail(413, 'Files can be up to 500 MB.');
  }

  let coverSize: number | null = null;
  if (input.hasCover) {
    const coverObject = await storage.getMetadata(MUSIC_BUCKET, musicCoverPath(user.id, input.uploadId)).catch(() => null);
    if (!coverObject || coverObject.size === null || coverObject.mimeType !== 'image/jpeg') {
      await discard();
      return fail(400, 'The uploaded artwork could not be verified. Please try again.');
    }
    if (coverObject.size <= 0 || coverObject.size > MUSIC_MAX_COVER_BYTES) {
      await discard();
      return fail(413, 'Files can be up to 500 MB.');
    }
    coverSize = coverObject.size;
  }

  const { data, error } = await createAdminClient().rpc('register_music_upload', {
    p_owner_id: user.id,
    p_upload_id: input.uploadId,
    p_ext: input.ext,
    p_mime_type: input.mimeType,
    p_original_name: input.originalName,
    p_title: input.title,
    p_artist: input.artist,
    p_album: input.album,
    p_album_artist: input.albumArtist,
    p_track_no: input.trackNo,
    p_year: input.year,
    p_genre: input.genre,
    p_duration_ms: input.durationMs,
    p_hue: input.hue,
    p_lyrics: input.lyrics,
    p_has_cover: input.hasCover,
    p_audio_size: audioObject.size,
    p_cover_size: coverSize,
  });
  if (error) {
    // 23505: this upload id is already registered, so its objects belong to that row.
    if (error.code === '23505') return fail(409, 'This upload was already saved.');
    await discard();
    return USER_ERRORS.has(error.code) ? fail(400, error.message) : fail(500, 'Could not save the upload.');
  }
  return NextResponse.json({ id: data.id, expiresAt: data.expires_at }, { status: 201 });
}
