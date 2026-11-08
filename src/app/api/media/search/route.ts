import { NextResponse } from 'next/server';
import { cleanQuery, MEDIA_SEARCH_SOURCES, parseArchiveItem, parseArchiveSearch, parseTwitchSearch, parseVimeoSearch, parseYouTubeSearch, SOURCE_NAME, type MediaSearchResult, type MediaSearchSource } from '@/lib/media-search';
import { createAdminClient } from '@/utils/supabase/admin';
import { createClient } from '@/utils/supabase/server';

const noStore = { 'Cache-Control': 'private, no-store' };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: noStore });

// YouTube allows ~100 searches a day on the free quota, so repeats must not
// spend it. Results are cached in public.media_search_cache, shared by every
// server instance. The cache is best-effort: if it is unreachable, search still
// works, just without caching.
const CACHE_SECONDS = 60 * 60;

async function readCache(key: string): Promise<MediaSearchResult[] | null> {
  try {
    const { data, error } = await createAdminClient().rpc('get_media_search_cache', { p_key: key, p_max_age_seconds: CACHE_SECONDS });
    return !error && Array.isArray(data) ? data as MediaSearchResult[] : null;
  } catch {
    return null;
  }
}

async function writeCache(key: string, results: MediaSearchResult[]) {
  try {
    await createAdminClient().rpc('put_media_search_cache', { p_key: key, p_results: results });
  } catch {
    // best-effort
  }
}

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

// Internet Archive needs no key: search movie items by title (most watched
// first), then keep only items that have a browser-playable MP4 to stream.
async function searchArchive(query: string): Promise<MediaSearchResult[]> {
  // Letters and digits only, lower-cased, so nothing in the query is read as
  // search syntax (AND/OR/NOT, -, quotes, brackets).
  const terms = query.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!terms) return [];
  const params = new URLSearchParams({ q: `title:(${terms}) AND mediatype:(movies) AND -access-restricted-item:true`, rows: '12', output: 'json', 'sort[]': 'downloads desc' });
  for (const field of ['identifier', 'title', 'creator', 'year']) params.append('fl[]', field);
  const response = await fetch(`https://archive.org/advancedsearch.php?${params}`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`archive ${response.status}`);
  const docs = parseArchiveSearch(await response.json());
  const found = await Promise.all(docs.map(async (doc): Promise<MediaSearchResult | null> => {
    try {
      const meta = await fetch(`https://archive.org/metadata/${doc.id}`, { cache: 'no-store', signal: AbortSignal.timeout(6000) });
      const file = meta.ok ? parseArchiveItem(doc.id, await meta.json()) : null;
      return file && { source: 'archive', id: doc.id, title: doc.title, channel: doc.channel, thumbnail: `https://archive.org/services/img/${doc.id}`, url: file.url, live: false };
    } catch {
      return null;
    }
  }));
  return found.filter((result): result is MediaSearchResult => result !== null);
}

async function search(source: MediaSearchSource, query: string): Promise<MediaSearchResult[] | 'not-configured' | 'quota'> {
  if (source === 'archive') return searchArchive(query);
  if (source === 'vimeo') {
    const token = process.env.VIMEO_ACCESS_TOKEN;
    if (!token) return 'not-configured';
    const params = new URLSearchParams({ query, per_page: '15', fields: 'uri,name,user.name,pictures.sizes,privacy.embed' });
    const response = await fetch(`https://api.vimeo.com/videos?${params}`, { headers: { Authorization: `bearer ${token}`, Accept: 'application/vnd.vimeo.*+json;version=3.4' }, cache: 'no-store' });
    if (response.status === 429) return 'quota';
    if (!response.ok) throw new Error(`vimeo ${response.status}`);
    return parseVimeoSearch(await response.json());
  }
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
 * GET /api/media/search?source=youtube|twitch|archive|vimeo&q=… → things to cast.
 * Signed-in users only, so the API quota is not open to the internet. The only
 * outbound hosts are the fixed YouTube, Twitch, Internet Archive and Vimeo APIs
 * (archive item ids are validated before they go into a metadata URL).
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const source = params.get('source') as MediaSearchSource;
  const query = cleanQuery(params.get('q'));
  if (!MEDIA_SEARCH_SOURCES.includes(source)) return fail('Choose where to search.', 400);
  if (!query) return fail('Type something to search for.', 400);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail('Sign in first.', 401);

  const cacheKey = `${source}:${query.toLowerCase()}`;
  const cached = await readCache(cacheKey);
  if (cached) return NextResponse.json({ results: cached }, { headers: noStore });

  try {
    const results = await search(source, query);
    if (results === 'not-configured') return fail(`${SOURCE_NAME[source]} search is not set up yet.`, 503);
    if (results === 'quota') return fail(source === 'youtube' ? 'YouTube search has reached today’s limit. Paste a link instead, or try again tomorrow.' : `${SOURCE_NAME[source]} search is busy. Try again in a few minutes.`, 503);
    await writeCache(cacheKey, results);
    return NextResponse.json({ results }, { headers: noStore });
  } catch {
    return fail('Search is not available right now. Try again in a moment.', 502);
  }
}
