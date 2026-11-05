// Watch reliability probe (Action 11, migration 20261106100000).
//
//   node scripts/security/watch-probe.mjs
//
// Two disposable QA accounts (OMNILUME_QA_{A,B}_{EMAIL,PASSWORD} or *_FILE).
// A owns new qa-* rooms; B is checked as member, then admin, and as an
// outsider of another room; an anonymous client is checked too. Covers the
// shared queue and clips RPCs/RLS and the Watch Realtime topics. Fixtures are
// deleted with the service role at the end. Output: codes and pass/fail.

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
const record = (check, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  A11  ${check}${detail ? `  [${detail}]` : ''}`);
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

async function createRoom(owner, tag, suffix) {
  const id = randomUUID();
  const insert = await owner.client.from('rooms').insert({ id, name: `${tag}-${suffix}`, description: 'Disposable watch probe.', is_private: true, expiration_type: 'recoverable', expires_at: new Date(Date.now() + 2 * 3600_000).toISOString(), created_by: owner.id, username: null });
  if (insert.error) throw new Error(`room: ${codeOf(insert)}`);
  await owner.client.from('room_members').insert({ room_id: id, user_id: owner.id, role: 'owner', join_status: 'approved' });
  return id;
}

async function registerMedia(owner, roomId, name) {
  const res = await owner.client.rpc('register_temporary_media', { p_room_id: roomId, p_file_name: name, p_file_path: `${roomId}/media/${randomUUID()}.mp3`, p_media_type: 'audio', p_mime_type: 'audio/mpeg', p_file_size: 1000 });
  const id = (Array.isArray(res.data) ? res.data[0] : res.data)?.id;
  if (!id) throw new Error(`media: ${codeOf(res)}`);
  return id;
}

async function listen(user, topic, events) {
  let status = null;
  const channel = user.client.channel(topic, { config: { private: true, broadcast: { self: false } } })
    .on('broadcast', { event: 'room_action' }, (message) => events.push(message.payload?.event_type))
    .subscribe((value) => { status = value; });
  for (let i = 0; i < 40 && status !== 'SUBSCRIBED' && status !== 'CHANNEL_ERROR'; i += 1) await sleep(250);
  return { channel, status };
}

const wire = (sender, roomId, eventType, payload) => ({ type: 'broadcast', event: 'room_action', payload: { event_id: randomUUID(), sender_id: sender.id, timestamp: Date.now(), room_id: roomId, event_type: eventType, payload, state_version: 1 } });

async function main() {
  const A = await signIn('A');
  const B = await signIn('B');
  const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, options);
  const tag = `qa-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  const R = await createRoom(A, tag, 'watch');
  const R2 = await createRoom(A, tag, 'outsider');
  const channels = [];

  try {
    await B.client.rpc('request_room_join', { p_identifier: R });
    const approve = await A.client.rpc('review_room_member', { p_room_id: R, p_target_user_id: B.id, p_action: 'approve', p_reason: '' });
    if (approve.error) throw new Error(`approve: ${codeOf(approve)}`);
    const m1 = await registerMedia(A, R, 'One.mp3');
    const m2 = await registerMedia(A, R, 'Two.mp3');
    const m3 = await registerMedia(A, R, 'Three.mp3');
    const mOut = await registerMedia(A, R2, 'Elsewhere.mp3');

    // Queue: owner, member, outsider, anon.
    const ownerAdd = await A.client.rpc('add_media_to_queue', { p_room_id: R, p_media_id: m1 });
    const memberAdd = await B.client.rpc('add_media_to_queue', { p_room_id: R, p_media_id: m2 });
    record('owner and member add to the queue', !ownerAdd.error && !memberAdd.error, `${codeOf(ownerAdd)}/${codeOf(memberAdd)}`);
    const memberRead = await B.client.from('room_media_queue').select('id, added_by, media:temporary_media(file_name)').eq('room_id', R).order('position');
    record('members read the queue with who added each item', rows(memberRead) === 2 && memberRead.data?.[1]?.added_by === B.id, `${codeOf(memberRead)} rows=${rows(memberRead)}`);
    const dup = await B.client.rpc('add_media_to_queue', { p_room_id: R, p_media_id: m2 });
    record('duplicate queue entries are rejected', dup.error?.code === '23505', codeOf(dup));
    const crossRoom = await B.client.rpc('add_media_to_queue', { p_room_id: R, p_media_id: mOut });
    record('media from another room cannot be queued', crossRoom.error?.code === 'P0002', codeOf(crossRoom));
    const memberMove = await B.client.rpc('move_media_in_queue', { p_item_id: memberAdd.data, p_to_index: 0 });
    record('a member without watch_control cannot reorder', memberMove.error?.code === '42501', codeOf(memberMove));
    const memberRemoveOther = await B.client.rpc('remove_media_from_queue', { p_item_id: ownerAdd.data });
    record('a member cannot remove someone else\'s item', memberRemoveOther.error?.code === '42501', codeOf(memberRemoveOther));
    const ownerMove = await A.client.rpc('move_media_in_queue', { p_item_id: memberAdd.data, p_to_index: 0 });
    const order = await A.client.from('room_media_queue').select('id').eq('room_id', R).order('position');
    record('the owner reorders the queue', !ownerMove.error && order.data?.[0]?.id === memberAdd.data, codeOf(ownerMove));
    const memberRemoveOwn = await B.client.rpc('remove_media_from_queue', { p_item_id: memberAdd.data });
    record('a member removes their own item', memberRemoveOwn.data === true, codeOf(memberRemoveOwn));
    const directWrite = await B.client.from('room_media_queue').insert({ room_id: R, media_id: m3, added_by: B.id, position: 5 });
    record('direct queue writes are refused', Boolean(directWrite.error), codeOf(directWrite));
    const outsiderAdd = await B.client.rpc('add_media_to_queue', { p_room_id: R2, p_media_id: mOut });
    const outsiderRead = await B.client.from('room_media_queue').select('id').eq('room_id', R2);
    record('an outsider can neither add nor read', outsiderAdd.error?.code === '42501' && rows(outsiderRead) === 0, `${codeOf(outsiderAdd)} rows=${rows(outsiderRead)}`);
    const anonAdd = await anon.rpc('add_media_to_queue', { p_room_id: R, p_media_id: m3 });
    const anonRead = await anon.from('room_media_queue').select('id').eq('room_id', R);
    record('anon can neither add nor read', Boolean(anonAdd.error) && (Boolean(anonRead.error) || rows(anonRead) === 0), `${codeOf(anonAdd)}/${codeOf(anonRead)}`);

    // Clips.
    const memberClip = await B.client.rpc('create_media_clip', { p_room_id: R, p_media_id: m1, p_start: 42.5, p_end: 72.5, p_label: 'Best scene' });
    const ownerClip = await A.client.rpc('create_media_clip', { p_room_id: R, p_media_id: m1, p_start: 5, p_end: null, p_label: 'Intro' });
    record('owner and member save clips', !memberClip.error && !ownerClip.error, `${codeOf(memberClip)}/${codeOf(ownerClip)}`);
    const badClip = await B.client.rpc('create_media_clip', { p_room_id: R, p_media_id: m1, p_start: 50, p_end: 10, p_label: 'Backwards' });
    record('a clip ending before it starts is rejected', badClip.error?.code === '23514', codeOf(badClip));
    const memberDeleteOwner = await B.client.rpc('delete_media_clip', { p_clip_id: ownerClip.data });
    record('a member cannot delete someone else\'s clip', memberDeleteOwner.error?.code === '42501', codeOf(memberDeleteOwner));
    const ownerDeleteMember = await A.client.rpc('delete_media_clip', { p_clip_id: memberClip.data });
    record('the owner deletes any clip', ownerDeleteMember.data === true, codeOf(ownerDeleteMember));

    // Admin: promote B and check the admin defaults.
    const promote = await A.client.rpc('set_room_member_role', { p_room_id: R, p_target_user_id: B.id, p_role: 'admin' });
    const adminCap = await B.client.rpc('room_has_capability', { p_room_id: R, p_user_id: B.id, p_capability: 'watch_control' });
    const adminMove = await B.client.rpc('move_media_in_queue', { p_item_id: ownerAdd.data, p_to_index: 0 });
    const expectAdmin = adminCap.data === true ? !adminMove.error : adminMove.error?.code === '42501';
    record('an admin reorders exactly when the room grants admins watch_control', !promote.error && expectAdmin, `watch_control=${adminCap.data} move=${codeOf(adminMove)}`);
    await A.client.rpc('set_room_member_role', { p_room_id: R, p_target_user_id: B.id, p_role: 'member' });

    // Realtime: heartbeat publishing needs watch_control; hints reach watchers.
    const aEvents = [];
    const bEvents = [];
    const aControl = await listen(A, `sync-control:${R}`, aEvents);
    const bControl = await listen(B, `sync-control:${R}`, bEvents);
    const bWatch = await listen(B, `sync-watch:${R}`, bEvents);
    channels.push([A.client, aControl.channel], [B.client, bControl.channel], [B.client, bWatch.channel]);
    record('owner and member join the Watch topics', aControl.status === 'SUBSCRIBED' && bControl.status === 'SUBSCRIBED' && bWatch.status === 'SUBSCRIBED', `${aControl.status}/${bControl.status}/${bWatch.status}`);
    await bControl.channel.send(wire(B, R, 'media_heartbeat', { mediaId: m1, castId: 'c1', time: 10, speed: 1, playing: true }));
    await aControl.channel.send(wire(A, R, 'media_heartbeat', { mediaId: m1, castId: 'c1', time: 20, speed: 1, playing: true }));
    const aWatch = await listen(A, `sync-watch:${R}`, aEvents);
    channels.push([A.client, aWatch.channel]);
    await aWatch.channel.send(wire(A, R, 'queue_changed', { version: Date.now() }));
    await sleep(2500);
    record('a member cannot publish a heartbeat (watch_control required)', !aEvents.includes('media_heartbeat'), `owner got=${aEvents.join(',') || 'none'}`);
    record('the controller\'s heartbeat and queue hints reach members', bEvents.includes('media_heartbeat') && bEvents.includes('queue_changed'), `member got=${bEvents.join(',')}`);

    // Watch off: queue and clips disappear and writes are refused.
    await A.client.rpc('update_room_controls', { p_room_id: R, p_rules: null, p_welcome_message: null, p_is_locked: null, p_feature_flags: { watch: false } });
    const offRead = await B.client.from('room_media_clips').select('id').eq('room_id', R);
    const offAdd = await B.client.rpc('add_media_to_queue', { p_room_id: R, p_media_id: m3 });
    record('with Watch off, clips are hidden and queueing is refused', rows(offRead) === 0 && offAdd.error?.code === '42501', `rows=${rows(offRead)} ${codeOf(offAdd)}`);
  } finally {
    for (const [client, channel] of channels) await client.removeChannel(channel);
    for (const roomId of [R, R2]) await service.from('rooms').delete().eq('id', roomId).like('name', 'qa-%');
  }

  const passed = results.filter(Boolean).length;
  console.log(`\nsummary: ${passed} pass, ${results.length - passed} fail`);
  process.exit(results.length === passed ? 0 : 1);
}

main().catch((error) => {
  console.error(`watch probe aborted: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
});
