import { isUuid } from './message-limits';
import { messagesChatHref, messagesGroupHref } from './messages-deep-link';
import { notificationHref } from './notification-center-model';

// What a push notification says. One pure function, so the privacy rules are testable:
// - a direct message shows the sender and "New message", never text (DMs are end-to-end encrypted);
// - a group message shows the group and the sender, never text (lock screens are public);
// - a room notification shows the room and the short server-written line the bell already shows.
// Only the named fields below are ever read, so nothing else in a delivery row can leak into a payload.

export type PushKind = 'room_notification' | 'dm' | 'group_message';
export const PUSH_KINDS: readonly PushKind[] = ['room_notification', 'dm', 'group_message'];
export const isPushKind = (value: unknown): value is PushKind => typeof value === 'string' && (PUSH_KINDS as readonly string[]).includes(value);

export interface PushPayload {
  title: string;
  body: string;
  /** Always a same-origin relative path. */
  url: string;
  /** Notifications with the same tag replace each other on the device. */
  tag: string;
  /** Seconds the push service keeps it for an offline device. */
  ttl: number;
  urgency: 'high' | 'normal';
}

const DAY = 24 * 60 * 60;
const HIGH_URGENCY_TYPES = new Set(['mention', 'reply', 'access', 'security', 'recovery_request', 'recovery_decision']);
const TTL_BY_TYPE: Record<string, number> = { timer: 10 * 60, room_event: 60 * 60 };
export const PUSH_BODY_MAX_CHARS = 140;
const LABEL_MAX_CHARS = 80;

const encoder = new TextEncoder();
// Control characters and the two Unicode line separators (built from code points, so no such character sits in this file).
const CONTROL_CHARACTERS = new RegExp(`[\\x00-\\x1f\\x7f${String.fromCharCode(0x2028, 0x2029)}]+`, 'g');
/** Single-line text, cut to a character and a byte budget, so a payload always stays under 1 KB. */
function clip(value: unknown, maxChars: number, maxBytes: number, fallback: string): string {
  const text = typeof value === 'string' ? value.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim() : '';
  if (!text) return fallback;
  let out = Array.from(text).slice(0, maxChars).join('');
  while (encoder.encode(out).length > maxBytes) out = Array.from(out).slice(0, -1).join('');
  return out.length < text.length ? `${out.replace(/\s+$/, '')}…` : out;
}

/** A path on this site and nothing else: no scheme, no `//host`, no backslash tricks. */
export function isSafeRelativeUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//') || /[\\\x00-\x20]/.test(url) || url.length > 300) return false;
  try {
    return new URL(url, 'https://omnilume.invalid').origin === 'https://omnilume.invalid';
  } catch {
    return false;
  }
}

function field(row: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(row, key) ? row[key] : undefined;
}

export function buildPushPayload(delivery: unknown): PushPayload | null {
  if (!delivery || typeof delivery !== 'object') return null;
  const row = delivery as Record<string, unknown>;
  const kind = field(row, 'kind');
  let payload: PushPayload | null = null;

  if (kind === 'dm') {
    const chatId = field(row, 'chat_id');
    if (!isUuid(chatId)) return null;
    payload = { title: clip(field(row, 'sender_label'), LABEL_MAX_CHARS, 200, 'OmniLume'), body: 'New message', url: messagesChatHref(chatId), tag: `dm:${chatId}`, ttl: DAY, urgency: 'high' };
  } else if (kind === 'group_message') {
    const groupId = field(row, 'group_id');
    if (!isUuid(groupId)) return null;
    const sender = clip(field(row, 'sender_label'), LABEL_MAX_CHARS, 200, 'Someone');
    payload = { title: clip(field(row, 'group_name'), LABEL_MAX_CHARS, 200, 'Group chat'), body: `${sender}: New message`, url: messagesGroupHref(groupId), tag: `group:${groupId}`, ttl: DAY, urgency: 'normal' };
  } else if (kind === 'room_notification') {
    const roomId = field(row, 'room_id');
    const type = field(row, 'notification_type');
    if (!isUuid(roomId) || typeof type !== 'string' || !/^[a-z_]{1,40}$/.test(type)) return null;
    const metadata = field(row, 'metadata');
    const entityId = field(row, 'entity_id');
    payload = {
      title: clip(field(row, 'room_name'), LABEL_MAX_CHARS, 200, 'OmniLume'),
      body: clip(field(row, 'message'), PUSH_BODY_MAX_CHARS, 420, 'New activity in your room'),
      url: notificationHref({ notification_type: type, room_id: roomId, entity_id: isUuid(entityId) ? entityId : null, metadata: metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : null }),
      tag: `room:${roomId}:${type}`,
      ttl: TTL_BY_TYPE[type] ?? DAY,
      urgency: HIGH_URGENCY_TYPES.has(type) ? 'high' : 'normal',
    };
  }
  return payload && isSafeRelativeUrl(payload.url) ? payload : null;
}

/** What the device receives: only what the service worker needs to show and open the notification. */
export function pushPayloadJson(payload: PushPayload): string {
  return JSON.stringify({ title: payload.title, body: payload.body, url: payload.url, tag: payload.tag });
}
