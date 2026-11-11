'use client';

import { useEffect } from 'react';
import { cleanRef, refFromCookieString } from '@/lib/product-events';
import { createClient } from '@/utils/supabase/client';

// Logs join_viewed once per link per browser per day, after mount, so link
// previews (which run no script) never count. The flag is keyed by a short
// SHA-256 prefix of the token, never the token itself. Any failure, including
// the card's rate limit (429), skips the event silently.

const FLAG_PREFIX = 'omni:join-viewed:';

async function flagKey(token: string) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return FLAG_PREFIX + Array.from(digest.slice(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

async function logJoinViewed(token: string, ref: string | null) {
  let key: string | null = null;
  try {
    key = await flagKey(token);
    const day = today();
    if (window.localStorage.getItem(key) === day) return;
    // Set before the call so a second mount (Strict Mode) doesn't log twice.
    window.localStorage.setItem(key, day);
    const { error } = await createClient().rpc('get_public_invite_card', {
      p_token: token,
      p_ref: cleanRef(ref) ?? refFromCookieString(document.cookie),
      p_log: true,
    });
    if (error) throw error;
  } catch {
    // Not logged (rate limit, offline, no storage): let a later visit try again.
    try {
      if (key) window.localStorage.removeItem(key);
    } catch {
      // Storage unavailable.
    }
  }
}

export default function JoinViewed({ token, refTag }: { token: string; refTag: string | null }) {
  useEffect(() => {
    void logJoinViewed(token, refTag);
  }, [token, refTag]);
  return null;
}
