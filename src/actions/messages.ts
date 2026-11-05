'use server';

import { actionResult } from '@/lib/action-result';
import { createClient } from '@/utils/supabase/server';
import { isPendingRequestContact } from '@/lib/conversation-model';

export type MessageRequestStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled';

export interface InboxRequestInfo {
  id: string;
  direction: 'incoming' | 'outgoing';
  status: MessageRequestStatus;
  message: string;
  created_at: string;
  responded_at: string | null;
}

export interface InboxPerson {
  user_id: string;
  display_name: string | null;
  username: string | null;
  avatar_url: string | null;
  chat_id: string | null;
  has_public_key: boolean;
  // Unread messages from the other participant (capped at 100 server-side).
  unread_count?: number;
}

export interface InboxGeneralContact extends InboxPerson {
  request: InboxRequestInfo | null;
}

export interface InboxGroup {
  room_id: string;
  name: string;
  username: string | null;
  description: string | null;
  role: string;
  // Unread room messages since this member last read the chat (capped at
  // 100 by get_room_unread_counts; 0 when chat is unavailable).
  unread_count: number;
}

// Action 14 group: messages are plaintext protected by RLS (see migration
// 20261109100000), never mixed with room messages or room keys.
export interface InboxChatGroup {
  group_id: string;
  name: string;
  role: string;
  unread_count: number;
  last_message_at: string | null;
}

export interface MessageInbox {
  // Personal: accepted friends only.
  friends: InboxPerson[];
  // Legacy group rooms (links to the room; room chat stays in the room).
  groups: InboxGroup[];
  chatGroups: InboxChatGroup[];
  // General: follow connections and accepted-request conversations.
  general: InboxGeneralContact[];
  // Pending message requests, both directions.
  requests: InboxGeneralContact[];
  blocked: InboxPerson[];
}

interface ConversationRow {
  conversation_id: string;
  conversation_type: 'personal' | 'general' | 'group';
  peer_id: string | null;
  title: string | null;
  role: string | null;
  last_message_at: string | null;
  unread_count: number;
}

interface ProfileRef {
  display_name: string | null;
  username: string | null;
  avatar_url: string | null;
}

interface RequestRow {
  id: string;
  requester_id: string;
  recipient_id: string;
  message: string;
  status: MessageRequestStatus;
  created_at: string;
  responded_at: string | null;
}

function displayName(profile: ProfileRef) {
  return profile.display_name || profile.username || 'OmniLume member';
}

