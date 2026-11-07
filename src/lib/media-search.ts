// Shapes shared by the media search and playlist routes and the Watch search
// panel. The parsers take the providers' raw JSON and keep only what the room
// shows, so a provider change cannot leak extra fields to the browser.

export type MediaSearchSource = 'youtube' | 'twitch';
export const MEDIA_SEARCH_SOURCES: MediaSearchSource[] = ['youtube', 'twitch'];

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
