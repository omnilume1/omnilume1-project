export const ROOM_MESSAGE_MAX_CHARS = 2_000;
export const PRIVATE_MESSAGE_MAX_CHARS = 4_000;
export const PRIVATE_IV_BASE64_CHARS = 16;
export const PRIVATE_CIPHERTEXT_MIN_CHARS = 24;
export const PRIVATE_CIPHERTEXT_MAX_CHARS = 32_768;

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO_TIMESTAMP_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

export function characterLength(value: string) {
  return Array.from(value).length;
}

export function isValidRoomMessageContent(value: string) {
  const trimmed = value.trim();
  return characterLength(trimmed) >= 1 && characterLength(trimmed) <= ROOM_MESSAGE_MAX_CHARS;
}

export function isValidEncryptedPayload(ciphertext: unknown, iv: unknown) {
  if (typeof ciphertext !== 'string' || typeof iv !== 'string') return false;
  return ciphertext.length >= PRIVATE_CIPHERTEXT_MIN_CHARS
    && ciphertext.length <= PRIVATE_CIPHERTEXT_MAX_CHARS
    && ciphertext.length % 4 === 0
    && BASE64_PATTERN.test(ciphertext)
    && iv.length === PRIVATE_IV_BASE64_CHARS
    && BASE64_PATTERN.test(iv);
}

export function assertEncryptedPayload(ciphertext: unknown, iv: unknown) {
  if (!isValidEncryptedPayload(ciphertext, iv)) {
    throw new Error('Encrypted message payload is invalid or too large.');
  }
}
