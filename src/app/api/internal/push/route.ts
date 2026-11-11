import { after, NextResponse } from 'next/server';
import { sendNotification } from 'web-push';
import { handlePushWebhook, PUSH_REQUEST_MAX_BYTES } from '@/lib/push-request';
import { createAdminClient } from '@/utils/supabase/admin';

// Postgres calls this (pg_net, see the push_notifications migration) with {"kind", "id"} for
// every new room notification, direct message and group message. It answers 202 at once and
// sends the Web Push notifications after the response. Only POST exists; anything else is 405.
export const runtime = 'nodejs';

export async function POST(request: Request) {
  // Refuse an oversized body before reading it.
  const declared = Number(request.headers.get('content-length') ?? '0');
  const body = Number.isFinite(declared) && declared <= PUSH_REQUEST_MAX_BYTES ? await request.text().catch(() => '') : '';
  const subject = process.env.VAPID_SUBJECT;
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;

  const result = handlePushWebhook({ authorization: request.headers.get('authorization'), body }, {
    secret: process.env.PUSH_WEBHOOK_SECRET,
    loadDeliveries: async (kind, id) => {
      if (!subject || !publicKey || !privateKey) throw new Error('VAPID keys are not configured.');
      const { data, error } = await createAdminClient().rpc('push_deliveries', { p_kind: kind, p_id: id });
      if (error) throw new Error('push_deliveries failed.');
      return data;
    },
    send: (subscription, payload, options) => sendNotification(subscription, payload, { ...options, vapidDetails: { subject: subject!, publicKey: publicKey!, privateKey: privateKey! } }),
    prune: async (endpoint) => {
      const { error } = await createAdminClient().rpc('prune_push_subscription', { p_endpoint: endpoint });
      if (error) throw new Error('prune_push_subscription failed.');
    },
    log: (line) => console.info(`[push] ${line}`),
  });

  if (result.work) after(result.work);
  return NextResponse.json(result.status === 202 ? { accepted: true } : { error: result.status === 401 ? 'Unauthorized.' : 'Invalid request.' }, { status: result.status });
}