async function getMyMessageInboxImpl(): Promise<MessageInbox> {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error('Unauthorized');

  const [friendshipsRes, conversationsRes, requestsRes, followersRes, followingRes, blocksRes] = await Promise.all([
    supabase
      .from('friendships')
      .select('user_one, user_two, created_at')
      .or(`user_one.eq.${user.id},user_two.eq.${user.id}`)
      .order('created_at', { ascending: false }),
    // One row per conversation the caller may currently use, with its single
    // type (personal | general | group) derived server-side.
    supabase.rpc('get_my_conversations'),
    supabase
      .from('message_requests')
      .select('id, requester_id, recipient_id, message, status, created_at, responded_at')
      .or(`requester_id.eq.${user.id},recipient_id.eq.${user.id}`),
    supabase.rpc('get_profile_followers', { p_profile_id: user.id }),
    supabase.rpc('get_profile_following', { p_profile_id: user.id }),
    supabase.from('user_blocks').select('blocked_id'),
  ]);

  const unavoidableErrors = [friendshipsRes, conversationsRes, followersRes, followingRes, blocksRes].map((result) => result.error);
  if (unavoidableErrors.some(Boolean)) throw new Error('Unable to load your message inbox.');

  const friendshipRows = (friendshipsRes.data ?? []) as Array<{ user_one: string; user_two: string; created_at: string }>;
  const conversationRows = (conversationsRes.data ?? []) as ConversationRow[];
  const blockedIds = new Set(((blocksRes.data ?? []) as Array<{ blocked_id: string }>).map((row) => row.blocked_id));
  // Message requests are additive-only in this release: if the table does not
  // exist yet (migration pending), degrade to no requests instead of breaking
  // the whole inbox.
  const requestRows = requestsRes.error
    ? []
    : ((requestsRes.data ?? []) as RequestRow[]);

  const partnerIdOf = (row: { user_one: string; user_two: string }) =>
    row.user_one === user.id ? row.user_two : row.user_one;

  const friendIds = friendshipRows.map(partnerIdOf).filter((id) => !blockedIds.has(id));
  // The pair index guarantees one private chat per pair, so one row per peer.
  const chatByPartner = new Map<string, ConversationRow>();
  for (const row of conversationRows) {
    if (row.peer_id && row.conversation_type !== 'group') chatByPartner.set(row.peer_id, row);
  }
  const chatPartnerIds = Array.from(chatByPartner.keys());
  const requestPartnerIds = Array.from(new Set(requestRows.map((request) =>
    request.requester_id === user.id ? request.recipient_id : request.requester_id,
  )));
  const connectionRows = [
    ...((followersRes.data ?? []) as Array<{ user_id: string; display_name: string | null; username: string | null; avatar_url: string | null }>),
    ...((followingRes.data ?? []) as Array<{ user_id: string; display_name: string | null; username: string | null; avatar_url: string | null }>),
  ];

  const profileById = new Map<string, ProfileRef>();
  for (const row of connectionRows) {
    if (!profileById.has(row.user_id)) {
      profileById.set(row.user_id, {
        display_name: row.display_name,
        username: row.username,
        avatar_url: row.avatar_url,
      });
    }
  }
  // Friends and request partners resolve from the safe public profile view when
  // they are not already part of the follow-connected lists.
  const missingIds = Array.from(new Set(
    [...friendIds, ...chatPartnerIds, ...requestPartnerIds, ...blockedIds]
      .filter((id) => !profileById.has(id))
      .filter((id) => id !== user.id),
  ));
  if (missingIds.length > 0) {
    const { data: publicProfiles, error: profileError } = await supabase
      .from('public_profiles')
      .select('id, username, display_name, avatar_url')
      .in('id', missingIds);
    if (!profileError && publicProfiles) {
      for (const profile of publicProfiles as Array<{ id: string; display_name: string | null; username: string | null; avatar_url: string | null }>) {
        if (!profileById.has(profile.id)) {
          profileById.set(profile.id, profile);
        }
      }
    }
  }

  const keyIds = Array.from(new Set([...friendIds, ...chatPartnerIds, ...requestPartnerIds]
    .filter((id) => id !== user.id)));
  const hasPublicKey = new Set<string>();
  if (keyIds.length > 0) {
    const { data: keyRows, error: keyError } = await supabase
      .from('user_keys')
      .select('user_id')
      .in('user_id', keyIds);
    if (!keyError && keyRows) {
      for (const keyRow of keyRows as Array<{ user_id: string }>) {
        hasPublicKey.add(keyRow.user_id);
      }
    }
  }

  const makePerson = (id: string): InboxPerson | null => {
    const profile = profileById.get(id);
    if (!profile) return null;
    const conversation = chatByPartner.get(id);
    return {
      user_id: id,
      display_name: profile.display_name,
      username: profile.username,
      avatar_url: profile.avatar_url,
      // get_my_conversations only returns chats with active access, so a
      // revoked (unfriended/blocked) chat never reopens from here.
      chat_id: conversation?.conversation_id ?? null,
      has_public_key: hasPublicKey.has(id),
      unread_count: conversation?.unread_count ?? 0,
    };
  };

  // Personal = accepted friends only. An accepted-request chat is General
  // until the pair become friends (the type is relabelled server-side).
  const personalIds = new Set<string>();
  for (const id of friendIds) if (id !== user.id) personalIds.add(id);

  const friends = Array.from(personalIds)
    .map(makePerson)
    .filter((person): person is InboxPerson => person !== null)
    .sort((left, right) => {
      const chatRank = Number(left.chat_id !== null) - Number(right.chat_id !== null);
      if (chatRank !== 0) return chatRank;
      return displayName(left).localeCompare(displayName(right));
    });

  // General = people connected through accepted follows (either direction)
  // plus message request partners; friends/personal chats are never duplicated.
  const generalIds = new Set<string>();
  for (const row of connectionRows) {
    if (row.user_id !== user.id) generalIds.add(row.user_id);
  }
  for (const id of requestPartnerIds) {
    if (id !== user.id) generalIds.add(id);
  }
  for (const id of chatPartnerIds) generalIds.add(id);
  for (const id of personalIds) generalIds.delete(id);
  for (const id of blockedIds) generalIds.delete(id);

  const latestRequestByPartner = new Map<string, InboxRequestInfo>();
  for (const request of requestRows) {
    const partner = request.requester_id === user.id ? request.recipient_id : request.requester_id;
    const existing = latestRequestByPartner.get(partner);
    if (!existing || request.created_at > existing.created_at) {
      latestRequestByPartner.set(partner, {
        id: request.id,
        direction: request.recipient_id === user.id ? 'incoming' : 'outgoing',
        status: request.status,
        message: request.message,
        created_at: request.created_at,
        responded_at: request.responded_at,
      });
    }
  }

  const contacts = Array.from(generalIds)
    .map((id): InboxGeneralContact | null => {
      const person = makePerson(id);
      if (!person) return null;
      return { ...person, request: latestRequestByPartner.get(id) ?? null };
    })
    .filter((contact): contact is InboxGeneralContact => contact !== null)
    .sort((left, right) => {
      const rank = (contact: InboxGeneralContact) => {
        if (contact.request?.status === 'pending' && contact.request.direction === 'incoming') return 0;
        if (contact.request?.status === 'pending') return 1;
        if (contact.chat_id !== null) return 2;
        return 3;
      };
      const rankDiff = rank(left) - rank(right);
      if (rankDiff !== 0) return rankDiff;
      return displayName(left).localeCompare(displayName(right));
    });

  const { data: joinedGroups, error: groupsError } = await supabase
    .from('room_members')
    .select('role, rooms!inner(id, name, username, description, is_group)')
    .eq('user_id', user.id)
    .eq('join_status', 'approved')
    .eq('rooms.is_group', true);
  if (groupsError) throw new Error('Unable to load your message groups.');
  // A room converted into an Action 14 group is listed once, as its group chat.
  const { data: convertedRows } = await supabase.from('groups').select('source_room_id');
  const convertedRoomIds = new Set(((convertedRows ?? []) as Array<{ source_room_id: string }>).map((row) => row.source_room_id));

  const groups: InboxGroup[] = ((joinedGroups ?? []) as Array<{
    role: string;
    rooms: {
      id: string;
      name: string;
      username: string | null;
      description: string | null;
      is_group: boolean;
    } | Array<{
      id: string;
      name: string;
      username: string | null;
      description: string | null;
      is_group: boolean;
    }>;
  }>).map((membership) => {
    // A to-one relationship returns a single object; keep compatibility with
    // the array shape some supabase-js versions produce for joins.
    const room = Array.isArray(membership.rooms) ? membership.rooms[0] : membership.rooms;
    if (!room || convertedRoomIds.has(room.id)) return null;
    return {
      room_id: room.id,
      name: room.name,
      username: room.username,
      description: room.description,
      role: membership.role,
      unread_count: 0,
    };
  }).filter((group): group is InboxGroup => group !== null);

  if (groups.length > 0) {
    const { data: unreadRows, error: unreadError } = await supabase.rpc('get_room_unread_counts', {
      p_room_ids: groups.slice(0, 200).map((group) => group.room_id),
    });
    if (!unreadError && Array.isArray(unreadRows)) {
      const unreadByRoom = new Map((unreadRows as Array<{ room_id: string; unread_count: number }>).map((row) => [row.room_id, Number(row.unread_count) || 0]));
      for (const group of groups) group.unread_count = unreadByRoom.get(group.room_id) ?? 0;
    }
  }

  const general = contacts.filter((contact) => !isPendingRequestContact(contact));
  const requests = contacts.filter(isPendingRequestContact);
  const chatGroups: InboxChatGroup[] = conversationRows
    .filter((row) => row.conversation_type === 'group')
    .map((row) => ({
      group_id: row.conversation_id,
      name: row.title ?? 'Group',
      role: row.role ?? 'member',
      unread_count: Number(row.unread_count) || 0,
      last_message_at: row.last_message_at,
    }))
    .sort((left, right) => (right.last_message_at ?? '').localeCompare(left.last_message_at ?? ''));
  // shortcut: public_profiles hides members with no remaining relationship, so
  // a blocked member may show as a generic name; add a blocked-list RPC if
  // members need to tell several blocked accounts apart.
  const blocked = Array.from(blockedIds).map((id): InboxPerson => makePerson(id) ?? {
    user_id: id, display_name: 'Blocked member', username: null, avatar_url: null, chat_id: null, has_public_key: false,
  });

  return { friends, groups, chatGroups, general, requests, blocked };
}
export async function getMyMessageInbox() {
  return actionResult(() => getMyMessageInboxImpl());
}

