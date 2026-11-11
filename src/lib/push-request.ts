import { createHash, timingSafeEqual } from 'node:crypto';
import { isUuid } from './message-limits';
import { isPushKind, type PushKind } from './push-payload';
import { deliverPush, type PushCounts, type PushDeps } from './push-send';

// The checks on the webhook Postgres calls (/api/internal/push). Server-side only (node:crypto).

/**
 * `Authorization: Bearer <secret>`, compared in constant time. Both sides are hashed first, so
 * the comparison takes the same time whatever the length of what was sent.
 */
export function isAuthorizedPushRequest(authorization: string | null | undefined, secret: string | null | undefined): boolean {
  if (typeof secret !== 'string' || secret.length < 16 || typeof authorization !== 'string') return false;
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(authorization), digest(`Bearer ${secret}`));
}

export interface PushWebhookDeps extends PushDeps {
  /** PUSH_WEBHOOK_SECRET. */
  secret: string | null | undefined;
  /** push_deliveries(kind, id), called with the service role. */
  loadDeliveries(kind: PushKind, id: string): Promise<unknown>;
  /** Receives counts only. */
  log(line: string): void;
}

/**
 * The whole webhook, without the framework: 401 for a wrong or missing secret, 400 for a bad
 * body, otherwise 202 at once plus the work to run after the response has gone (pg_net waits
 * 2 seconds at most, a push service can take longer).
 */
export function handlePushWebhook(input: { authorization: string | null | undefined; body: unknown }, deps: PushWebhookDeps): { status: 401 | 400 | 202; work?: () => Promise<PushCounts | null> } {
  if (!isAuthorizedPushRequest(input.authorization, deps.secret)) return { status: 401 };
  const event = parsePushRequest(input.body);
  if (!event) return { status: 400 };
  return {
    status: 202,
    work: async () => {
      try {
        const counts = await deliverPush(await deps.loadDeliveries(event.kind, event.id), deps);
        deps.log(`push ${event.kind}: targets=${counts.targets} sent=${counts.sent} pruned=${counts.pruned} failed=${counts.failed} skipped=${counts.skipped}`);
        return counts;
      } catch {
        // Never the error itself: it could carry an endpoint or a name.
        deps.log(`push ${event.kind}: delivery failed`);
        return null;
      }
    },
  };
}

export const PUSH_REQUEST_MAX_BYTES = 256;

/** The body is exactly `{"kind": …, "id": …}`: a known kind, a UUID, nothing else, and small. */
export function parsePushRequest(raw: unknown): { kind: PushKind; id: string } | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > PUSH_REQUEST_MAX_BYTES) return null;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes('kind') || !keys.includes('id')) return null;
  const { kind, id } = body as { kind: unknown; id: unknown };
  return isPushKind(kind) && isUuid(id) ? { kind, id: id.toLowerCase() } : null;
}
