// Room messaging probe (Action 08, migration 20261105180000).
//
//   node scripts/security/messaging-probe.mjs
//
// Two disposable QA accounts (OMNILUME_QA_{A,B}_{EMAIL,PASSWORD} or *_FILE).
// A owns new qa-* rooms; B is an approved member. Both listen exactly like
// the app: the private sync:<room> channel (room message INSERT/UPDATE) and
// the private per-user notification channel. Fixtures are deleted with the
// service role at the end. Output: status codes and pass/fail only.

import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..', '..');
const env = Object.fromEntries(readFileSync(resolve(projectRoot, '.env.local'), 'utf8')
  .split(/\r?\n/).map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean)
  .map((match) => [match[1], match[2].replace(/^(['"])(.*)\1$/, '$2')]));
const secret = (name) => process.env[name] ?? (process.env[`${name}_FILE`] ? readFileSync(process.env[`${name}_FILE`], 'utf8').trim() : undefined);
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, options);
const THUMBS = '\u{1F44D}';
const COLUMNS = 'id, sender_id, content, is_deleted, created_at, edited_at, reply_to_id, pinned_at, pinned_by, reaction_summary';

const results = [];
const record = (check, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  A08  ${check}${detail ? `  [${detail}]` : ''}`);
};
const codeOf = (res) => (res?.error ? String(res.error.code ?? res.error.statusCode ?? 'error') : 'ok');
const rows = (res) => (Array.isArray(res?.data) ? res.data.length : res?.data ? 1 : 0);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function waitFor(predicate, ms = 8000) {
  for (let waited = 0; waited < ms; waited += 200) {
    if (predicate()) return true;
    await sleep(200);
  }
  return predicate();
}

async function signIn(label) {
  const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, options);
  const { data, error } = await client.auth.signInWithPassword({ email: secret(`OMNILUME_QA_${label}_EMAIL`), password: secret(`OMNILUME_QA_${label}_PASSWORD`) });
  if (error || !data.session) throw new Error(`Sign-in failed for account ${label}.`);
  client.realtime.setAuth(data.session.access_token);
  return { client, id: data.user.id };
}

async function createRoom(owner, tag, suffix) {
  const id = randomUUID();
  const insert = await owner.client.from('rooms').insert({
    id, name: `${tag}-${suffix}`, description: 'Disposable messaging probe.', is_private: true,
    expiration_type: 'recoverable', expires_at: new Date(Date.now() + 2 * 3600_000).toISOString(), created_by: owner.id, username: null,
  });
  if (insert.error) throw new Error(`room ${suffix}: ${codeOf(insert)}`);
  const member = await owner.client.from('room_members').insert({ room_id: id, user_id: owner.id, role: 'owner', join_status: 'approved' });
  if (member.error) throw new Error(`owner member ${suffix}: ${codeOf(member)}`);
  return id;
}

async function addMember(owner, member, roomId) {
  const join = await member.client.rpc('request_room_join', { p_identifier: roomId });
  const approve = await owner.client.rpc('review_room_member', { p_room_id: roomId, p_target_user_id: member.id, p_action: 'approve', p_reason: '' });
  if (join.error || approve.error) throw new Error(`membership: ${codeOf(join)}/${codeOf(approve)}`);
}

// The app's subscriptions: room messages on sync:<room>, notifications on the
// per-user channel. Resolves once both Postgres Changes feeds are ready.
async function listen(user, roomId) {
  const log = { inserts: [], updates: [], notices: [] };
  const feeds = {};
  const room = user.client.channel(`sync:${roomId}`, { config: { private: true } })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `room_id=eq.${roomId}` }, (change) => log.inserts.push(change.new))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `room_id=eq.${roomId}` }, (change) => log.updates.push(change.new))
    .on('system', {}, (message) => { if (message?.extension === 'postgres_changes') feeds.room = message.status; })
    .subscribe();
  const personal = user.client.channel(`personal_message_notifications_${user.id}`, { config: { private: true } })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_notifications', filter: `recipient_id=eq.${user.id}` }, (change) => log.notices.push(change.new))
    .on('system', {}, (message) => { if (message?.extension === 'postgres_changes') feeds.personal = message.status; })
    .subscribe();
  await waitFor(() => feeds.room && feeds.personal, 20_000);
  return { log, feeds, channels: [room, personal] };
}

async function main() {
  const A = await signIn('A');
  const B = await signIn('B');
  const tag = `qa-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  const R = await createRoom(A, tag, 'chat');
  const R2 = await createRoom(A, tag, 'other');
  const created = [R, R2];
  const channels = [];

  try {
    await addMember(A, B, R);
    const aName = (await A.client.from('profiles').select('username').eq('id', A.id).single()).data?.username;
    const bName = (await B.client.from('profiles').select('username').eq('id', B.id).single()).data?.username;
    const a = await listen(A, R);
    const b = await listen(B, R);
    channels.push([A.client, a.channels], [B.client, b.channels]);
    record('both members join the room and notification feeds', a.feeds.room === 'ok' && a.feeds.personal === 'ok' && b.feeds.room === 'ok' && b.feeds.personal === 'ok', `${JSON.stringify(a.feeds)} ${JSON.stringify(b.feeds)}`);

    // Mentions and replies.
    const mention = await B.client.from('messages').insert({ room_id: R, sender_id: B.id, content: `hey @${aName} look` }).select(COLUMNS).single();
    record('B sends a message that mentions A', !mention.error && Boolean(aName), codeOf(mention));
    const mentionLive = await waitFor(() => a.log.notices.some((row) => row.notification_type === 'mention' && row.entity_id === mention.data?.id));
    record('A receives the mention notice live (private, only A)', mentionLive, `notices=${a.log.notices.map((row) => row.notification_type).join(',')}`);
    const bSeesMention = await B.client.from('room_notifications').select('id').eq('notification_type', 'mention').eq('entity_id', mention.data?.id ?? randomUUID());
    record('B cannot see the notice sent to A', !bSeesMention.error && rows(bSeesMention) === 0, `rows=${rows(bSeesMention)}`);

    const reply = await A.client.from('messages').insert({ room_id: R, sender_id: A.id, content: 'replying', reply_to_id: mention.data?.id }).select(COLUMNS).single();
    record('A replies to B', !reply.error && reply.data?.reply_to_id === mention.data?.id, codeOf(reply));
    const replyLive = await waitFor(() => b.log.notices.some((row) => row.notification_type === 'reply' && row.entity_id === reply.data?.id));
    record('B receives the reply notice live', replyLive, `notices=${b.log.notices.map((row) => row.notification_type).join(',')}`);
    const replyRow = await waitFor(() => b.log.inserts.some((row) => row.id === reply.data?.id && row.reply_to_id === mention.data?.id));
    record('the reply reaches B with its reply target', replyRow);

    const otherRoomMessage = await A.client.from('messages').insert({ room_id: R2, sender_id: A.id, content: 'elsewhere' }).select('id').single();
    const crossReply = await B.client.from('messages').insert({ room_id: R, sender_id: B.id, content: 'x', reply_to_id: otherRoomMessage.data?.id });
    record('a reply to another room\'s message is rejected', crossReply.error?.code === '23514', codeOf(crossReply));

    const gif = await B.client.from('messages').insert({ room_id: R, sender_id: B.id, content: `[gif:abcd1234|@${aName}]` }).select('id').single();
    await sleep(1500);
    record('GIF messages never create mentions', !gif.error && !a.log.notices.some((row) => row.entity_id === gif.data?.id), codeOf(gif));

    // Edits.
    const edit = await B.client.from('messages').update({ content: 'edited text' }).eq('id', mention.data?.id).select(COLUMNS).single();
    record('B edits its own message; the server sets edited_at', !edit.error && Boolean(edit.data?.edited_at), codeOf(edit));
    const editLive = await waitFor(() => a.log.updates.some((row) => row.id === mention.data?.id && row.content === 'edited text' && row.edited_at));
    record('A sees the edit live with the edited marker', editLive);
    const forgedEdit = await B.client.from('messages').update({ edited_at: '2000-01-01T00:00:00Z' }).eq('id', mention.data?.id).select('edited_at').single();
    record('a client cannot set edited_at', !forgedEdit.error && forgedEdit.data?.edited_at === edit.data?.edited_at, codeOf(forgedEdit));
    const hijack = await A.client.from('messages').update({ content: 'hijacked' }).eq('id', mention.data?.id).select('id');
    record('A cannot edit B\'s message', !hijack.error && rows(hijack) === 0, `${codeOf(hijack)} rows=${rows(hijack)}`);

    // Reactions.
    const forgedSummary = await B.client.from('messages').update({ reaction_summary: { [THUMBS]: { count: 99, users: [] } } }).eq('id', mention.data?.id);
    record('a client cannot write the reaction summary', forgedSummary.error?.code === '42501', codeOf(forgedSummary));
    const directReaction = await B.client.from('room_message_reactions').insert({ message_id: reply.data?.id, room_id: R, user_id: B.id, emoji: THUMBS });
    record('a client cannot insert reactions directly', Boolean(directReaction.error), codeOf(directReaction));
    const r1 = await B.client.rpc('toggle_room_message_reaction', { p_message_id: reply.data?.id, p_emoji: THUMBS });
    const r2 = await A.client.rpc('toggle_room_message_reaction', { p_message_id: reply.data?.id, p_emoji: THUMBS });
    record('two members react; counts add up', !r1.error && !r2.error && r2.data?.[THUMBS]?.count === 2, `${codeOf(r1)}/${codeOf(r2)} n=${r2.data?.[THUMBS]?.count}`);
    const reactionLive = await waitFor(() => b.log.updates.some((row) => row.id === reply.data?.id && row.reaction_summary?.[THUMBS]?.count === 2));
    record('the reaction summary reaches B live', reactionLive);
    const r3 = await B.client.rpc('toggle_room_message_reaction', { p_message_id: reply.data?.id, p_emoji: THUMBS });
    record('toggling again removes only B\'s reaction', !r3.error && r3.data?.[THUMBS]?.count === 1 && r3.data?.[THUMBS]?.users?.[0] === A.id, codeOf(r3));
    const badEmoji = await B.client.rpc('toggle_room_message_reaction', { p_message_id: reply.data?.id, p_emoji: 'x' });
    record('unsupported reactions are rejected', badEmoji.error?.code === '22023', codeOf(badEmoji));
    const foreignReact = await B.client.rpc('toggle_room_message_reaction', { p_message_id: otherRoomMessage.data?.id, p_emoji: THUMBS });
    record('a non-member cannot react in another room', foreignReact.error?.code === '42501', codeOf(foreignReact));

    // Pins.
    const memberPin = await B.client.rpc('set_room_message_pin', { p_message_id: reply.data?.id, p_pinned: true });
    record('a member without manage_announcements cannot pin', memberPin.error?.code === '42501', codeOf(memberPin));
    const ownerPin = await A.client.rpc('set_room_message_pin', { p_message_id: reply.data?.id, p_pinned: true });
    record('the owner pins a message', !ownerPin.error && typeof ownerPin.data === 'string', codeOf(ownerPin));
    const pinLive = await waitFor(() => b.log.updates.some((row) => row.id === reply.data?.id && row.pinned_at));
    record('B sees the pin live', pinLive);
    const forgedPin = await B.client.from('messages').update({ pinned_at: new Date().toISOString() }).eq('id', mention.data?.id);
    record('a client cannot pin by writing the column', forgedPin.error?.code === '42501', codeOf(forgedPin));

    // Delete for everyone clears pins and reactions.
    const pinOwn = await A.client.rpc('set_room_message_pin', { p_message_id: mention.data?.id, p_pinned: true });
    await B.client.rpc('toggle_room_message_reaction', { p_message_id: mention.data?.id, p_emoji: THUMBS });
    const del = await B.client.from('messages').update({ is_deleted: true, content: '\u{1F6AB} This message was deleted', file_url: null }).eq('id', mention.data?.id).eq('sender_id', B.id).select(COLUMNS).single();
    record('delete for everyone unpins and clears reactions', !pinOwn.error && !del.error && del.data?.pinned_at === null && Object.keys(del.data?.reaction_summary ?? {}).length === 0, `${codeOf(pinOwn)}/${codeOf(del)}`);
    const undelete = await B.client.from('messages').update({ is_deleted: false }).eq('id', mention.data?.id);
    record('a deleted message cannot be restored or edited', undelete.error?.code === '42501', codeOf(undelete));

    // Announcements.
    const announce = await A.client.rpc('create_room_announcement', { p_room_id: R, p_body: 'Quiz moved to Friday', p_is_pinned: false });
    const announceLive = await waitFor(() => b.log.notices.some((row) => row.notification_type === 'announcement'));
    record('an announcement notifies members live', !announce.error && announceLive, codeOf(announce));
    const memberAnnounce = await B.client.rpc('create_room_announcement', { p_room_id: R, p_body: 'Not allowed', p_is_pinned: false });
    record('a member without the capability cannot announce', Boolean(memberAnnounce.error), codeOf(memberAnnounce));

    // Shared PDF.
    const pdf = await A.client.rpc('register_room_file', {
      p_room_id: R, p_object_path: `${R}/files/${randomUUID()}.pdf`, p_original_name: 'Chapter 3.pdf', p_normalized_name: 'chapter 3.pdf',
      p_mime_type: 'application/pdf', p_size_bytes: 2048, p_metadata: {},
    });
    const pdfLive = await waitFor(() => b.log.notices.some((row) => row.notification_type === 'pdf_shared'));
    record('sharing a PDF notifies members live', !pdf.error && pdfLive, codeOf(pdf));

    // Study timer.
    const session = randomUUID();
    const start = await B.client.rpc('upsert_room_realtime_snapshot', { p_room_id: R, p_snapshot_type: 'timer', p_state_version: 1, p_payload: { eventType: 'timer_start', payload: { sessionId: session, duration: 1500, ownerId: A.id } } });
    const timerLive = await waitFor(() => a.log.notices.some((row) => row.notification_type === 'timer'));
    record('a member starting the shared timer notifies the owner live', !start.error && timerLive, codeOf(start));
    const early = await B.client.rpc('upsert_room_realtime_snapshot', { p_room_id: R, p_snapshot_type: 'timer', p_state_version: 1, p_payload: { eventType: 'timer_pause', payload: { sessionId: session, duration: 1500, completed: true } } });
    await sleep(1500);
    record('an early "completed" claim does not notify', !early.error && !b.log.notices.some((row) => row.notification_type === 'timer'), codeOf(early));

    // Unread state.
    const markB = await B.client.rpc('mark_room_read', { p_room_id: R });
    await sleep(1100);
    await A.client.from('messages').insert({ room_id: R, sender_id: A.id, content: 'new after read' });
    const unread = await B.client.rpc('get_room_unread_counts', { p_room_ids: [R] });
    record('unread count reflects messages after the read marker', !markB.error && unread.data?.[0]?.unread_count === 1, `${codeOf(unread)} n=${unread.data?.[0]?.unread_count}`);
    await B.client.rpc('mark_room_read', { p_room_id: R });
    const unreadAfter = await B.client.rpc('get_room_unread_counts', { p_room_ids: [R] });
    record('marking read clears it', unreadAfter.data?.[0]?.unread_count === 0, `n=${unreadAfter.data?.[0]?.unread_count}`);
    const aSeesB = await A.client.from('room_read_states').select('user_id').eq('user_id', B.id);
    record('read state is private to its member', !aSeesB.error && rows(aSeesB) === 0, `rows=${rows(aSeesB)}`);
    const foreignRead = await B.client.rpc('mark_room_read', { p_room_id: R2 });
    record('a non-member cannot mark another room read', foreignRead.error?.code === '42501', codeOf(foreignRead));

    // Scoping: a mention in a room B is not in reaches nobody.
    await A.client.from('messages').insert({ room_id: R2, sender_id: A.id, content: `ping @${bName}` });
    await sleep(1500);
    const leaked = await service.from('room_notifications').select('id').eq('recipient_id', B.id).eq('room_id', R2);
    record('mentioning a non-member does not notify them', !leaked.error && rows(leaked) === 0, `rows=${rows(leaked)}`);
    const internal = await B.client.rpc('room_member_can', { p_room_id: R, p_user_id: A.id, p_capability: 'chat' });
    record('internal capability helper is not callable by clients', Boolean(internal.error), codeOf(internal));
  } finally {
    for (const [client, list] of channels) for (const channel of list) await client.removeChannel(channel);
    for (const roomId of created) await service.from('rooms').delete().eq('id', roomId).like('name', 'qa-%');
  }

  const passed = results.filter(Boolean).length;
  console.log(`\nsummary: ${passed} pass, ${results.length - passed} fail`);
  process.exit(results.length === passed ? 0 : 1);
}

main().catch((error) => {
  console.error(`messaging probe aborted: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
});
