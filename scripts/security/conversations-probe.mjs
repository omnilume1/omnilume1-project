// Personal / General / Group messaging probe (Action 15, migration 20261109100000).
//
//   node scripts/security/conversations-probe.mjs
//
// QA account A (OMNILUME_QA_A_{EMAIL,PASSWORD} or *_FILE) is the subject.
// Throw-away users (service role, deleted at the end): F friend, G follower
// (General via request), S stranger, X blocked, M group member, R removed
// member. Covers the relationship matrix (+ anon), request gating,
// General->Personal reclassification with a ciphertext hash check,
// unauthorized reads/writes by direct table/RPC calls, private realtime
// join/delivery and revocation, and no duplicate conversations.
// Output: codes and pass/fail only.

import { createClient } from '@supabase/supabase-js';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..', '..');
const env = Object.fromEntries(readFileSync(resolve(projectRoot, '.env.local'), 'utf8')
  .split(/\r?\n/).map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean)
  .map((match) => [match[1], match[2].replace(/^(['"])(.*)\1$/, '$2')]));
const secret = (name) => process.env[name] ?? (process.env[`${name}_FILE`] ? readFileSync(process.env[`${name}_FILE`], 'utf8').trim() : undefined);
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, options);
const newClient = () => createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, options);

const results = [];
const record = (check, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  A15  ${check}${detail ? `  [${detail}]` : ''}`);
};
const codeOf = (res) => (res?.error ? String(res.error.code ?? 'error') : 'ok');
const count = (res) => (Array.isArray(res?.data) ? res.data.length : 0);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const CIPHER = () => Buffer.from(randomUUID()).toString('base64'); // 48 chars, valid base64
const IV = 'QUFBQUFBQUFBQUFB';

const throwaway = [];
async function makeUser(tag, withProfile = false) {
  const email = `qa15-${tag}-${randomUUID().slice(0, 8)}@example.invalid`;
  const password = `Pw-${randomUUID()}`;
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw new Error(`createUser ${tag}: ${created.error.message}`);
  throwaway.push(created.data.user.id);
  if (withProfile) await service.from('profiles').insert({ id: created.data.user.id, display_name: `qa15 ${tag}` });
  const client = newClient();
  const signed = await client.auth.signInWithPassword({ email, password });
  if (signed.error) throw new Error(`signIn ${tag}: ${signed.error.message}`);
  client.realtime.setAuth(signed.data.session.access_token);
  return { client, id: created.data.user.id };
}

async function signIn(label) {
  const client = newClient();
  const { data, error } = await client.auth.signInWithPassword({ email: secret(`OMNILUME_QA_${label}_EMAIL`), password: secret(`OMNILUME_QA_${label}_PASSWORD`) });
  if (error || !data.session) throw new Error(`Sign-in failed for account ${label}.`);
  client.realtime.setAuth(data.session.access_token);
  return { client, id: data.user.id };
}

const channels = [];
// Resolves to the subscribe status; collects INSERT payloads in `received`.
function join(user, topic, table, filter, received = []) {
  return new Promise((done) => {
    const channel = user.client.channel(topic, { config: { private: true } })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table, filter }, (payload) => received.push(payload.new))
      .subscribe((status) => { if (status !== 'CLOSED') done(status); });
    channels.push([user.client, channel]);
    setTimeout(() => done('TIMEOUT'), 10000);
  });
}

const typeOf = async (user, id) => {
  const res = await user.client.rpc('get_my_conversations');
  return (res.data ?? []).filter((row) => row.conversation_id === id).map((row) => row.conversation_type).join(',') || 'none';
};
const pairChats = async (a, b) => count(await service.from('private_chats').select('id')
  .or(`and(user_one.eq.${a},user_two.eq.${b}),and(user_one.eq.${b},user_two.eq.${a})`));
const hashOf = async (chatId) => {
  const { data } = await service.from('messages').select('id, ciphertext, iv').eq('chat_id', chatId).order('id');
  return createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16);
};
const send = (user, chatId, receiver) => user.client.from('messages').insert({ chat_id: chatId, sender_id: user.id, receiver_id: receiver, ciphertext: CIPHER(), iv: IV });
const openChat = async (user, peer) => {
  const res = await user.client.from('private_chats').insert({ user_one: user.id, user_two: peer }).select('id').single();
  if (res.error) throw new Error(`openChat: ${codeOf(res)}`);
  return res.data.id;
};

async function main() {
  // QA account A when its credentials are configured, else a throw-away subject.
  const A = secret('OMNILUME_QA_A_EMAIL') ? await signIn('A') : await makeUser('subject', true);
  console.log(`subject: ${secret('OMNILUME_QA_A_EMAIL') ? 'QA account A' : 'throw-away (QA credentials not configured)'}`);
  const [F, G, S, X, M, R] = await Promise.all([
    makeUser('friend'), makeUser('follower'), makeUser('stranger'), makeUser('blocked', true), makeUser('member'), makeUser('removed'),
  ]);
  const anon = newClient();
  const chats = [];
  const roomId = randomUUID();

  try {
    // --- Personal (friend) --------------------------------------------------
    const fr = await A.client.rpc('request_friend', { p_recipient_id: F.id });
    await F.client.rpc('respond_to_friend_request', { p_request_id: fr.data?.id, p_decision: 'accepted' });
    const AF = await openChat(A, F.id); chats.push(AF);
    record('friend: conversation type is personal (both sides)', (await typeOf(A, AF)) === 'personal' && (await typeOf(F, AF)) === 'personal');
    const dup = await F.client.from('private_chats').insert({ user_one: F.id, user_two: A.id });
    record('no duplicate: reversed pair insert refused', dup.error !== null && (await pairChats(A.id, F.id)) === 1, codeOf(dup));

    const fReceived = [];
    const fJoin = await join(F, `chat_${AF}`, 'messages', `chat_id=eq.${AF}`, fReceived);
    const sJoin = await join(S, `chat_${AF}`, 'messages', `chat_id=eq.${AF}`);
    record('realtime: participant joins private chat topic', fJoin === 'SUBSCRIBED', fJoin);
    record('realtime: stranger refused on private chat topic', sJoin !== 'SUBSCRIBED', sJoin);
    await sleep(1500);
    const sent = await send(A, AF, F.id);
    await sleep(3000);
    record('friend: write ok and delivered live to participant', sent.error === null && fReceived.length === 1, `${codeOf(sent)} recv=${fReceived.length}`);
    record('friend: participant reads ciphertext', count(await F.client.from('messages').select('id').eq('chat_id', AF)) === 1);
    record('stranger: cannot read the chat', count(await S.client.from('messages').select('id').eq('chat_id', AF)) === 0);
    const sWrite = await send(S, AF, F.id);
    record('stranger: cannot write into the chat', sWrite.error !== null, codeOf(sWrite));
    const wrongReceiver = await send(A, AF, S.id);
    record('participant: cannot address a third user', wrongReceiver.error !== null, codeOf(wrongReceiver));
    const sType = await S.client.rpc('private_chat_type', { p_chat_id: AF });
    record('stranger: type helper reveals nothing', sType.data === null, String(sType.data));

    // --- General (follower via request) --------------------------------------
    await service.from('follows').insert({ follower_id: G.id, following_id: A.id, status: 'accepted', responded_at: new Date().toISOString(), accepted_at: new Date().toISOString() });
    const early = await G.client.from('private_chats').insert({ user_one: G.id, user_two: A.id });
    record('gating: no chat before the request is accepted', early.error !== null, codeOf(early));
    const strangerReq = await S.client.rpc('send_message_request', { p_recipient_id: A.id, p_message: 'hi' });
    record('gating: stranger (no follow) cannot request', strangerReq.error !== null, codeOf(strangerReq));
    const req = await G.client.rpc('send_message_request', { p_recipient_id: A.id, p_message: 'hello from qa15' });
    const again = await G.client.rpc('send_message_request', { p_recipient_id: A.id, p_message: 'again' });
    record('gating: repeated request returns the same pending row', req.data?.id && again.data?.id === req.data.id);
    const acc = await A.client.rpc('accept_message_request', { p_request_id: req.data?.id });
    const AG = (await service.from('private_chats').select('id').or(`and(user_one.eq.${A.id},user_two.eq.${G.id}),and(user_one.eq.${G.id},user_two.eq.${A.id})`).single()).data?.id;
    chats.push(AG);
    record('general: accepted request creates a general conversation', acc.error === null && (await typeOf(A, AG)) === 'general' && (await typeOf(G, AG)) === 'general');
    await send(G, AG, A.id); await send(G, AG, A.id);
    const unread = (await A.client.rpc('get_my_conversations')).data?.find((row) => row.conversation_id === AG)?.unread_count;
    await A.client.rpc('mark_conversation_read', { p_conversation_id: AG });
    const unreadAfter = (await A.client.rpc('get_my_conversations')).data?.find((row) => row.conversation_id === AG)?.unread_count;
    record('read state: unread 2 -> 0 after mark read', unread === 2 && unreadAfter === 0, `${unread}->${unreadAfter}`);
    const sMark = await S.client.rpc('mark_conversation_read', { p_conversation_id: AG });
    record('read state: outsider cannot mark', sMark.error?.code === '42501', codeOf(sMark));

    // --- Reclassification General -> Personal --------------------------------
    const before = await hashOf(AG);
    const gfr = await G.client.rpc('request_friend', { p_recipient_id: A.id });
    await A.client.rpc('respond_to_friend_request', { p_request_id: gfr.data?.id, p_decision: 'accepted' });
    const after = await hashOf(AG);
    record('reclassify: same chat becomes personal, one chat for the pair', (await typeOf(A, AG)) === 'personal' && (await pairChats(A.id, G.id)) === 1);
    record('reclassify: ciphertext byte-identical', before === after, `${before}/${after}`);

    // --- Block ----------------------------------------------------------------
    await service.from('follows').insert({ follower_id: X.id, following_id: A.id, status: 'accepted', responded_at: new Date().toISOString(), accepted_at: new Date().toISOString() });
    const xr = await X.client.rpc('send_message_request', { p_recipient_id: A.id, p_message: 'x' });
    await A.client.rpc('accept_message_request', { p_request_id: xr.data?.id });
    const AX = (await service.from('private_chats').select('id').or(`and(user_one.eq.${A.id},user_two.eq.${X.id}),and(user_one.eq.${X.id},user_two.eq.${A.id})`).single()).data?.id;
    chats.push(AX);
    await send(X, AX, A.id);
    const blocked = await A.client.rpc('block_user', { p_user_id: X.id });
    record('block: RPC ok', blocked.error === null, codeOf(blocked));
    record('block: blocked user reads nothing', count(await X.client.from('messages').select('id').eq('chat_id', AX)) === 0);
    record('block: blocker reads nothing', count(await A.client.from('messages').select('id').eq('chat_id', AX)) === 0);
    const xWrite = await send(X, AX, A.id);
    record('block: blocked user cannot write', xWrite.error !== null, codeOf(xWrite));
    const xJoin = await join(X, `chat_${AX}`, 'messages', `chat_id=eq.${AX}`);
    record('block: realtime join refused', xJoin !== 'SUBSCRIBED', xJoin);
    const xReq = await X.client.rpc('send_message_request', { p_recipient_id: A.id, p_message: 'again' });
    const xFriend = await X.client.rpc('request_friend', { p_recipient_id: A.id });
    const xFollow = await X.client.from('follows').insert({ follower_id: X.id, following_id: A.id, status: 'pending' });
    record('block: new request / friend request / follow refused', xReq.error !== null && xFriend.error !== null && xFollow.error !== null,
      `${codeOf(xReq)}/${codeOf(xFriend)}/${codeOf(xFollow)}`);
    record('block: conversation gone from both lists', (await typeOf(A, AX)) === 'none' && (await typeOf(X, AX)) === 'none');
    const xBlocks = await X.client.from('user_blocks').select('blocker_id');
    record('block: blocked user cannot see the block row', count(xBlocks) === 0);

    // --- Unfriend ---------------------------------------------------------------
    await A.client.rpc('remove_friend', { p_other_user_id: F.id });
    record('unfriend: friend reads nothing', count(await F.client.from('messages').select('id').eq('chat_id', AF)) === 0);
    const fWrite = await send(F, AF, A.id);
    record('unfriend: friend cannot write', fWrite.error !== null, codeOf(fWrite));
    await F.client.removeAllChannels();
    const fRejoin = await join(F, `chat_${AF}`, 'messages', `chat_id=eq.${AF}`);
    record('unfriend: realtime re-join refused', fRejoin !== 'SUBSCRIBED', fRejoin);

    // --- Groups -----------------------------------------------------------------
    const roomInsert = await A.client.from('rooms').insert({ id: roomId, name: `qa-15-${roomId.slice(0, 8)}`, description: 'Disposable A15 probe.', is_private: true,
      expiration_type: 'recoverable', expires_at: new Date(Date.now() + 3 * 3600_000).toISOString(), created_by: A.id, username: null });
    if (roomInsert.error) throw new Error(`room: ${codeOf(roomInsert)}`);
    await A.client.from('room_members').insert({ room_id: roomId, user_id: A.id, role: 'owner', join_status: 'approved' });
    await service.from('room_members').insert([M, R].map((user) => ({ room_id: roomId, user_id: user.id, role: 'member', join_status: 'approved' })));
    const conv = await A.client.rpc('convert_room_to_group', { p_room_id: roomId });
    const groupId = (await service.from('groups').select('id').eq('source_room_id', roomId).single()).data?.id;
    record('group: created from Action 14 conversion', conv.error === null && Boolean(groupId), codeOf(conv));
    record('group: one group conversation for the member', (await typeOf(M, groupId)) === 'group');
    const mReceived = [];
    const mJoin = await join(M, `group_${groupId}`, 'group_messages', `group_id=eq.${groupId}`, mReceived);
    const sGroupJoin = await join(S, `group_${groupId}`, 'group_messages', `group_id=eq.${groupId}`);
    record('group realtime: member joins, stranger refused', mJoin === 'SUBSCRIBED' && sGroupJoin !== 'SUBSCRIBED', `${mJoin}/${sGroupJoin}`);
    await sleep(1500);
    const aPost = await A.client.from('group_messages').insert({ group_id: groupId, sender_id: A.id, content: 'hello group' });
    await sleep(3000);
    record('group: owner posts, member receives live', aPost.error === null && mReceived.length === 1, `${codeOf(aPost)} recv=${mReceived.length}`);
    record('group: member reads', count(await M.client.from('group_messages').select('id').eq('group_id', groupId)) === 1);
    record('group: stranger reads nothing', count(await S.client.from('group_messages').select('id').eq('group_id', groupId)) === 0);
    const sPost = await S.client.from('group_messages').insert({ group_id: groupId, sender_id: S.id, content: 'x' });
    const spoof = await M.client.from('group_messages').insert({ group_id: groupId, sender_id: A.id, content: 'spoof' });
    const forged = await M.client.from('group_messages').insert({ group_id: groupId, sender_id: M.id, content: 'x', created_at: '2000-01-01T00:00:00Z' });
    record('group: stranger write, sender spoof and forged timestamp refused', sPost.error !== null && spoof.error !== null && forged.error !== null,
      `${codeOf(sPost)}/${codeOf(spoof)}/${codeOf(forged)}`);
    const mRemove = await M.client.rpc('remove_group_member', { p_group_id: groupId, p_user_id: R.id });
    record('group roles: member cannot remove members', mRemove.error?.code === '42501', codeOf(mRemove));
    const ownerLeave = await A.client.rpc('leave_group', { p_group_id: groupId });
    record('group roles: owner cannot leave', ownerLeave.error?.code === '42501', codeOf(ownerLeave));
    const removed = await A.client.rpc('remove_group_member', { p_group_id: groupId, p_user_id: R.id });
    const rRead = count(await R.client.from('group_messages').select('id').eq('group_id', groupId));
    const rPost = await R.client.from('group_messages').insert({ group_id: groupId, sender_id: R.id, content: 'x' });
    const rJoin = await join(R, `group_${groupId}`, 'group_messages', `group_id=eq.${groupId}`);
    record('group removal: no reads, writes or realtime', removed.error === null && rRead === 0 && rPost.error !== null && rJoin !== 'SUBSCRIBED',
      `${codeOf(removed)} r=${rRead} w=${codeOf(rPost)} rt=${rJoin}`);
    const left = await M.client.rpc('leave_group', { p_group_id: groupId });
    record('group leave: no reads after leaving', left.data === true && count(await M.client.from('group_messages').select('id').eq('group_id', groupId)) === 0
      && (await typeOf(M, groupId)) === 'none');

    // --- Anonymous and duplicates ---------------------------------------------------
    const anonConv = await anon.rpc('get_my_conversations');
    const anonMsgs = await anon.from('messages').select('id').in('chat_id', chats);
    const anonGroup = await anon.from('group_messages').select('id');
    record('anon: no conversations, messages or group messages', anonConv.error !== null && count(anonMsgs) === 0 && count(anonGroup) === 0,
      `${codeOf(anonConv)}/${codeOf(anonMsgs)}/${codeOf(anonGroup)}`);
    const mine = (await A.client.rpc('get_my_conversations')).data ?? [];
    const ids = mine.map((row) => row.conversation_id);
    record('no duplicates: each conversation listed once with one type', ids.length === new Set(ids).size && mine.every((row) => ['personal', 'general', 'group'].includes(row.conversation_type)));
  } finally {
    for (const [client, channel] of channels) await client.removeChannel(channel);
    await service.from('groups').delete().eq('source_room_id', roomId);
    await service.from('rooms').delete().eq('id', roomId).like('name', 'qa-15-%');
    for (const id of throwaway) await service.auth.admin.deleteUser(id);
  }

  const passed = results.filter(Boolean).length;
  console.log(`\nsummary: ${passed} pass, ${results.length - passed} fail`);
  process.exit(results.length === passed ? 0 : 1);
}

main().catch((error) => {
  console.error(`conversations probe aborted: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
});
