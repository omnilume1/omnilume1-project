import { NextResponse } from 'next/server';
import { MUSICBRAINZ_SEARCH, musicBrainzQuery, parseMusicBrainz } from '@/lib/music-metadata';
import { isUuid } from '@/lib/music-upload-validation';
import { createClient } from '@/utils/supabase/server';

const noStore = { 'Cache-Control': 'private, no-store' };
// MusicBrainz asks for an identifying User-Agent with a contact; set MUSICBRAINZ_USER_AGENT in production.
const USER_AGENT = process.env.MUSICBRAINZ_USER_AGENT || 'OmniLume/1.0 ( music tag lookup )';

// shortcut: per-server-instance 1 request/s throttle and no result cache; add a shared rate ledger + cache table if lookups get frequent.
let nextSlot = 0;
async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + 1100;
  if (wait > 0) await new Promise((done) => setTimeout(done, wait));
}

/**
 * GET /api/music/metadata?upload=<id> → MusicBrainz candidates for one of the caller's
 * own uploads. The only outbound host is the fixed MusicBrainz API (no user-supplied URL).
 */
export async function GET(request: Request) {
  const uploadId = new URL(request.url).searchParams.get('upload');
  if (!isUuid(uploadId)) return NextResponse.json({ error: 'Invalid upload.' }, { status: 400, headers: noStore });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Sign in first.' }, { status: 401, headers: noStore });

  // RLS: only the owner's rows are visible.
  const { data: upload } = await supabase.from('music_uploads').select('title, artist, album, state').eq('id', uploadId).maybeSingle();
  if (!upload || upload.state !== 'active') return NextResponse.json({ error: 'Not found.' }, { status: 404, headers: noStore });

  await throttle();
  const url = `${MUSICBRAINZ_SEARCH}?query=${encodeURIComponent(musicBrainzQuery(upload))}&fmt=json&limit=5`;
  const call = () => fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
  try {
    let response = await call();
    // MusicBrainz answers 503 when it is rate-limiting; one spaced retry clears most of those.
    if (response.status === 503) {
      await throttle();
      await new Promise((done) => setTimeout(done, 1500));
      response = await call();
    }
    if (!response.ok) throw new Error(String(response.status));
    return NextResponse.json({ candidates: parseMusicBrainz(await response.json()) }, { headers: noStore });
  } catch {
    return NextResponse.json({ error: 'MusicBrainz is busy or unreachable. Try again in a moment.' }, { status: 502, headers: noStore });
  }
}
