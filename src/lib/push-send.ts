import { createHash } from 'node:crypto';
import { isAllowedPushEndpoint, isValidPushKeys } from './push-endpoint';
import { buildPushPayload, pushPayloadJson, type PushPayload } from './push-payload';

// Sends one event's notifications to every target subscription. The network call and the
// database call are passed in, so this is tested without sending anything. It returns and
// logs counts only: no endpoint, user, name or text ever leaves this function.

export interface PushSubscriptionKeys { endpoint: string; keys: { p256dh: string; auth: string } }
export interface PushSendOptions { TTL: number; urgency: 'high' | 'normal'; topic: string; timeout: number }
export interface PushDeps {
  /** Resolves with the push service's status code, or rejects with an error that may carry `statusCode`. */
  send(subscription: PushSubscriptionKeys, payload: string, options: PushSendOptions): Promise<{ statusCode: number }>;
  /** Removes a subscription the push service says is gone. */
  prune(endpoint: string): Promise<void>;
  timeoutMs?: number;
}
export interface PushCounts { targets: number; sent: number; pruned: number; failed: number; skipped: number }

export const PUSH_SEND_TIMEOUT_MS = 5000;

/** The Topic header: at most 32 URL-safe characters. A phone that was offline gets only the latest per topic. */
export function pushTopic(tag: string): string {
  return createHash('sha256').update(tag, 'utf8').digest('base64url').slice(0, 32);
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('Push send timed out.'), { statusCode: 0 })), ms);
    work.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

const statusOf = (error: unknown) => (error && typeof error === 'object' && typeof (error as { statusCode?: unknown }).statusCode === 'number' ? (error as { statusCode: number }).statusCode : 0);

export async function deliverPush(targets: unknown, deps: PushDeps): Promise<PushCounts> {
  const rows = Array.isArray(targets) ? targets : [];
  const counts: PushCounts = { targets: rows.length, sent: 0, pruned: 0, failed: 0, skipped: 0 };
  const timeoutMs = deps.timeoutMs ?? PUSH_SEND_TIMEOUT_MS;

  await Promise.allSettled(rows.map(async (row: unknown) => {
    const target = (row && typeof row === 'object' ? row : {}) as { endpoint?: unknown; p256dh?: unknown; auth?: unknown };
    const payload: PushPayload | null = buildPushPayload(row);
    // The endpoint is checked again here, not only when it was saved: this is where the request leaves the server.
    if (!payload || !isAllowedPushEndpoint(target.endpoint) || !isValidPushKeys(target.p256dh, target.auth)) { counts.skipped += 1; return; }
    const endpoint = target.endpoint;
    let status: number;
    try {
      const result = await withTimeout(
        deps.send({ endpoint, keys: { p256dh: target.p256dh as string, auth: target.auth as string } }, pushPayloadJson(payload), { TTL: payload.ttl, urgency: payload.urgency, topic: pushTopic(payload.tag), timeout: timeoutMs }),
        timeoutMs,
      );
      status = result.statusCode;
    } catch (error: unknown) {
      status = statusOf(error);
    }
    if (status >= 200 && status < 300) { counts.sent += 1; return; }
    // Gone for good: the browser unsubscribed or the app was removed. 429 and 5xx are kept and retried by the next event.
    if (status === 404 || status === 410) {
      try { await deps.prune(endpoint); counts.pruned += 1; } catch { counts.failed += 1; }
      return;
    }
    counts.failed += 1;
  }));
  return counts;
}
