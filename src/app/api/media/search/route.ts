import { NextResponse } from 'next/server';
import { cleanQuery, MEDIA_SEARCH_SOURCES, parseTwitchSearch, parseYouTubeSearch, type MediaSearchResult, type MediaSearchSource } from '@/lib/media-search';
import { createClient } from '@/utils/supabase/server';

const noStore = { 'Cache-Control': 'private, no-store' };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: noStore });

// shortcut: per-server-instance cache (YouTube allows ~100 searches a day on
// the free quota, so repeats must not spend it); move to a shared cache table
// if search gets busy.
const CACHE_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; results: MediaSearchResult[] }>();

let twitchToken: { value: string; until: number } | null = null;
async function getTwitchToken(clientId: string, secret: string) {
  if (twitchToken && twitchToken.until > Date.now()) return twitchToken.value;
  const body = new URLSearchParams({ client_id: clientId, client_secret: secret, grant_type: 'client_credentials' });
  const response = await fetch('https://id.twitch.tv/oauth2/token', { method: 'POST', body, cache: 'no-store' });
  if (!response.ok) throw new Error('twitch token');
  const json = await response.json() as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error('twitch token');
  twitchToken = { value: json.access_token, until: Date.now() + Math.max(60, (json.expires_in ?? 3600) - 300) * 1000 };
  return twitchToken.value;
}

async function search(source: MediaSearchSource, query: string): Promise<MediaSearchResult[] | 'not-configured' | 'quota'> {
  if (source === 'youtube') {
    const key = process.env.YOUTUBE_API_KEY;
    if (!key) return 'not-configured';
    const params = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: '15', q: query, key });
    const response = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`, { cache: 'no-store' });
    if (response.status === 403) return 'quota';
    if (!response.ok) throw new Error(`youtube ${response.status}`);
    return parseYouTubeSearch(await response.json());
  }
  const clientId = process.env.TWITCH_CLIENT_ID;
  const secret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !secret) return 'not-configured';
  const token = await getTwitchToken(clientId, secret);
  const params = new URLSearchParams({ query, first: '15' });
  const response = await fetch(`https://api.twitch.tv/helix/search/channels?${params}`, { headers: { 'Client-Id': clientId, Authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (response.status === 401) twitchToken = null;
  if (!response.ok) throw new Error(`twitch ${response.status}`);
  return parseTwitchSearch(await response.json());
}

/**
 * GET /api/media/search?source=youtube|twitch&q=… → videos or channels to cast.
 * Signed-in users only, so the API quota is not open to the internet. The only
 * outbound hosts are the fixed YouTube and Twitch APIs.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const source = params.get('source') as MediaSearchSource;
  const query = cleanQuery(params.get('q'));
  if (!MEDIA_SEARCH_SOURCES.includes(source)) return fail('Choose YouTube or Twitch.', 400);
  if (!query) return fail('Type something to search for.', 400);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail('Sign in first.', 401);

  const cacheKey = `${source}:${query.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_MS) return NextResponse.json({ results: cached.results }, { headers: noStore });

  try {
    const results = await search(source, query);
    if (results === 'not-configured') return fail(`${source === 'youtube' ? 'YouTube' : 'Twitch'} search is not set up yet.`, 503);
    if (results === 'quota') return fail('YouTube search has reached today’s limit. Paste a link instead, or try again tomorrow.', 503);
    if (cache.size > 300) cache.delete(cache.keys().next().value as string);
    cache.set(cacheKey, { at: Date.now(), results });
    return NextResponse.json({ results }, { headers: noStore });
  } catch {
    return fail('Search is not available right now. Try again in a moment.', 502);
  }
}