async function sendMessageRequestImpl(recipientId: string, message: string) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error('Unauthorized');

  const { data, error } = await supabase.rpc('send_message_request', {
    p_recipient_id: recipientId,
    p_message: message.trim(),
  });
  if (error) throw new Error(error.message);
  return data;
}
export async function sendMessageRequest(recipientId: string, message: string) {
  return actionResult(() => sendMessageRequestImpl(recipientId, message));
}

async function acceptMessageRequestImpl(requestId: string) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error('Unauthorized');

  const { data, error } = await supabase.rpc('accept_message_request', {
    p_request_id: requestId,
  });
  if (error) throw new Error(error.message);
  return data;
}
export async function acceptMessageRequest(requestId: string) {
  return actionResult(() => acceptMessageRequestImpl(requestId));
}

async function rejectMessageRequestImpl(requestId: string) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error('Unauthorized');

  const { data, error } = await supabase.rpc('reject_message_request', {
    p_request_id: requestId,
  });
  if (error) throw new Error(error.message);
  return data;
}
export async function rejectMessageRequest(requestId: string) {
  return actionResult(() => rejectMessageRequestImpl(requestId));
}

async function cancelMessageRequestImpl(requestId: string) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error('Unauthorized');

  const { data, error } = await supabase.rpc('cancel_message_request', {
    p_request_id: requestId,
  });
  if (error) throw new Error(error.message);
  return data;
}
export async function cancelMessageRequest(requestId: string) {
  return actionResult(() => cancelMessageRequestImpl(requestId));
}

