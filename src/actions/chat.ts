'use server';

import { createClient } from '@/utils/supabase/server';

// 1. Publish the caller's E2EE public key (profiles + legacy user_keys kept in sync)
export async function saveUserPublicKey(publicKey: string) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) throw new Error("Unauthorized");

  const { error } = await supabase
    .from('profiles')
    .upsert({ id: user.id, public_key: publicKey }, { onConflict: 'id' });

  if (error) throw new Error(error.message);

  await supabase
    .from('user_keys')
    .upsert({ user_id: user.id, public_key: publicKey, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });

  return true;
}

// 2. Look up a friend's public key by their user ID (profiles first, legacy user_keys fallback)
export async function getUserPublicKey(userId: string) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) throw new Error("Unauthorized");

  const { data: profile } = await supabase
    .from('profiles')
    .select('public_key')
    .eq('id', userId)
    .single();

  if (profile?.public_key) return profile.public_key;

  const { data: legacyKey } = await supabase
    .from('user_keys')
    .select('public_key')
    .eq('user_id', userId)
    .single();

  return legacyKey?.public_key ?? null;
}

// 3. Find or create a private chat between the caller and a friend
export async function getOrCreatePrivateChat(friendId: string) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) throw new Error("Unauthorized");
  if (user.id === friendId) throw new Error("You cannot start a secure chat with yourself.");

  // Look for an existing chat regardless of who is user_one / user_two
  const { data: existing, error: fetchError } = await supabase
    .from('private_chats')
    .select('id')
    .or(`and(user_one.eq.${user.id},user_two.eq.${friendId}),and(user_one.eq.${friendId},user_two.eq.${user.id})`)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (existing) return existing.id;

  const { data: chat, error: insertError } = await supabase
    .from('private_chats')
    .insert({ user_one: user.id, user_two: friendId })
    .select('id')
    .single();

  if (insertError) throw new Error(insertError.message);
  return chat.id;
}

// 4. Store an E2EE message (ciphertext only leaves the browser encrypted)
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
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) throw new Error("Unauthorized");

  const { error } = await supabase
    .from('messages')
    .insert({
      chat_id: chatId,
      sender_id: user.id,
      receiver_id: receiverId,
      ciphertext,
      iv,
    });

  if (error) throw new Error(error.message);
  return true;
}

// 5. Soft-delete own message (kept for room chat compatibility)
export async function deleteMessageForEveryone(messageId: string, roomId: string) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) throw new Error("Unauthorized");

    const { error } = await supabase
      .from('messages')
      .update({
        is_deleted: true,
        content: '🚫 This message was deleted',
        file_url: null
      })
      .eq('id', messageId)
      .eq('sender_id', user.id); // Validates against the sender

    if (error) throw new Error(error.message);
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}
