import { NextResponse } from 'next/server';
import { isUuid, MUSIC_BUCKET, signedUrlTtlSeconds } from '@/lib/music-upload-validation';
import { createAdminClient } from '@/utils/supabase/admin';
import { createClient } from '@/utils/supabase/server';

const noStore = { 'Cache-Control': 'private, no-store' };
const missing = (status = 404) => NextResponse.json({ error: 'This song is not available.' }, { status, headers: noStore });

/**
 * `<audio src>` / `<img src>` target. get_music_playback decides (owner, or a member
 * of a room/group it is shared to; active and unexpired); the service role then
 * signs the object for min(1 h, remaining life) and the browser follows the redirect.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string; asset: string }> }) {
  const { id, asset } = await context.params;
  if (!isUuid(id) || (asset !== 'audio' && asset !== 'cover')) return missing();

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return missing(401);

  const { data, error } = await supabase.rpc('get_music_playback', { p_upload_id: id }).maybeSingle<{
    object_path: string;
    cover_path: string | null;
    expires_at: string;
  }>();
  if (error || !data) return missing();

  const path = asset === 'audio' ? data.object_path : data.cover_path;
  const ttl = signedUrlTtlSeconds(data.expires_at, Date.now());
  if (!path) return missing();
  if (ttl < 1) return missing(410);

  const signed = await createAdminClient().storage.from(MUSIC_BUCKET).createSignedUrl(path, ttl);
  if (signed.error || !signed.data?.signedUrl) return missing(502);
  const response = NextResponse.redirect(signed.data.signedUrl, 302);
  response.headers.set('Cache-Control', noStore['Cache-Control']);
  return response;
}
