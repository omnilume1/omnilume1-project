'use server';

import { createClient } from '@/utils/supabase/server';
import { assertActiveRoom } from '@/lib/room-lifecycle';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string) {
  if (!UUID_PATTERN.test(value)) throw new Error(`Invalid ${label}.`);
}
// The private key never leaves the browser. Only the public half is stored so
// another user can derive the same shared key locally.
export async function saveUserPublicKey(publicKey: string) {
  if (!publicKey || publicKey.length > 16_384) throw new Error('Invalid public key.');

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error('Unauthorized');

  const [{ data: profile, error: profileError }, { data: legacyKey, error: legacyError }] = await Promise.all([
    supabase
      .from('profiles')
      .select('public_key')
      .eq('id', user.id)
      .maybeSingle(),
    supabase
      .from('user_keys')
      .select('public_key')
      .eq('user_id', user.id)
      .maybeSingle(),
  ]);
  if (profileError) throw new Error(profileError.message);
  if (legacyError) throw new Error(legacyError.message);

  if (profile?.public_key && legacyKey?.public_key && profile.public_key !== legacyKey.public_key) {
    throw new Error('Secure messaging identity is inconsistent on the server.');
  }

  const storedPublicKey = profile?.public_key ?? legacyKey?.public_key ?? null;
  if (storedPublicKey && storedPublicKey !== publicKey) {
    throw new Error('Secure messaging identity already exists on another device.');
  }

  if (profile?.public_key !== publicKey) {
    const { error: profileUpdateError } = await supabase
      .from('profiles')
      .upsert({ id: user.id, public_key: publicKey }, { onConflict: 'id' });
    if (profileUpdateError) throw new Error(profileUpdateError.message);
  }

  if (legacyKey?.public_key !== publicKey) {
    const { error: keyError } = await supabase
      .from('user_keys')
      .upsert(
        { user_id: user.id, public_key: publicKey, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' },
      );
    if (keyError) throw new Error(keyError.message);
  }
  return true;
}

export async function getUserPublicKey(userId: string) {
  assertUuid(userId, 'user ID');

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error('Unauthorized');

  const [{ data: profile, error: profileError }, { data: legacyKey, error: legacyError }] = await Promise.all([
    supabase
      .from('profiles')
      .select('public_key')
      .eq('id', userId)
      .maybeSingle(),
    supabase
      .from('user_keys')
      .select('public_key')
      .eq('user_id', userId)
      .maybeSingle(),
  ]);

  if (profileError) throw new Error(profileError.message);
  if (legacyError) throw new Error(legacyError.message);
  if (profile?.public_key && legacyKey?.public_key && profile.public_key !== legacyKey.public_key) {
    throw new Error('Peer secure messaging identity is inconsistent on the server.');
  }

  // Keep compatibility with accounts created before profiles gained the key.
  return profile?.public_key ?? legacyKey?.public_key ?? null;
}

export async function getOrCreatePrivateChat(friendId: string) {
  assertUuid(friendId, 'friend ID');

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error('Unauthorized');
  if (user.id === friendId) throw new Error('You cannot start a secure chat with yourself.');

  const { data: existing, error: fetchError } = await supabase
    .from('private_chats')
    .select('id')
    .or(
      `and(user_one.eq.${user.id},user_two.eq.${friendId}),and(user_one.eq.${friendId},user_two.eq.${user.id})`,
    )
    .maybeSingle();
  if (fetchError) throw new Error(fetchError.message);
  if (existing) return existing.id;

  // New private chats require an accepted friendship or an accepted message
  // request. The database trigger on private_chats enforces the same rule;
  // this pre-check keeps the error friendly for the UI.
  const { data: isFriend, error: friendError } = await supabase.rpc('is_current_friend', {
    p_user_one: user.id,
    p_user_two: friendId,
  });
  if (friendError) throw new Error(friendError.message);
  if (!isFriend) {
    const { data: acceptedRequest, error: requestError } = await supabase
      .from('message_requests')
      .select('id')
      .or(
        `and(requester_id.eq.${user.id},recipient_id.eq.${friendId}),and(requester_id.eq.${friendId},recipient_id.eq.${user.id})`,
      )
      .eq('status', 'accepted')
      .maybeSingle();
    if (requestError) throw new Error(requestError.message);
    if (!acceptedRequest) {
      throw new Error('You can only start a secure chat with an accepted friend or an accepted message request.');
    }
  }

  const { data: chat, error: insertError } = await supabase
    .from('private_chats')
    .insert({ user_one: user.id, user_two: friendId })
    .select('id')
    .single();

  // A unique pair constraint can race when both users start the chat at once.
  if (insertError) {
    const { data: racedChat } = await supabase
      .from('private_chats')
      .select('id')
      .or(
        `and(user_one.eq.${user.id},user_two.eq.${friendId}),and(user_one.eq.${friendId},user_two.eq.${user.id})`,
      )
      .maybeSingle();
    if (racedChat) return racedChat.id;
    throw new Error(insertError.message);
  }

  return chat.id;
}

export async function sendEncryptedMessage({
  chatId,
  receiverId,
  ciphertext,
  iv,
}: {
  chatId: string;
  receiverId: string;
  ciphertext: string;
  iv: string;
}) {
  assertUuid(chatId, 'chat ID');
  assertUuid(receiverId, 'receiver ID');
  if (!ciphertext || !iv) throw new Error('Encrypted message is incomplete.');

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error('Unauthorized');

  const { data: chat, error: chatError } = await supabase
    .from('private_chats')
    .select('user_one, user_two')
    .eq('id', chatId)
    .maybeSingle();
  if (chatError) throw new Error(chatError.message);
  if (!chat || (chat.user_one !== user.id && chat.user_two !== user.id)) {
    throw new Error('You are not a participant in this chat.');
  }

  const expectedReceiver = chat.user_one === user.id ? chat.user_two : chat.user_one;
  if (expectedReceiver !== receiverId) throw new Error('Invalid chat recipient.');

  // The messages INSERT policy is the authorization source of truth for the
  // friendship/request relationship. Keeping that check in the same database
  // operation removes two round trips without creating a client-side bypass.
  const { error } = await supabase.from('messages').insert({
    chat_id: chatId,
    sender_id: user.id,
    receiver_id: receiverId,
    ciphertext,
    iv,
  });
  if (error) {
    if (error.code === '42501' || error.message.toLowerCase().includes('row-level security')) {
      throw new Error('This secure chat is not authorized for new messages.');
    }
    throw new Error(error.message);
  }

  return true;
}

export async function deleteMessageForEveryone(messageId: string, roomId: string) {
  try {
    assertUuid(messageId, 'message ID');
    assertUuid(roomId, 'room ID');

    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) throw new Error("Unauthorized");
    await assertActiveRoom(supabase, roomId);

    const { data: canChat, error: capabilityError } = await supabase.rpc('room_has_capability', {
      p_room_id: roomId,
      p_user_id: user.id,
      p_capability: 'chat',
    });
    if (capabilityError) throw new Error(capabilityError.message);
    if (!canChat) throw new Error('You do not have permission to use chat in this room.');

    const { data: membership, error: membershipError } = await supabase
      .from('room_members')
      .select('room_id')
      .eq('room_id', roomId)
      .eq('user_id', user.id)
      .eq('join_status', 'approved')
      .maybeSingle();

    if (membershipError) throw new Error(membershipError.message);
    if (!membership) throw new Error('Unauthorized');

    const { data, error } = await supabase
      .from('messages')
      .update({
        is_deleted: true,
        content: '🚫 This message was deleted',
        file_url: null
      })
      .eq('id', messageId)
      .eq('room_id', roomId)
      .eq('sender_id', user.id)
      .eq('is_deleted', false)
      .select('id')
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) throw new Error('Message not found or you are not allowed to delete it.');

    return { success: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '';
    const safeError = message === 'This room has expired and is no longer active.'
      ? message
      : 'Unable to delete message.';
    return { success: false, error: safeError };
  }
}
