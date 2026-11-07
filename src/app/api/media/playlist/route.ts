import { NextResponse } from 'next/server';
import { parseYouTubePlaylist } from '@/lib/media-search';
import { createClient } from '@/utils/supabase/server';

const noStore = { 'Cache-Control': 'private, no-store' };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: noStore });

/**
 * GET /api/media/playlist?id=<YouTube playlist id> → up to 50 videos (the
 * queue holds 50). Signed-in users only; the only outbound host is the fixed
 * YouTube API.
 */
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!/^[\w-]{10,64}$/.test(id)) return fail('That is not a YouTube playlist link.', 400);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail('Sign in first.', 401);

  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return fail('Playlist import is not set up yet.', 503);

  try {
    const params = new URLSearchParams({ part: 'snippet', maxResults: '50', playlistId: id, key });
    const response = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?${params}`, { cache: 'no-store' });
    // Private playlists and YouTube Mixes (RD…) are not readable through the API.
    const json = await response.json().catch(() => null) as { error?: { errors?: Array<{ reason?: string }> } } | null;
    const reason = json?.error?.errors?.[0]?.reason;
    if (response.status === 404 || reason === 'playlistItemsNotAccessible') return fail('This playlist is private or cannot be read. Try a public playlist.', 404);
    if (reason === 'quotaExceeded') return fail('Playlist import has reached today’s YouTube limit. Try again tomorrow.', 503);
    if (!response.ok) throw new Error(`youtube ${response.status}`);
    const items = parseYouTubePlaylist(json);
    if (!items.length) return fail('This playlist has no videos that can be played.', 404);
    return NextResponse.json({ items }, { headers: noStore });
  } catch {
    return fail('The playlist could not be loaded right now. Try again in a moment.', 502);
  }
}
