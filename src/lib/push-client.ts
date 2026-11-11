import { createClient } from '@/utils/supabase/client';
import { isAllowedPushEndpoint, isValidPushKeys, toBase64Url } from '@/lib/push-endpoint';

// Push notifications in the browser and the installed Android app. Permission is only ever
// asked from a tap (Settings, or the row in the notification bell). The subscription is
// saved through the save_push_subscription RPC with the member's own session.

const ENABLED_KEY = 'omnilume:push-enabled';
const SAVED_AT_KEY = 'omnilume:push-saved-at';
export const PUSH_PROMPT_DISMISSED_KEY = 'omnilume:push-prompt-dismissed';
const DAY_MS = 24 * 60 * 60 * 1000;
const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '';

export type PushState = 'unsupported' | 'denied' | 'off' | 'on';
export type PushEnableResult = { ok: true } | { ok: false; reason: 'unsupported' | 'denied' | 'dismissed' | 'failed' };

const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string | null) => { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* private mode */ } };

/** False until the VAPID public key is set for the deployment: the feature then shows nothing at all. */
export const pushConfigured = VAPID_PUBLIC_KEY.length > 0;

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && VAPID_PUBLIC_KEY.length > 0;
}

/** Whether to offer the one-time "get notified" row: never asked, never dismissed. */
export function shouldOfferPush(): boolean {
  return pushSupported() && Notification.permission === 'default' && read(PUSH_PROMPT_DISMISSED_KEY) === null;
}
export const dismissPushOffer = () => write(PUSH_PROMPT_DISMISSED_KEY, '1');

async function registration(): Promise<ServiceWorkerRegistration | null> {
  // The worker is only registered in production builds (ServiceWorkerRegistration.tsx).
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

function serverKey(): Uint8Array<ArrayBuffer> {
  const base64 = VAPID_PUBLIC_KEY.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(VAPID_PUBLIC_KEY.length / 4) * 4, '=');
  const bytes = atob(base64);
  const key = new Uint8Array(new ArrayBuffer(bytes.length));
  for (let index = 0; index < bytes.length; index += 1) key[index] = bytes.charCodeAt(index);
  return key;
}

async function save(subscription: PushSubscription): Promise<boolean> {
  const json = subscription.toJSON();
  const p256dh = toBase64Url(json.keys?.p256dh ?? '');
  const auth = toBase64Url(json.keys?.auth ?? '');
  if (!isAllowedPushEndpoint(subscription.endpoint) || !isValidPushKeys(p256dh, auth)) return false;
  const { error } = await createClient().rpc('save_push_subscription', { p_endpoint: subscription.endpoint, p_p256dh: p256dh, p_auth: auth });
  if (error) return false;
  write(SAVED_AT_KEY, String(Date.now()));
  return true;
}

export async function getPushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted' || read(ENABLED_KEY) !== '1') return 'off';
  try {
    return (await (await registration())?.pushManager.getSubscription()) ? 'on' : 'off';
  } catch {
    return 'off';
  }
}

/** Call from a tap only: this is where the browser's permission question appears. */
export async function enablePush(): Promise<PushEnableResult> {
  if (!pushSupported()) return { ok: false, reason: 'unsupported' };
  try {
    const permission = await Notification.requestPermission();
    if (permission === 'denied') return { ok: false, reason: 'denied' };
    if (permission !== 'granted') return { ok: false, reason: 'dismissed' };
    const worker = await registration();
    if (!worker) return { ok: false, reason: 'unsupported' };
    const subscription = (await worker.pushManager.getSubscription()) ?? await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey() });
    if (!(await save(subscription))) {
      await subscription.unsubscribe().catch(() => undefined);
      return { ok: false, reason: 'failed' };
    }
    write(ENABLED_KEY, '1');
    return { ok: true };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/** Turns pushes off for this device. Also runs before every sign-out, so it never throws and never waits long. */
export async function disablePush(): Promise<void> {
  write(ENABLED_KEY, null);
  write(SAVED_AT_KEY, null);
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  const work = (async () => {
    const subscription = await (await registration())?.pushManager.getSubscription();
    if (!subscription) return;
    // Supabase builders are lazy: the request is only sent when awaited.
    await createClient().rpc('remove_push_subscription', { p_endpoint: subscription.endpoint });
    await subscription.unsubscribe();
  })().catch(() => undefined);
  await Promise.race([work, new Promise<void>((resolve) => setTimeout(resolve, 2500))]);
}

/**
 * On app open, at most once a day: re-saves the subscription (keeps last_seen_at fresh) and
 * subscribes again if the browser replaced or dropped it. Never asks for permission.
 */
export async function refreshPush(): Promise<void> {
  try {
    if (!pushSupported() || Notification.permission !== 'granted' || read(ENABLED_KEY) !== '1') return;
    if (Date.now() - Number(read(SAVED_AT_KEY) ?? 0) < DAY_MS) return;
    const { data } = await createClient().auth.getUser();
    if (!data.user) return;
    const worker = await registration();
    if (!worker) return;
    const subscription = (await worker.pushManager.getSubscription()) ?? await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey() });
    await save(subscription);
  } catch {
    // Tried again on the next open.
  }
}

/** Closes the notifications for a thread or room the person has just opened (`dm:<id>`, `group:<id>`, `room:<id>:`). */
export async function clearPushNotifications(tagPrefix: string): Promise<void> {
  try {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
    const shown = await (await registration())?.getNotifications();
    shown?.filter((item) => item.tag === tagPrefix || (tagPrefix.endsWith(':') && item.tag.startsWith(tagPrefix))).forEach((item) => item.close());
  } catch {
    // Nothing to clear.
  }
}
