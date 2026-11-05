// Room chat model (Action 08): pure helpers for RoomChat and its tests.
// No imports, so the unit-test build can compile it on its own.

// Must match public.room_reaction_emojis() (migration 20261105180000).
export const ROOM_REACTION_EMOJIS = ['\u{1F44D}', '❤️', '\u{1F602}', '\u{1F389}', '\u{1F62E}', '\u{1F622}', '\u{1F525}', '\u{1F440}'] as const;
export const ROOM_REACTION_LABELS: Record<string, string> = {
  '\u{1F44D}': 'Thumbs up',
  '❤️': 'Heart',
  '\u{1F602}': 'Laughing',
  '\u{1F389}': 'Celebrate',
  '\u{1F62E}': 'Surprised',
  '\u{1F622}': 'Sad',
  '\u{1F525}': 'Fire',
  '\u{1F440}': 'Looking',
};
export const ROOM_PIN_LIMIT = 5;
export const ROOM_MESSAGE_COLUMNS = 'id, sender_id, content, is_deleted, created_at, edited_at, reply_to_id, pinned_at, pinned_by, reaction_summary';

export interface RoomChatMessage {
  id: string;
  sender_id: string;
  content: string | null;
  is_deleted?: boolean;
  created_at: string;
  edited_at?: string | null;
  reply_to_id?: string | null;
  pinned_at?: string | null;
  pinned_by?: string | null;
  reaction_summary?: Record<string, unknown> | null;
}

export interface MemberIdentity {
  user_id: string;
  username: string | null;
  account_display_name: string | null;
  room_display_name: string | null;
}

export type ReactionChip = { emoji: string; label: string; count: number; mine: boolean };

export function isGifContent(content: string | null | undefined) {
  return typeof content === 'string' && content.startsWith('[gif:');
}

export function memberLabel(identity: MemberIdentity | null | undefined, fallback = 'Member') {
  return identity?.room_display_name?.trim()
    || identity?.account_display_name?.trim()
    || (identity?.username ? `@${identity.username}` : fallback);
}

// Reaction chips in the fixed emoji order. The server stores
// {"<emoji>": {"count": n, "users": [first 50 ids]}}.
export function reactionChips(summary: unknown, currentUserId: string | null): ReactionChip[] {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return [];
  const chips: ReactionChip[] = [];
  for (const emoji of ROOM_REACTION_EMOJIS) {
    const entry = (summary as Record<string, unknown>)[emoji];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const count = Number((entry as { count?: unknown }).count);
    if (!Number.isFinite(count) || count < 1) continue;
    const rawUsers = (entry as { users?: unknown }).users;
    const users = Array.isArray(rawUsers) ? rawUsers.filter((value): value is string => typeof value === 'string') : [];
    chips.push({ emoji, label: ROOM_REACTION_LABELS[emoji] ?? emoji, count: Math.floor(count), mine: Boolean(currentUserId && users.includes(currentUserId)) });
  }
  return chips;
}

// Same token rule as the database mention trigger.
const MENTION_PATTERN = /(^|[^A-Za-z0-9_.@])@([A-Za-z0-9][A-Za-z0-9_.]{2,29})/g;

export type MessageSegment =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; text: string; userId: string; isMe: boolean };

// Splits a message into text and @mentions. Only usernames of room members
// become mentions, matching who the server notifies.
export function messageSegments(content: string, members: MemberIdentity[], currentUserId: string | null): MessageSegment[] {
  const byUsername = new Map<string, MemberIdentity>();
  for (const member of members) if (member.username) byUsername.set(member.username.toLowerCase(), member);
  const segments: MessageSegment[] = [];
  let last = 0;
  for (const match of content.matchAll(MENTION_PATTERN)) {
    let token = match[2];
    let member = byUsername.get(token.toLowerCase());
    if (!member && token.endsWith('.')) {
      const trimmed = token.replace(/\.+$/, '');
      member = byUsername.get(trimmed.toLowerCase());
      if (member) token = trimmed;
    }
    if (!member) continue;
    const start = (match.index ?? 0) + match[1].length;
    if (start > last) segments.push({ kind: 'text', text: content.slice(last, start) });
    segments.push({ kind: 'mention', text: `@${token}`, userId: member.user_id, isMe: member.user_id === currentUserId });
    last = start + 1 + token.length;
  }
  if (last < content.length) segments.push({ kind: 'text', text: content.slice(last) });
  return segments;
}

// The "@query" being typed right before the caret, if any.
export function activeMentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const match = /(^|[^A-Za-z0-9_.@])@([A-Za-z0-9_.]{0,30})$/.exec(before);
  if (!match) return null;
  return { start: before.length - match[2].length - 1, query: match[2].toLowerCase() };
}

export function mentionSuggestions(members: MemberIdentity[], query: string, currentUserId: string | null, limit = 6) {
  const needle = query.toLowerCase();
  return members
    .filter((member) => member.username && member.user_id !== currentUserId)
    .filter((member) => !needle
      || member.username!.toLowerCase().startsWith(needle)
      || memberLabel(member).toLowerCase().includes(needle))
    .sort((left, right) => {
      const leftPrefix = left.username!.toLowerCase().startsWith(needle) ? 0 : 1;
      const rightPrefix = right.username!.toLowerCase().startsWith(needle) ? 0 : 1;
      return leftPrefix - rightPrefix || left.username!.localeCompare(right.username!);
    })
    .slice(0, limit);
}

export function insertMention(text: string, start: number, caret: number, username: string) {
  const next = `${text.slice(0, start)}@${username} ${text.slice(caret)}`;
  return { text: next, caret: start + username.length + 2 };
}

// The first message that arrived after the last visit, not sent by me.
// No divider on a first visit (nothing was read before).
export function firstUnreadMessageId(messages: RoomChatMessage[], lastReadAt: string | null, currentUserId: string | null) {
  if (!lastReadAt) return null;
  const readTime = Date.parse(lastReadAt);
  if (!Number.isFinite(readTime)) return null;
  return messages.find((message) => message.sender_id !== currentUserId
    && !message.is_deleted
    && Date.parse(message.created_at) > readTime)?.id ?? null;
}

export function replyPreview(message: RoomChatMessage | null | undefined) {
  if (!message) return 'Original message';
  if (message.is_deleted) return 'Deleted message';
  if (isGifContent(message.content)) return 'GIF';
  const text = (message.content ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 90 ? `${text.slice(0, 89)}…` : text || 'Message';
}

export function canEditMessage(message: RoomChatMessage, currentUserId: string | null) {
  return Boolean(currentUserId) && message.sender_id === currentUserId && !message.is_deleted && !isGifContent(message.content);
}

// Pinned messages, newest pin first, at most the room limit.
export function pinnedMessages(messages: Iterable<RoomChatMessage>) {
  return [...messages]
    .filter((message) => message.pinned_at && !message.is_deleted)
    .sort((left, right) => (right.pinned_at ?? '').localeCompare(left.pinned_at ?? ''))
    .slice(0, ROOM_PIN_LIMIT);
}

export function unreadBadge(count: number) {
  if (!Number.isFinite(count) || count <= 0) return '';
  return count >= 100 ? '99+' : String(Math.floor(count));
}
