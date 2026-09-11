'use server';

import { createClient } from '@/utils/supabase/server';

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
}

export interface MessageInbox {
  friends: InboxPerson[];
  groups: InboxGroup[];
  general: InboxGeneralContact[];
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

export async function getMyMessageInbox(): Promise<MessageInbox> {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error('Unauthorized');

  const [friendshipsRes, chatsRes, requestsRes, followersRes, followingRes] = await Promise.all([
    supabase
      .from('friendships')
      .select('user_one, user_two, created_at')
      .or(`user_one.eq.${user.id},user_two.eq.${user.id}`)
      .order('created_at', { ascending: false }),
    supabase
      .from('private_chats')
      .select('id, user_one, user_two, created_at')
      .or(`user_one.eq.${user.id},user_two.eq.${user.id}`),
    supabase
      .from('message_requests')
      .select('id, requester_id, recipient_id, message, status, created_at, responded_at')
      .or(`requester_id.eq.${user.id},recipient_id.eq.${user.id}`),
    supabase.rpc('get_profile_followers', { p_profile_id: user.id }),
    supabase.rpc('get_profile_following', { p_profile_id: user.id }),
  ]);

  const unavoidableErrors = [friendshipsRes, chatsRes, followersRes, followingRes].map((result) => result.error);
  if (unavoidableErrors.some(Boolean)) throw new Error('Unable to load your message inbox.');

  const friendshipRows = (friendshipsRes.data ?? []) as Array<{ user_one: string; user_two: string; created_at: string }>;
  const chatRows = (chatsRes.data ?? []) as Array<{ id: string; user_one: string; user_two: string; created_at: string }>;
  // Message requests are additive-only in this release: if the table does not
  // exist yet (migration pending), degrade to no requests instead of breaking
  // the whole inbox.
  const requestRows = requestsRes.error
    ? []
    : ((requestsRes.data ?? []) as RequestRow[]);

  const partnerIdOf = (row: { user_one: string; user_two: string }) =>
    row.user_one === user.id ? row.user_two : row.user_one;

  const friendIds = friendshipRows.map(partnerIdOf);
  const chatByPartner = new Map<string, { id: string; created_at: string }>();
  for (const chat of chatRows) {
    const partner = partnerIdOf(chat);
    const existing = chatByPartner.get(partner);
    if (!existing || chat.created_at > existing.created_at) {
      chatByPartner.set(partner, { id: chat.id, created_at: chat.created_at });
    }
  }
  const chatPartnerIds = Array.from(chatByPartner.keys());
  const requestPartnerIds = Array.from(new Set(requestRows.map((request) =>
    request.requester_id === user.id ? request.recipient_id : request.requester_id,
  )));
  const acceptedRequestPartnerIds = new Set(
    requestRows
      .filter((request) => request.status === 'accepted')
      .map((request) => request.requester_id === user.id ? request.recipient_id : request.requester_id),
  );
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
    [...friendIds, ...chatPartnerIds, ...requestPartnerIds]
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
    const canUsePrivateChat = friendIds.includes(id) || acceptedRequestPartnerIds.has(id);
    return {
      user_id: id,
      display_name: profile.display_name,
      username: profile.username,
      avatar_url: profile.avatar_url,
      // A historical chat row is not, by itself, permission to open an active
      // conversation. Keep it available only while the relationship that
      // authorized the chat is still accepted.
      chat_id: canUsePrivateChat ? chatByPartner.get(id)?.id ?? null : null,
      has_public_key: hasPublicKey.has(id),
    };
  };

  // Personal is derived from current relationship authorization. Historical
  // private_chats rows remain in the database, but cannot keep a removed friend
  // visible in the active Personal list.
  const personalIds = new Set<string>();
  for (const id of friendIds) if (id !== user.id) personalIds.add(id);
  for (const id of acceptedRequestPartnerIds) if (id !== user.id) personalIds.add(id);

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
  for (const id of personalIds) generalIds.delete(id);

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

  const general = Array.from(generalIds)
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
    if (!room) return null;
    return {
      room_id: room.id,
      name: room.name,
      username: room.username,
      description: room.description,
      role: membership.role,
    };
  }).filter((group): group is InboxGroup => group !== null);

  return { friends, groups, general };
}

export async function sendMessageRequest(recipientId: string, message: string) {
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

export async function acceptMessageRequest(requestId: string) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error('Unauthorized');

  const { data, error } = await supabase.rpc('accept_message_request', {
    p_request_id: requestId,
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function rejectMessageRequest(requestId: string) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error('Unauthorized');

  const { data, error } = await supabase.rpc('reject_message_request', {
    p_request_id: requestId,
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function cancelMessageRequest(requestId: string) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error('Unauthorized');

  const { data, error } = await supabase.rpc('cancel_message_request', {
    p_request_id: requestId,
  });
  if (error) throw new Error(error.message);
  return data;
}
