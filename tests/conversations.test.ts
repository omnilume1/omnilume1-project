import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { canRemoveGroupMember, isPendingRequestContact } from '../src/lib/conversation-model.js';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
const sql = read('supabase/migrations/20261109100000_action15_conversations.sql');
const code = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
const workspace = read('src/components/chat/MessagesWorkspace.tsx');
const inbox = read('src/actions/messages.ts');
const groupChat = read('src/components/chat/GroupChat.tsx');

test('conversation model: pending requests and group removal rules', () => {
  assert.equal(isPendingRequestContact({ chat_id: null, request: { status: 'pending' } }), true);
  assert.equal(isPendingRequestContact({ chat_id: 'c', request: { status: 'pending' } }), false);
  assert.equal(isPendingRequestContact({ chat_id: null, request: { status: 'accepted' } }), false);
  assert.equal(isPendingRequestContact({ chat_id: null, request: null }), false);
  assert.equal(canRemoveGroupMember('owner', 'admin'), true);
  assert.equal(canRemoveGroupMember('owner', 'owner'), false);
  assert.equal(canRemoveGroupMember('admin', 'member'), true);
  assert.equal(canRemoveGroupMember('admin', 'admin'), false);
  assert.equal(canRemoveGroupMember('member', 'member'), false);
});

test('migration: RLS on new tables, no direct writes except column-limited group sends', () => {
  for (const table of ['user_blocks', 'group_messages', 'conversation_reads']) {
    assert.match(code, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`), table);
    assert.match(code, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM PUBLIC, anon, authenticated`), table);
  }
  assert.match(code, /GRANT INSERT \(group_id, sender_id, content\) ON TABLE public\.group_messages TO authenticated/);
  assert.doesNotMatch(code, /GRANT (INSERT|UPDATE)[^;]*ON TABLE public\.(user_blocks|conversation_reads)/);
  assert.doesNotMatch(code, /SECURITY DEFINER\nSET search_path TO 'public'/);
});

test('migration: one type per conversation, derived, revocable, one chat per pair', () => {
  assert.match(code, /CREATE UNIQUE INDEX IF NOT EXISTS private_chats_pair_unique_idx\s+ON public\.private_chats \(LEAST\(user_one, user_two\), GREATEST\(user_one, user_two\)\)/);
  const typeFn = code.slice(code.indexOf('FUNCTION public.private_chat_type('), code.indexOf('$$;', code.indexOf('FUNCTION public.private_chat_type(')));
  // Blocks are checked before friendship, friendship before General.
  assert.ok(typeFn.indexOf('user_blocks') < typeFn.indexOf('friendships'));
  assert.ok(typeFn.indexOf('friendships') < typeFn.indexOf("'general'"));
  assert.match(code, /AS RESTRICTIVE FOR SELECT TO authenticated\nUSING \(chat_id IS NULL OR public\.private_chat_type\(chat_id\) IS NOT NULL\)/);
  assert.match(code, /AS RESTRICTIVE FOR INSERT TO authenticated/);
  assert.match(code, /RETURN public\.private_chat_type\(substring\(p_topic FROM 6\)::uuid\) IS NOT NULL/);
  assert.match(code, /RETURN public\.is_group_member\(substring\(p_topic FROM 7\)::uuid, auth\.uid\(\)\)/);
  // Reclassification relabels metadata only: messages are never rewritten.
  assert.doesNotMatch(code, /UPDATE public\.messages|DELETE FROM public\.messages/);
});

test('migration: block refuses new relationship rows on every relationship table', () => {
  for (const table of ['message_requests', 'friend_requests', 'follows', 'friendships', 'private_chats']) {
    assert.match(code, new RegExp(`BEFORE INSERT ON public\\.${table}\\nFOR EACH ROW EXECUTE FUNCTION public\\.reject_blocked_pair`), table);
  }
  assert.match(code, /REVOKE ALL ON FUNCTION public\.block_user\(uuid\)[\s\S]*FROM PUBLIC, anon;/);
  assert.match(code, /SECURITY INVOKER/);
});

test('inbox and UI: four tabs, personal = friends only, groups never mixed with rooms', () => {
  assert.match(workspace, /type TabId = 'personal' \| 'general' \| 'groups' \| 'requests'/);
  assert.match(inbox, /supabase\.rpc\('get_my_conversations'\)/);
  assert.doesNotMatch(inbox, /acceptedRequestPartnerIds/);
  assert.match(groupChat, /\.from\('group_messages'\)/);
  assert.doesNotMatch(groupChat, /from\('messages'\)|room_id|deriveSharedKey/);
  assert.match(groupChat, /channel\(`group_\$\{groupId\}`, \{ config: \{ private: true \} \}\)/);
  assert.match(workspace, /This message cannot be decrypted|PrivateChat/);
});