// ---------------------------------------------------------------------------
// Action 15: block, read state and group conversations. Authorization lives in
// the RPCs and RLS (migration 20261109100000); these only validate shape.
// ---------------------------------------------------------------------------
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GROUP_MESSAGE_MAX_CHARS = 4000;

async function callConversationRpc(name: string, args: Record<string, string>) {
  for (const value of Object.values(args)) {
    if (!UUID_PATTERN.test(value)) throw new Error('Invalid conversation reference.');
  }
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error('Unauthorized');
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.code === '42501' ? 'You no longer have access to this conversation.' : error.message);
  return data as boolean;
}

export async function blockUser(userId: string) {
  return actionResult(() => callConversationRpc('block_user', { p_user_id: userId }));
}
export async function unblockUser(userId: string) {
  return actionResult(() => callConversationRpc('unblock_user', { p_user_id: userId }));
}
export async function markConversationRead(conversationId: string) {
  return actionResult(() => callConversationRpc('mark_conversation_read', { p_conversation_id: conversationId }));
}
export async function leaveGroup(groupId: string) {
  return actionResult(() => callConversationRpc('leave_group', { p_group_id: groupId }));
}
export async function removeGroupMember(groupId: string, userId: string) {
  return actionResult(() => callConversationRpc('remove_group_member', { p_group_id: groupId, p_user_id: userId }));
}

async function sendGroupMessageImpl(groupId: string, content: string) {
  if (!UUID_PATTERN.test(groupId)) throw new Error('Invalid conversation reference.');
  const text = typeof content === 'string' ? content.trim() : '';
  if (text.length < 1 || text.length > GROUP_MESSAGE_MAX_CHARS) {
    throw new Error(`Messages must be 1-${GROUP_MESSAGE_MAX_CHARS} characters.`);
  }
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error('Unauthorized');
  const { data, error } = await supabase
    .from('group_messages')
    .insert({ group_id: groupId, sender_id: user.id, content: text })
    .select('id, sender_id, content, created_at')
    .single();
  if (error) throw new Error(error.code === '42501' ? 'You are no longer a member of this group.' : error.message);
  return data as { id: string; sender_id: string; content: string; created_at: string };
}
export async function sendGroupMessage(groupId: string, content: string) {
  return actionResult(() => sendGroupMessageImpl(groupId, content));
}
