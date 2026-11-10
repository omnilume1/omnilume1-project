import { isUuid } from './message-limits';

// /messages?chat=<private_chat_id> and /messages?group=<group_id> open that thread
// directly (notification taps land here). Only a well-formed id is accepted, and it is
// then looked up in the member's own inbox, so a link to a thread they cannot see does nothing.
export type MessagesDeepLink = { kind: 'chat' | 'group'; id: string };

export function parseMessagesDeepLink(search: string): MessagesDeepLink | null {
  const params = new URLSearchParams(search);
  for (const kind of ['chat', 'group'] as const) {
    const values = params.getAll(kind);
    if (values.length === 1 && isUuid(values[0])) return { kind, id: values[0].toLowerCase() };
  }
  return null;
}

/**
 * The thread a deep link may open: only one that is already in this member's own inbox
 * (a friend or accepted contact with that private chat, or a group they belong to).
 * Anything else, including pending requests and other people's threads, resolves to null.
 */
export function resolveMessagesDeepLink<Person extends { chat_id?: string | null }, Group extends { group_id: string }>(
  link: MessagesDeepLink,
  inbox: { friends: Person[]; general: Person[]; chatGroups: Group[] },
): { kind: 'group'; group: Group } | { kind: 'chat'; contact: Person; tab: 'personal' | 'general' } | null {
  if (link.kind === 'group') {
    const group = inbox.chatGroups.find((item) => item.group_id.toLowerCase() === link.id);
    return group ? { kind: 'group', group } : null;
  }
  const owns = (person: Person) => typeof person.chat_id === 'string' && person.chat_id.toLowerCase() === link.id;
  const friend = inbox.friends.find(owns);
  const contact = friend ?? inbox.general.find(owns);
  return contact ? { kind: 'chat', contact, tab: friend ? 'personal' : 'general' } : null;
}

export const messagesChatHref =(chatId: string) => `/messages?chat=${encodeURIComponent(chatId)}`;
export const messagesGroupHref = (groupId: string) => `/messages?group=${encodeURIComponent(groupId)}`;
