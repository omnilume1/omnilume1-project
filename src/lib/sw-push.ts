// What the service worker does with an incoming push. Pure and self-contained (no imports,
// no outer variables): its source is copied into public/sw.js by scripts/write-sw.mjs, and
// the unit tests run this exact function.

export interface SwPushPlan {
  title: string;
  options: { body: string; tag: string; badge: string; icon: string; renotify: boolean; data: { url: string; count: number } };
}

/**
 * @param raw           the parsed push payload ({ title, body, url, tag }), untrusted
 * @param origin        the worker's own origin
 * @param focusedUrls   URLs of this site's windows that are focused and visible right now
 * @param existingCount how many messages the notification already showing under this tag stands for (0 = none)
 * @returns what to show, or null to show nothing (bad payload, or the person is already looking at that page)
 */
export function swPushPlan(raw: unknown, origin: string, focusedUrls: string[], existingCount: number): SwPushPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as { title?: unknown; body?: unknown; url?: unknown; tag?: unknown };
  const text = (value: unknown, max: number) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
  const title = text(data.title, 120);
  const body = text(data.body, 300);
  const tag = text(data.tag, 120);
  const url = typeof data.url === 'string' ? data.url : '';
  // Only a path on this site may be opened by a tap.
  if (!title || !body || !tag || url.charAt(0) !== '/' || url.charAt(1) === '/' || url.indexOf('\\') !== -1) return null;
  let target: URL;
  try {
    target = new URL(url, origin);
  } catch {
    return null;
  }
  if (target.origin !== origin) return null;
  // Someone looking at that page right now already sees it arrive there.
  for (const clientUrl of focusedUrls) {
    try {
      const open = new URL(clientUrl);
      if (open.origin === origin && open.pathname === target.pathname) return null;
    } catch {
      // Not a URL: ignore it.
    }
  }
  // A busy chat updates the one notification instead of buzzing again for every message.
  const count = (existingCount > 0 ? Math.floor(existingCount) : 0) + 1;
  const stacked = count + (tag.indexOf('room:') === 0 ? ' new notifications' : ' new messages');
  return {
    title,
    options: {
      body: count > 1 ? stacked : body,
      tag,
      badge: '/icons/badge-96.png',
      icon: '/icons/icon-192.png',
      renotify: count === 1,
      data: { url: target.pathname + target.search + target.hash, count },
    },
  };
}
