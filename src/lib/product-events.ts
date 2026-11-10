// Phase 02: anonymous product events (public.product_events through the
// log_product_event RPC) and the first-touch `ref` attribution cookie.
// No imports: the proxy, server and browser helpers and the unit tests all
// load this module directly. Events never carry user ids, IPs, message text or
// titles (roadmap §0.7).

export const PRODUCT_EVENTS = [
  'room_created', 'invite_created', 'share_completed', 'call_in_shared',
  'join_viewed', 'joined', 'guest_joined', 'spot_joined', 'drop_in',
  'knock_sent', 'timer_started', 'timer_completed',
  'recap_shared', 'report_created',
] as const;
export type ProductEvent = typeof PRODUCT_EVENTS[number];

export type ProductEventMeta = Partial<Record<'spot' | 'people' | 'minutes' | 'template' | 'from' | 'variant', string | number | boolean>>;

export type ProductEventOptions = {
  roomId?: string | null;
  ref?: string | null;
  meta?: ProductEventMeta | null;
};

export const REF_COOKIE = 'omni_ref';
export const REF_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const REF_PATTERN = /^[a-z0-9-]{1,40}$/;

export function isValidRef(value: unknown): value is string {
  return typeof value === 'string' && REF_PATTERN.test(value);
}

export function cleanRef(value: unknown): string | null {
  return isValidRef(value) ? value : null;
}

// Which ref the proxy should store for this request, or null to leave the
// cookie alone. First touch wins: an existing valid cookie is never replaced.
// A valid ?ref= on /, /login or /join/* is stored; /?v=b with no ref stores
// lp-b; a bare / stores lp-a.
export function refToStore(pathname: string, searchParams: URLSearchParams, existing: string | null | undefined): string | null {
  if (isValidRef(existing)) return null;
  const tracked = pathname === '/' || pathname === '/login' || pathname.startsWith('/join/');
  if (!tracked) return null;
  const ref = searchParams.get('ref');
  if (isValidRef(ref)) return ref;
  if (pathname !== '/' || ref !== null) return null;
  return searchParams.get('v') === 'b' ? 'lp-b' : 'lp-a';
}

// The omni_ref value from a Cookie header or document.cookie string.
export function refFromCookieString(cookieString: string | null | undefined): string | null {
  for (const part of (cookieString ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === REF_COOKIE) return cleanRef(decodeURIComponent(rest.join('=')));
  }
  return null;
}

// Arguments for public.log_product_event. An explicit valid ref wins over the
// cookie's.
export function productEventArgs(event: ProductEvent, options: ProductEventOptions, cookieRef: string | null) {
  return {
    p_event: event,
    p_room_id: options.roomId ?? null,
    p_ref: cleanRef(options.ref) ?? cookieRef,
    p_meta: options.meta && Object.keys(options.meta).length > 0 ? options.meta : null,
  };
}

type RpcClient = {
  rpc: (fn: 'log_product_event', args: ReturnType<typeof productEventArgs>) => PromiseLike<{ error: unknown }>;
};

// Browser helper. Callers await it; it never throws, because a metric must
// never break the room. Uses the browser client's rpc, not a server action
// (roadmap §0.8).
export async function logProductEventFromBrowser(client: RpcClient, event: ProductEvent, options: ProductEventOptions = {}) {
  try {
    const cookieRef = refFromCookieString((globalThis as { document?: { cookie?: string } }).document?.cookie);
    await client.rpc('log_product_event', productEventArgs(event, options, cookieRef));
  } catch {
    // Metrics are best effort.
  }
}

// A new membership's joined_at is within this many milliseconds of the join
// request's start (roadmap §0.11: only new members count as joined).
export const NEW_MEMBER_WINDOW_MS = 10_000;

export function isNewMembership(joinedAt: string | null | undefined, requestStartedAt: number) {
  if (!joinedAt) return false;
  const joined = new Date(joinedAt).getTime();
  return Number.isFinite(joined) && Math.abs(joined - requestStartedAt) <= NEW_MEMBER_WINDOW_MS;
}
