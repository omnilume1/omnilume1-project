import { NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';

const noStore = { 'Cache-Control': 'private, no-store' };
const none = (status = 200) => NextResponse.json({ iceServers: [] }, { status, headers: noStore });

type IceServer = { urls: string | string[]; username?: string; credential?: string };

// Keeps only well-formed STUN/TURN entries from the provider response.
function toIceServers(value: unknown): IceServer[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const { urls, username, credential } = entry as Record<string, unknown>;
    const list = (Array.isArray(urls) ? urls : [urls]).filter((url): url is string => typeof url === 'string' && /^(stun|stuns|turn|turns):/i.test(url));
    if (list.length === 0) return [];
    return [{
      urls: list,
      ...(typeof username === 'string' ? { username } : {}),
      ...(typeof credential === 'string' ? { credential } : {}),
    }];
  });
}

/**
 * TURN relay credentials for voice and tab sharing. The Metered API key stays
 * on the server; signed-in members get only the relay list. Any failure
 * returns an empty list so calls fall back to public STUN.
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return none(401);

  const app = process.env.METERED_APP_NAME?.trim();
  const key = process.env.METERED_API_KEY?.trim();
  if (!app || !key || !/^[a-z0-9-]+$/i.test(app)) return none();

  try {
    const response = await fetch(`https://${app}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(key)}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return none();
    return NextResponse.json({ iceServers: toIceServers(await response.json()) }, { headers: noStore });
  } catch {
    return none();
  }
}
