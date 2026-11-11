import 'server-only';

import { cache } from 'react';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { isDoorToken } from '@/lib/door-key';
import { parseJoinCard, type JoinCard } from '@/lib/join-card';

// The card as the /join page, its metadata and its OG image see it.
// open: a valid link. gone: no such live link (revoked, expired, used up, or
// not a token at all). unknown: the read failed, including the 60-per-10-min
// rate limit (PT429). The page then shows a plain "Door's open", because
// join_room_with_invite checks the token again on Come in.
export type JoinCardRead =
  | { state: 'open'; card: JoinCard }
  | { state: 'gone' }
  | { state: 'unknown' };

// Cookie-less and session-less: the card is public, so these reads run as
// anon and never touch the visitor's session.
let anonClient: SupabaseClient | undefined;
function anon() {
  anonClient ??= createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
  return anonClient;
}

/** A /join path segment as the database stores tokens (lowercase hex), or null. */
export function normalizeJoinToken(value: string) {
  const token = value.trim().toLowerCase();
  return isDoorToken(token) ? token : null;
}

async function readJoinCard(token: string | null): Promise<JoinCardRead> {
  if (!token) return { state: 'gone' };
  try {
    // p_log stays false: join_viewed is logged only by the page's after-mount
    // browser call, never by metadata, the page render or the OG image.
    const { data, error } = await anon().rpc('get_public_invite_card', { p_token: token, p_ref: null, p_log: false });
    if (error) return { state: 'unknown' };
    const rows = Array.isArray(data) ? data : [];
    if (rows.length === 0) return { state: 'gone' };
    const card = parseJoinCard(rows[0]);
    return card ? { state: 'open', card } : { state: 'unknown' };
  } catch {
    return { state: 'unknown' };
  }
}

// One read per request: generateMetadata and the page share it.
export const getJoinCard = cache(readJoinCard);
