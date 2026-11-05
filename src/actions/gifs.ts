'use server';

import { createClient } from '@/utils/supabase/server';
import { cleanGifTitle, isGiphyId, isGiphyMediaUrl } from '@/lib/gif-message';

// GIPHY search for the room chat GIF picker. The API key stays on the server
// (GIPHY_API_KEY, never NEXT_PUBLIC_), only signed-in users can search, and
// only ids, titles and validated GIPHY preview URLs are returned.

export type GifResult = { id: string; title: string; previewUrl: string; width: number; height: number };

const PAGE_SIZE = 24;
const MAX_OFFSET = 4_999 - PAGE_SIZE;
// OmniLume's minimum age is 13 (owner decision 2026-11-05).
const CONTENT_RATING = 'pg-13';

type GiphyImage = { url?: unknown; width?: unknown; height?: unknown };
type GiphyItem = { id?: unknown; title?: unknown; images?: Record<string, GiphyImage | undefined> };

function toResult(item: GiphyItem): GifResult | null {
  if (!isGiphyId(item.id)) return null;
  const image = item.images?.fixed_width_small ?? item.images?.fixed_width;
  if (!image || !isGiphyMediaUrl(image.url)) return null;
  const width = Number(image.width);
  const height = Number(image.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { id: item.id, title: cleanGifTitle(item.title), previewUrl: image.url, width, height };
}

export async function searchGifs(query: string, offset = 0): Promise<{ success: true; gifs: GifResult[]; nextOffset: number | null } | { success: false; error: string }> {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) throw new Error('Sign in to search GIFs.');

    const apiKey = process.env.GIPHY_API_KEY;
    if (!apiKey) throw new Error('GIF search is not configured.');

    const term = typeof query === 'string' ? query.trim().slice(0, 50) : '';
    const start = Number.isSafeInteger(offset) ? Math.min(Math.max(offset, 0), MAX_OFFSET) : 0;
    const params = new URLSearchParams({ api_key: apiKey, limit: String(PAGE_SIZE), offset: String(start), rating: CONTENT_RATING, bundle: 'messaging_non_clips' });
    if (term) {
      params.set('q', term);
      params.set('lang', 'en');
    }
    const endpoint = term ? 'search' : 'trending';
    const response = await fetch(`https://api.giphy.com/v1/gifs/${endpoint}?${params.toString()}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error('GIF search is unavailable right now.');
    const body = await response.json() as { data?: unknown; pagination?: { total_count?: unknown; count?: unknown } };
    const items = Array.isArray(body.data) ? body.data as GiphyItem[] : [];
    const gifs = items.map(toResult).filter((gif): gif is GifResult => gif !== null);
    const total = Number(body.pagination?.total_count);
    const next = start + items.length;
    return { success: true, gifs, nextOffset: items.length === PAGE_SIZE && next <= MAX_OFFSET && (!Number.isFinite(total) || next < total) ? next : null };
  } catch (error: unknown) {
    const message = error instanceof Error && !/api_key|giphy\.com/i.test(error.message) ? error.message : 'GIF search is unavailable right now.';
    return { success: false, error: message };
  }
}
