// Which push services a browser subscription may point at. The server POSTs to the stored
// endpoint, so this allowlist is the SSRF guard. It is checked three times with the same
// pattern: in the browser before saving, in SQL when saving (save_push_subscription embeds
// PUSH_ENDPOINT_PATTERN verbatim; a unit test compares them) and on the server before every send.

export const PUSH_ENDPOINT_MAX_LENGTH = 1000;

/**
 * https, one of the known push hosts in lower case, no userinfo, no port, then a path of
 * printable ASCII. Written so the same string is valid in JavaScript and in Postgres.
 * Hosts: Chrome/Android (FCM), Firefox (Mozilla autopush), Edge (WNS), Safari (APNs web push).
 */
export const PUSH_ENDPOINT_PATTERN =
  '^https://(fcm\\.googleapis\\.com|[a-z0-9-]+\\.googleapis\\.com|updates\\.push\\.services\\.mozilla\\.com|[a-z0-9-]+\\.notify\\.windows\\.com|web\\.push\\.apple\\.com|[a-z0-9-]+\\.push\\.apple\\.com)/[!-~]*$';

/** Keys as browsers give them: base64url without padding (65-byte P-256 point, 16-byte auth secret). */
export const PUSH_P256DH_PATTERN = '^[A-Za-z0-9_-]{87}$';
export const PUSH_AUTH_PATTERN = '^[A-Za-z0-9_-]{22}$';

const endpointPattern = new RegExp(PUSH_ENDPOINT_PATTERN);
const p256dhPattern = new RegExp(PUSH_P256DH_PATTERN);
const authPattern = new RegExp(PUSH_AUTH_PATTERN);

export function isAllowedPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > PUSH_ENDPOINT_MAX_LENGTH || !endpointPattern.test(endpoint)) return false;
  try {
    // Belt and braces: the URL parser must agree with the pattern about where the host ends.
    const url = new URL(endpoint);
    return url.protocol === 'https:' && url.username === '' && url.password === '' && url.port === '' && endpoint.startsWith(`https://${url.hostname}/`);
  } catch {
    return false;
  }
}

export function isValidPushKeys(p256dh: unknown, auth: unknown): boolean {
  return typeof p256dh === 'string' && typeof auth === 'string' && p256dhPattern.test(p256dh) && authPattern.test(auth);
}

/** Browsers may hand keys over with `+`, `/` or `=` padding; the database stores plain base64url. */
export function toBase64Url(value: string): string {
  return value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
