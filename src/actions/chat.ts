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

  const { error: profileError } = await supabase
    .from('profiles')
    .upsert({ id: user.id, public_key: publicKey }, { onConflict: 'id' });
  if (profileError) throw new Error(profileError.message);

  const { error: keyError } = await supabase
    .from('user_keys')
    .upsert(
      { user_id: user.id, public_key: publicKey, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' },
    );
  if (keyError) throw new Error(keyError.message);
  return true;
}

export async function getUserPublicKey(userId: string) {
  assertUuid(userId, 'user ID');

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error('Unauthorized');

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('public_key')
    .eq('id', userId)
    .maybeSingle();

  if (profileError) throw new Error(profileError.message);
  if (profile?.public_key) return profile.public_key;

  // Keep compatibility with accounts created before profiles gained the key.
  const { data: legacyKey, error: legacyError } = await supabase
    .from('user_keys')
    .select('public_key')
    .eq('user_id', userId)
    .maybeSingle();
  if (legacyError) throw new Error(legacyError.message);
  return legacyKey?.public_key ?? null;
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

  const { error } = await supabase.from('messages').insert({
    chat_id: chatId,
    sender_id: user.id,
    receiver_id: receiverId,
    ciphertext,
    iv,
  });
  if (error) throw new Error(error.message);

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
