// Shapes shared by the media search and playlist routes and the Watch search
// panel. The parsers take the providers' raw JSON and keep only what the room
// shows, so a provider change cannot leak extra fields to the browser.

export type MediaSearchSource = 'youtube' | 'twitch' | 'archive' | 'vimeo';
export const MEDIA_SEARCH_SOURCES: MediaSearchSource[] = ['youtube', 'twitch', 'archive', 'vimeo'];

export const SOURCE_NAME: Record<MediaSearchSource, string> = { youtube: 'YouTube', twitch: 'Twitch', archive: 'Internet Archive', vimeo: 'Vimeo' };
// Where to send people when a source's search is not set up or out of quota.
export const SOURCE_SITE: Record<MediaSearchSource, string> = { youtube: 'https://www.youtube.com/', twitch: 'https://www.twitch.tv/', archive: 'https://archive.org/details/movies', vimeo: 'https://vimeo.com/' };

export type MediaSearchResult = {
  source: MediaSearchSource;
  id: string;
  title: string;
  channel: string;
  thumbnail: string | null;
  url: string;
  live: boolean;
};

export type PlaylistItem = { title: string; url: string };

const ENTITIES: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' };
// YouTube returns titles HTML-escaped ("Tom &amp; Jerry").
export const decodeEntities = (value: string) => value.replace(/&(?:amp|quot|#39|lt|gt);/g, (entity) => ENTITIES[entity]);

const text = (value: unknown, max = 300) => (typeof value === 'string' ? decodeEntities(value).trim().slice(0, max) : '');
const httpsUrl = (value: unknown) => (typeof value === 'string' && value.startsWith('https://') ? value : null);
const items = (json: unknown, key: string) => {
  const list = json && typeof json === 'object' ? (json as Record<string, unknown>)[key] : null;
  return Array.isArray(list) ? (list as Array<Record<string, unknown>>) : [];
};
const obj = (value: unknown) => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {});

export function cleanQuery(value: string | null) {
  const query = (value ?? '').replace(/\s+/g, ' ').trim();
  return query.length >= 1 && query.length <= 100 ? query : null;
}

// youtube/v3/search?type=video
export function parseYouTubeSearch(json: unknown): MediaSearchResult[] {
  return items(json, 'items').flatMap((item) => {
    const id = obj(item.id).videoId;
    if (typeof id !== 'string' || !/^[\w-]{11}$/.test(id)) return [];
    const snippet = obj(item.snippet);
    const thumbs = obj(snippet.thumbnails);
    return [{
      source: 'youtube' as const,
      id,
      title: text(snippet.title) || 'YouTube video',
      channel: text(snippet.channelTitle, 120),
      thumbnail: httpsUrl(obj(thumbs.medium).url) ?? httpsUrl(obj(thumbs.default).url),
      url: `https://www.youtube.com/watch?v=${id}`,
      live: snippet.liveBroadcastContent === 'live',
    }];
  });
}

// helix/search/channels — live channels first.
export function parseTwitchSearch(json: unknown): MediaSearchResult[] {
  return items(json, 'data').flatMap((item) => {
    const login = item.broadcaster_login;
    if (typeof login !== 'string' || !/^[a-z0-9_]{1,25}$/i.test(login)) return [];
    const live = item.is_live === true;
    const name = text(item.display_name, 60) || login;
    return [{
      source: 'twitch' as const,
      id: login,
      title: live ? (text(item.title) || `${name} is live`) : name,
      channel: live ? [name, text(item.game_name, 80)].filter(Boolean).join(' · ') : 'Offline · plays the channel when it goes live',
      thumbnail: httpsUrl(item.thumbnail_url),
      url: `https://www.twitch.tv/${login.toLowerCase()}`,
      live,
    }];
  }).sort((a, b) => Number(b.live) - Number(a.live));
}

// archive.org/advancedsearch.php — returns the item ids to look up; the files
// come from each item's metadata (parseArchiveItem).
export const ARCHIVE_ID = /^[\w.-]{1,100}$/;
export function parseArchiveSearch(json: unknown): Array<{ id: string; title: string; channel: string }> {
  return items(obj(json).response, 'docs').flatMap((doc) => {
    const id = doc.identifier;
    if (typeof id !== 'string' || !ARCHIVE_ID.test(id)) return [];
    const creator = Array.isArray(doc.creator) ? doc.creator[0] : doc.creator;
    return [{ id, title: text(doc.title) || id, channel: [text(creator, 80), text(doc.year == null ? '' : String(doc.year), 4)].filter(Boolean).join(' · ') || 'Internet Archive' }];
  });
}

// Browsers play H.264 MP4 directly; the archive's own derivatives come first.
const archiveRank = (format: string) => (/^h\.264/i.test(format) ? 0 : format === 'MPEG4' ? 1 : /512kb mpeg4/i.test(format) ? 2 : 3);

// archive.org/metadata/<id> — picks one playable MP4, or null for lending-only
// items and items without a browser-playable video.
export function parseArchiveItem(id: string, json: unknown): { url: string } | null {
  if (!ARCHIVE_ID.test(id)) return null;
  const meta = obj(obj(json).metadata);
  if (meta['access-restricted-item'] === true || meta['access-restricted-item'] === 'true') return null;
  const best = items(json, 'files')
    .filter((file) => typeof file.name === 'string' && /\.mp4$/i.test(file.name) && !file.name.split('/').includes('..') && Number(file.size ?? 0) >= 2_000_000)
    .map((file) => ({ name: file.name as string, rank: archiveRank(String(file.format ?? '')), size: Number(file.size) }))
    .filter((file) => file.rank < 3)
    .sort((a, b) => a.rank - b.rank || b.size - a.size)[0];
  if (!best) return null;
  return { url: `https://archive.org/download/${id}/${best.name.split('/').map(encodeURIComponent).join('/')}` };
}

// api.vimeo.com/videos — only videos their owners allow to be embedded anywhere.
export function parseVimeoSearch(json: unknown): MediaSearchResult[] {
  return items(json, 'data').flatMap((item) => {
    const id = typeof item.uri === 'string' ? item.uri.match(/^\/videos\/(\d{1,15})$/)?.[1] : undefined;
    if (!id || obj(item.privacy).embed !== 'public') return [];
    const sizes = items(obj(item.pictures), 'sizes').filter((size) => Number(size.width) >= 200);
    return [{
      source: 'vimeo' as const,
      id,
      title: text(item.name) || 'Vimeo video',
      channel: text(obj(item.user).name, 120),
      thumbnail: httpsUrl(sizes[0]?.link),
      url: `https://vimeo.com/${id}`,
      live: false,
    }];
  });
}

// youtube/v3/playlistItems — skips private and deleted videos.
export function parseYouTubePlaylist(json: unknown): PlaylistItem[] {
  return items(json, 'items').flatMap((item) => {
    const snippet = obj(item.snippet);
    const id = obj(snippet.resourceId).videoId;
    const title = text(snippet.title);
    if (typeof id !== 'string' || !/^[\w-]{11}$/.test(id) || title === 'Private video' || title === 'Deleted video') return [];
    return [{ title: title || 'YouTube video', url: `https://www.youtube.com/watch?v=${id}` }];
  });
}
