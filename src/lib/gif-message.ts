// Room chat GIF messages (Action 08, owner decision 2026-11-05: GIPHY).
//
// A GIF is sent as an ordinary room message whose content is a token holding
// only the GIPHY id and a short title, e.g. "[gif:xT9IgDEI1iZyb2wqo8|Excited]".
// Clients build the image URL from the id themselves, so a message can never
// point the room at an arbitrary URL. Clients that do not know the token show
// it as plain text. No imports: unit tests load this module directly.

export const GIF_TITLE_MAX_CHARS = 100;
const GIPHY_ID_PATTERN = /^[A-Za-z0-9]{4,64}$/;
const GIF_TOKEN_PATTERN = /^\[gif:([A-Za-z0-9]{4,64})(?:\|([^\]\n]{0,100}))?\]$/;
// Preview URLs returned by the GIPHY API that the picker may display. GIPHY
// inserts an optional "v1.<base64 tracking token>/" segment before the id.
const GIPHY_MEDIA_URL_PATTERN = /^https:\/\/media[0-9]?\.giphy\.com\/media\/(?:v1\.[A-Za-z0-9_=-]{1,512}\/)?[A-Za-z0-9]{4,64}\/[A-Za-z0-9_.-]+\.(?:gif|webp)(?:\?[A-Za-z0-9=&_.%-]*)?$/;

export type GifMessage = { id: string; title: string };

export function isGiphyId(value: unknown): value is string {
  return typeof value === 'string' && GIPHY_ID_PATTERN.test(value);
}

export function isGiphyMediaUrl(value: unknown): value is string {
  return typeof value === 'string' && GIPHY_MEDIA_URL_PATTERN.test(value);
}

export function cleanGifTitle(title: unknown) {
  if (typeof title !== 'string') return '';
  return title.replace(/[\]|\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, GIF_TITLE_MAX_CHARS);
}

export function formatGifMessage(gif: GifMessage) {
  if (!isGiphyId(gif.id)) throw new Error('Invalid GIF.');
  const title = cleanGifTitle(gif.title);
  return title ? `[gif:${gif.id}|${title}]` : `[gif:${gif.id}]`;
}

export function parseGifMessage(content: unknown): GifMessage | null {
  if (typeof content !== 'string') return null;
  const match = GIF_TOKEN_PATTERN.exec(content.trim());
  if (!match) return null;
  return { id: match[1], title: (match[2] ?? '').trim() };
}

// Built from the id only (fixed-width 200px rendition).
export function giphyImageUrl(id: string) {
  if (!isGiphyId(id)) throw new Error('Invalid GIF.');
  return `https://media.giphy.com/media/${id}/200w.gif`;
}
