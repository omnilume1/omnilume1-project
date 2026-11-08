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
    // Port 53 is blocked by browsers, so those URLs only add a timeout.
    const list = (Array.isArray(urls) ? urls : [urls]).filter((url): url is string => typeof url === 'string' && /^(stun|stuns|turn|turns):/i.test(url) && !/:53(\?|$)/.test(url));
    if (list.length === 0) return [];
    return [{
      urls: list,
      ...(typeof username === 'string' ? { username } : {}),
      ...(typeof credential === 'string' ? { credential } : {}),
    }];
  });
}

/**
 * TURN relay credentials for voice and tab sharing (Cloudflare when configured,
 * else Metered). API keys stay on the server; signed-in members get only the
 * relay list. Any failure
 * returns an empty list so calls fall back to public STUN.
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return none(401);

  const cfKeyId = process.env.CLOUDFLARE_TURN_KEY_ID?.trim();
  const cfToken = process.env.CLOUDFLARE_TURN_API_TOKEN?.trim();
  const app = process.env.METERED_APP_NAME?.trim();
  const key = process.env.METERED_API_KEY?.trim();

  try {
    let payload: unknown;
    if (cfKeyId && cfToken && /^[a-z0-9]+$/i.test(cfKeyId)) {
      const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${cfKeyId}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 86_400 }),
        cache: 'no-store',
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return none();
      const body = await response.json() as { iceServers?: unknown };
      payload = body.iceServers;
    } else if (app && key && /^[a-z0-9-]+$/i.test(app)) {
      const response = await fetch(`https://${app}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(key)}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return none();
      payload = await response.json();
    } else {
      return none();
    }
    return NextResponse.json({ iceServers: toIceServers(payload) }, { headers: noStore });
  } catch {
    return none();
  }
}
