// The first web link in pasted, dropped or shared text. Phone share sheets
// often wrap the link in a sentence ("Watch this! https://youtu.be/…").
export function findLink(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s<>"']+/i) ?? text.match(/\b(?:www\.|m\.)?(?:youtube\.com|youtu\.be|twitch\.tv|kick\.com)\/[^\s<>"']+/i);
  return match ? match[0].replace(/[),.!?]+$/, '') : null;
}

function parseLink(link: string) {
  try {
    return new URL(/^https?:\/\//i.test(link) ? link : `https://${link}`);
  } catch {
    return null;
  }
}

// The playlist id of a YouTube link (…list=PL…), or null.
export function youtubePlaylistId(link: string): string | null {
  const url = parseLink(link);
  if (!url || !/(^|\.)(youtube\.com|youtu\.be)$/i.test(url.hostname)) return null;
  const id = url.searchParams.get('list');
  return id && /^[\w-]{10,64}$/.test(id) ? id : null;
}

// True when a YouTube link points at one video (not only a playlist page).
export function hasYouTubeVideo(link: string) {
  return /(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|live\/|shorts\/))[\w-]{11}/i.test(link);
}

// Turns a pasted YouTube, Twitch, Kick or direct media link into the URL and
// title the room plays. Throws with a readable message for links it cannot play.
export function normalizeCastUrl(value: string) {
  const trimmed = value.trim();
  const youtubeMatch = trimmed.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|live\/|shorts\/))([\w-]{11})/i);
  if (youtubeMatch?.[1]) {
    return {
      url: `https://www.youtube.com/watch?v=${youtubeMatch[1]}`,
      title: 'YouTube video',
    };
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(withProtocol);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Please enter an HTTP or HTTPS media URL.');
  const hostname = parsed.hostname.replace(/^www\./i, '').toLowerCase();
  if (hostname === 'kick.com' || hostname.endsWith('.kick.com')) {
    if (!/\.m3u8(?:$|\?)/i.test(parsed.pathname + parsed.search)) {
      throw new Error('Kick channel or video pages are not direct media streams. Paste a direct HTTPS HLS (.m3u8) stream URL provided by the source.');
    }
    return { url: parsed.toString(), title: 'Kick live stream' };
  }
  if (hostname === 'twitch.tv' || hostname === 'go.twitch.tv') {
    const path = parsed.pathname.replace(/\/+$/, '');
    const isChannel = /^\/[a-z0-9_]+$/i.test(path);
    const isVideo = /^\/videos?\/\d+$/i.test(path) || /^\d+$/.test(parsed.searchParams.get('video') ?? '');
    if (!isChannel && !isVideo) {
      throw new Error('This Twitch URL is not a supported channel or video. Paste a Twitch channel/video URL or a direct HTTPS media URL.');
    }
    return { url: parsed.toString(), title: isVideo ? 'Twitch video' : 'Twitch live stream' };
  }
  return {
    url: parsed.toString(),
    title: parsed.hostname.replace(/^www\./i, '') || 'Web stream',
  };
}
