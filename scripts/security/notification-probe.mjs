// Notification system probe (Action 08, migrations 20261105160000+).
//
//   node scripts/security/notification-probe.mjs
//
// Two disposable QA accounts (OMNILUME_QA_{A,B}_{EMAIL,PASSWORD} or *_FILE);
// fixtures are new qa-* rooms, deleted at the end with the service role.
// Output: ids, status codes and pass/fail only.

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

const results = [];
export const record = (test, check, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${test}  ${check}${detail ? `  [${detail}]` : ''}`);
};
const codeOf = (res) => (res?.error ? String(res.error.code ?? res.error.statusCode ?? 'error') : 'ok');
const rows = (res) => (Array.isArray(res?.data) ? res.data.length : res?.data ? 1 : 0);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function signIn(label) {
  const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, options);
  const { data, error } = await client.auth.signInWithPassword({ email: secret(`OMNILUME_QA_${label}_EMAIL`), password: secret(`OMNILUME_QA_${label}_PASSWORD`) });
  if (error || !data.session) throw new Error(`Sign-in failed for account ${label}.`);
  client.realtime.setAuth(data.session.access_token);
  return { client, id: data.user.id };
}

export async function createRoom(owner, tag, suffix, type = 'recoverable') {
  const id = randomUUID();
  const insert = await owner.client.from('rooms').insert({
    id, name: `${tag}-${suffix}`, description: 'Disposable notification probe.', is_private: true,
    expiration_type: type, expires_at: type === 'permanent' ? null : new Date(Date.now() + 2 * 3600_000).toISOString(),
    created_by: owner.id, username: null,
  });
  if (insert.error) throw new Error(`room ${suffix}: ${codeOf(insert)}`);
  const member = await owner.client.from('room_members').insert({ room_id: id, user_id: owner.id, role: 'owner', join_status: 'approved' });
  if (member.error) throw new Error(`owner member ${suffix}: ${codeOf(member)}`);
  return id;
}

export async function addMember(owner, member, roomId) {
  const join = await member.client.rpc('request_room_join', { p_identifier: roomId });
  const approve = await owner.client.rpc('review_room_member', { p_room_id: roomId, p_target_user_id: member.id, p_action: 'approve', p_reason: '' });
  if (join.error || approve.error) throw new Error(`membership ${roomId}: ${codeOf(join)}/${codeOf(approve)}`);
}

async function main() {
  const A = await signIn('A');
  const B = await signIn('B');
  const tag = `qa-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  console.log(`fixture tag ${tag}`);
  const R1 = await createRoom(A, tag, 'notify-1');
  const R2 = await createRoom(A, tag, 'notify-2');
  // R3 is permanent from the start: room-deletion notices need a permanent
  // room, and the legacy permanent-conversion RPC is no longer callable.
  const R3 = await createRoom(A, tag, 'notify-3', 'permanent');
  const foreign = await createRoom(A, tag, 'not-a-member');
  const created = [R1, R2, R3, foreign];

  // Live delivery uses the app's private per-user channel
  // (usePersonalMessageNotifications). B listens on its own topic; A tries
  // to join B's topic, and listens for B's rows on A's own topic. Postgres
  // Changes become active only when Realtime sends the postgres_changes
  // system message, some time after SUBSCRIBED.
  const bEvents = [];
  const aSnoop = [];
  const feeds = {};
  const statuses = {};
  const history = {};
  const listen = (client, key, topicUserId, sink) => client.channel(`personal_message_notifications_${topicUserId}`, { config: { private: true } })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_notifications', filter: `recipient_id=eq.${B.id}` }, (payload) => sink.push(payload.new?.notification_type))
    .on('system', {}, (message) => { if (message?.extension === 'postgres_changes') feeds[key] = message.status; })
    .subscribe((status, error) => { statuses[key] = error ? `${status}: ${error.message}` : status; (history[key] ??= []).push(statuses[key]); });
  const bChannel = listen(B.client, 'own', B.id, bEvents);
  const hijack = listen(A.client, 'hijack', B.id, aSnoop);
  for (let waited = 0; waited < 10_000 && !(statuses.hijack && statuses.own === 'SUBSCRIBED'); waited += 250) await sleep(250);
  await A.client.removeChannel(hijack);
  const aChannel = listen(A.client, 'snoop', A.id, aSnoop);
  for (let waited = 0; waited < 20_000 && !(feeds.own && feeds.snoop); waited += 250) await sleep(250);
  record('A08', 'a user joins their own private notification channel', statuses.own === 'SUBSCRIBED' && feeds.own === 'ok', `${statuses.own} feed=${feeds.own ?? 'none'}`);
  // The inbox and private-chat channels are private too (20261105210000).
  const joinOnce = (client, topic) => new Promise((done) => {
    const channel = client.channel(topic, { config: { private: true } });
    const timer = setTimeout(() => finish('NO_RESPONSE'), 10_000);
    let settled = false;
    function finish(status) { if (settled) return; settled = true; clearTimeout(timer); void client.removeChannel(channel); done(status); }
    channel.subscribe((status) => { if (['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) finish(status); });
  });
  const ownChat = (await A.client.from('private_chats').select('id').limit(1)).data?.[0]?.id;
  const foreignChat = (await service.from('private_chats').select('id, user_one, user_two').limit(50)).data?.find((row) => row.user_one !== A.id && row.user_two !== A.id)?.id;
  record('A08', 'a user joins their own private inbox channel', await joinOnce(A.client, `messages_inbox_${A.id}`) === 'SUBSCRIBED');
  record('A08', 'another user\'s inbox channel is refused', await joinOnce(A.client, `messages_inbox_${B.id}`) === 'CHANNEL_ERROR');
  if (ownChat) record('A08', 'a participant joins their private chat channel', await joinOnce(A.client, `chat_${ownChat}`) === 'SUBSCRIBED');
  if (foreignChat) record('A08', 'a non-participant cannot join a private chat channel', await joinOnce(A.client, `chat_${foreignChat}`) === 'CHANNEL_ERROR');
  record('A08', 'another user cannot join that private channel',(history.hijack ?? []).length > 0 && !(history.hijack ?? []).includes('SUBSCRIBED') && String(history.hijack[0]).startsWith('CHANNEL_ERROR'), (history.hijack ?? ['no answer']).join(' > ').slice(0, 120));

  try {
    await addMember(A, B, R1);
    await addMember(A, B, R2);
    await addMember(A, B, R3);
    await sleep(2500);
    record('A08', 'membership approval creates an access notice for the member', bEvents.includes('access'), `events=${bEvents.join(',')}`);
    record('A08', 'live notices reach only their recipient (another user\'s filter gets nothing)', aSnoop.length === 0, `snooped=${aSnoop.length}`);

    const bNotices = await B.client.from('room_notifications').select('id, notification_type, read_at').eq('room_id', R1);
    const notice = (bNotices.data ?? [])[0];
    record('A08', 'the recipient reads its notice', Boolean(notice), `${codeOf(bNotices)} rows=${rows(bNotices)}`);
    const aRead = await A.client.from('room_notifications').select('id').eq('id', notice?.id ?? randomUUID());
    record('A08', 'another user cannot read it', !aRead.error && rows(aRead) === 0, `${codeOf(aRead)} rows=${rows(aRead)}`);
    const aMark = await A.client.rpc('mark_room_notifications_read', { p_ids: [notice?.id ?? randomUUID()] });
    record('A08', 'another user cannot mark it read (RPC affects 0 rows)', !aMark.error && Number(aMark.data) === 0, `${codeOf(aMark)} n=${aMark.data}`);
    const aDirect = await A.client.from('room_notifications').update({ read_at: new Date().toISOString() }).eq('id', notice?.id ?? randomUUID()).select('id');
    record('A08', 'another user cannot update it directly', !aDirect.error ? rows(aDirect) === 0 : true, `${codeOf(aDirect)} rows=${rows(aDirect)}`);
    const bTamper = await B.client.from('room_notifications').update({ message: 'tampered' }).eq('id', notice?.id ?? randomUUID()).select('id');
    record('A08', 'the recipient cannot change the message (read_at only)', Boolean(bTamper.error), codeOf(bTamper));
    const bInsert = await B.client.from('room_notifications').insert({ room_id: R1, recipient_id: B.id, notification_type: 'security', message: 'forged' });
    record('A08', 'clients cannot insert notices', Boolean(bInsert.error), codeOf(bInsert));
    const enqueue = await B.client.rpc('enqueue_room_notification', { p_recipient_id: A.id, p_room_id: R1, p_type: 'security', p_message: 'forged' });
    record('A08', 'clients cannot call the notification writer', Boolean(enqueue.error), codeOf(enqueue));
    const bMark = await B.client.rpc('mark_room_notifications_read', { p_ids: null });
    record('A08', 'the recipient marks all read', !bMark.error && Number(bMark.data) >= 1, `${codeOf(bMark)} n=${bMark.data}`);

    // Preferences: room mute and global DND, applied by the server.
    const foreignMute = await B.client.rpc('set_notification_preference', { p_room_id: foreign, p_muted: true, p_muted_until: null });
    record('A08', 'a user cannot mute a room they do not belong to', Boolean(foreignMute.error) && foreignMute.error.code === '42501', codeOf(foreignMute));
    const roomMute = await B.client.rpc('set_notification_preference', { p_room_id: R2, p_muted: true, p_muted_until: null });
    record('A08', 'a member mutes one room', !roomMute.error, codeOf(roomMute));
    const aPrefs = await A.client.from('notification_preferences').select('id').eq('user_id', B.id);
    record('A08', 'another user cannot see those preferences', !aPrefs.error && rows(aPrefs) === 0, `${codeOf(aPrefs)} rows=${rows(aPrefs)}`);
    const convertMuted = await A.client.rpc('create_room_announcement', { p_room_id: R2, p_body: 'Muted room update', p_is_pinned: false });
    const mutedNotice = await B.client.from('room_notifications').select('id').eq('room_id', R2).eq('notification_type', 'announcement');
    record('A08', 'a muted room\'s update notice is suppressed', !convertMuted.error && rows(mutedNotice) === 0, `${codeOf(convertMuted)} rows=${rows(mutedNotice)}`);

    const dnd = await B.client.rpc('set_notification_preference', { p_room_id: null, p_muted: true, p_muted_until: new Date(Date.now() + 3600_000).toISOString() });
    record('A08', 'a user turns on do-not-disturb for one hour', !dnd.error, codeOf(dnd));
    const convertDnd = await A.client.rpc('create_room_announcement', { p_room_id: R3, p_body: 'DND room update', p_is_pinned: false });
    const dndNotice = await B.client.from('room_notifications').select('id').eq('room_id', R3).eq('notification_type', 'announcement');
    record('A08', 'do-not-disturb suppresses room update notices', !convertDnd.error && rows(dndNotice) === 0, `${codeOf(convertDnd)} rows=${rows(dndNotice)}`);
    const promote = await A.client.rpc('set_room_member_role', { p_room_id: R1, p_target_user_id: B.id, p_role: 'admin' });
    await sleep(1000);
    const accessDuringDnd = await B.client.from('room_notifications').select('id, message').eq('room_id', R1).eq('notification_type', 'access');
    record('A08', 'do-not-disturb never hides access notices', !promote.error && rows(accessDuringDnd) >= 2, `${codeOf(promote)} rows=${rows(accessDuringDnd)}`);
    const deletion = await A.client.rpc('schedule_room_deletion', { p_room_id: R3, p_grace_days: 7 });
    const deletionNotice = await B.client.from('room_notifications').select('id').eq('room_id', R3).eq('notification_type', 'room_deletion');
    record('A08', 'do-not-disturb never hides room-deletion notices', !deletion.error && rows(deletionNotice) === 1, `${codeOf(deletion)} rows=${rows(deletionNotice)}`);
    const off = await B.client.rpc('set_notification_preference', { p_room_id: null, p_muted: false, p_muted_until: null });
    const unmute = await B.client.rpc('set_notification_preference', { p_room_id: R2, p_muted: false, p_muted_until: null });
    const left = await B.client.from('notification_preferences').select('id');
    record('A08', 'turning DND and the room mute off removes both preferences', !off.error && !unmute.error && rows(left) === 0, `rows=${rows(left)}`);
    const badEnd = await B.client.rpc('set_notification_preference', { p_room_id: null, p_muted: true, p_muted_until: new Date(Date.now() - 1000).toISOString() });
    record('A08', 'a mute end time in the past is rejected', Boolean(badEnd.error), codeOf(badEnd));
  } finally {
    await B.client.removeChannel(bChannel);
    await A.client.removeChannel(aChannel);
    for (const roomId of created) await service.from('rooms').delete().eq('id', roomId).like('name', 'qa-%');
    await service.from('notification_preferences').delete().eq('user_id', B.id);
  }

  const passed = results.filter(Boolean).length;
  console.log(`\nsummary: ${passed} pass, ${results.length - passed} fail`);
  process.exit(results.length === passed ? 0 : 1);
}

main().catch((error) => {
  console.error(`notification probe aborted: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
});
