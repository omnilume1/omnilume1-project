// Adaptive workspace probe (Action 09, migration 20261105190000).
//
//   node scripts/security/workspace-probe.mjs
//
// Two disposable QA accounts (OMNILUME_QA_{A,B}_{EMAIL,PASSWORD} or *_FILE).
// A owns a new qa-* room; B is an approved member. Checks that only room
// managers change the shared layout/theme, and that a feature the room turns
// off is refused by the database and by Realtime, not just hidden in the UI.
// The room is deleted with the service role at the end.

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
  console.log(`${pass ? 'PASS' : 'FAIL'}  A09  ${check}${detail ? `  [${detail}]` : ''}`);
};
const codeOf = (res) => (res?.error ? String(res.error.code ?? res.error.statusCode ?? 'error') : 'ok');
const rows = (res) => (Array.isArray(res?.data) ? res.data.length : res?.data ? 1 : 0);

async function signIn(label) {
  const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, options);
  const { data, error } = await client.auth.signInWithPassword({ email: secret(`OMNILUME_QA_${label}_EMAIL`), password: secret(`OMNILUME_QA_${label}_PASSWORD`) });
  if (error || !data.session) throw new Error(`Sign-in failed for account ${label}.`);
  client.realtime.setAuth(data.session.access_token);
  return { client, id: data.user.id };
}

function joinStatus(client, topic) {
  return new Promise((done) => {
    const channel = client.channel(topic, { config: { private: true } });
    const timer = setTimeout(() => finish('NO_RESPONSE'), 10_000);
    let settled = false;
    function finish(status) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void client.removeChannel(channel);
      done(status);
    }
    channel.subscribe((status) => { if (['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) finish(status); });
  });
}

async function setFeatures(owner, roomId, flags) {
  const res = await owner.client.rpc('update_room_controls', { p_room_id: roomId, p_rules: null, p_welcome_message: null, p_is_locked: null, p_feature_flags: flags });
  if (res.error) throw new Error(`feature flags: ${codeOf(res)}`);
}

async function main() {
  const A = await signIn('A');
  const B = await signIn('B');
  const tag = `qa-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  const R = randomUUID();
  const insert = await A.client.from('rooms').insert({ id: R, name: `${tag}-workspace`, description: 'Disposable workspace probe.', is_private: true, expiration_type: 'recoverable', expires_at: new Date(Date.now() + 2 * 3600_000).toISOString(), created_by: A.id, username: null });
  if (insert.error) throw new Error(`room: ${codeOf(insert)}`);
  await A.client.from('room_members').insert({ room_id: R, user_id: A.id, role: 'owner', join_status: 'approved' });

  try {
    const join = await B.client.rpc('request_room_join', { p_identifier: R });
    const approve = await A.client.rpc('review_room_member', { p_room_id: R, p_target_user_id: B.id, p_action: 'approve', p_reason: '' });
    if (join.error || approve.error) throw new Error(`membership: ${codeOf(join)}/${codeOf(approve)}`);

    // Shared layout and theme.
    const ownerSet = await A.client.rpc('update_room_appearance', { p_room_id: R, p_default_layout: 'chat', p_layout_locked: true, p_theme: 'emerald' });
    record('the owner sets the room layout, lock and theme', !ownerSet.error && ownerSet.data?.theme === 'emerald', codeOf(ownerSet));
    const memberSees = await B.client.from('room_control_settings').select('default_layout, layout_locked, theme').eq('room_id', R).single();
    record('members read the shared layout and theme', memberSees.data?.default_layout === 'chat' && memberSees.data?.layout_locked === true && memberSees.data?.theme === 'emerald', codeOf(memberSees));
    const memberSet = await B.client.rpc('update_room_appearance', { p_room_id: R, p_default_layout: 'stage', p_layout_locked: false, p_theme: 'rose' });
    record('a member without manage_settings cannot change them', memberSet.error?.code === '42501', codeOf(memberSet));
    const memberDirect = await B.client.from('room_control_settings').update({ theme: 'rose' }).eq('room_id', R).select('theme');
    record('nor by writing the settings row directly', Boolean(memberDirect.error) || rows(memberDirect) === 0, `${codeOf(memberDirect)} rows=${rows(memberDirect)}`);
    const invalid = await A.client.rpc('update_room_appearance', { p_room_id: R, p_default_layout: 'grid', p_layout_locked: false, p_theme: 'emerald' });
    record('invalid presets are rejected', invalid.error?.code === '22023', codeOf(invalid));
    const changeEvent = await B.client.from('room_control_events').select('id').eq('room_id', R).eq('event_type', 'settings_changed');
    record('the change is announced to members as a room control event', !changeEvent.error && rows(changeEvent) >= 1, `rows=${rows(changeEvent)}`);

    // Baseline while everything is on.
    const seed = await A.client.from('messages').insert({ room_id: R, sender_id: A.id, content: 'before features change' }).select('id').single();
    const baseline = await B.client.from('messages').select('id').eq('room_id', R);
    const chatJoin = await joinStatus(B.client, `sync-chat:${R}`);
    record('with chat on, the member reads chat and joins its channel', !seed.error && rows(baseline) >= 1 && chatJoin === 'SUBSCRIBED', `rows=${rows(baseline)} join=${chatJoin}`);

    await setFeatures(A, R, { chat: false, files: false, study: false, watch: false, announcements: false });

    const chatRead = await B.client.from('messages').select('id').eq('room_id', R);
    record('chat off: messages are not readable', !chatRead.error && rows(chatRead) === 0, `rows=${rows(chatRead)}`);
    const chatWrite = await B.client.from('messages').insert({ room_id: R, sender_id: B.id, content: 'should fail' });
    record('chat off: messages cannot be sent', Boolean(chatWrite.error), codeOf(chatWrite));
    const react = await B.client.rpc('toggle_room_message_reaction', { p_message_id: seed.data?.id, p_emoji: '\u{1F44D}' });
    record('chat off: reactions are refused', react.error?.code === '42501', codeOf(react));
    const chatChannel = await joinStatus(B.client, `sync-chat:${R}`);
    record('chat off: the chat realtime channel refuses the member', chatChannel === 'CHANNEL_ERROR', chatChannel);

    const filesList = await B.client.rpc('list_room_files', { p_room_id: R });
    record('files off: files cannot be listed', Boolean(filesList.error), codeOf(filesList));
    const filesTable = await B.client.from('room_files').select('id').eq('room_id', R);
    record('the files table is never readable directly', filesTable.error?.code === '42501', codeOf(filesTable));
    const filesWrite = await A.client.rpc('register_room_file', { p_room_id: R, p_object_path: `${R}/files/${randomUUID()}.pdf`, p_original_name: 'x.pdf', p_normalized_name: 'x.pdf', p_mime_type: 'application/pdf', p_size_bytes: 10, p_metadata: {} });
    record('files off: even the owner cannot register a file', Boolean(filesWrite.error), codeOf(filesWrite));

    const studyWrite = await B.client.rpc('upsert_room_realtime_snapshot', { p_room_id: R, p_snapshot_type: 'timer', p_state_version: 1, p_payload: { eventType: 'timer_start', payload: { sessionId: randomUUID(), duration: 60 } } });
    record('study off: the shared timer cannot be written', Boolean(studyWrite.error), codeOf(studyWrite));
    const studyChannel = await joinStatus(B.client, `sync-study:${R}`);
    record('study off: the study realtime channel refuses the member', studyChannel === 'CHANNEL_ERROR', studyChannel);

    const watchChannel = await joinStatus(B.client, `sync-watch:${R}`);
    record('watch off: the watch realtime channel refuses the member', watchChannel === 'CHANNEL_ERROR', watchChannel);

    const announcementRead = await B.client.from('room_announcements').select('id').eq('room_id', R);
    const announcementWrite = await A.client.rpc('create_room_announcement', { p_room_id: R, p_body: 'should fail', p_is_pinned: false });
    record('announcements off: none are readable and none can be posted', !announcementRead.error && rows(announcementRead) === 0 && Boolean(announcementWrite.error), `${rows(announcementRead)} / ${codeOf(announcementWrite)}`);

    const general = await joinStatus(B.client, `sync:${R}`);
    record('the general room channel (membership only) still works', general === 'SUBSCRIBED', general);

    await setFeatures(A, R, { chat: true, files: true, study: true, watch: true, announcements: true });
    const restored = await B.client.from('messages').select('id').eq('room_id', R);
    const restoredJoin = await joinStatus(B.client, `sync-chat:${R}`);
    record('turning chat back on restores access', rows(restored) >= 1 && restoredJoin === 'SUBSCRIBED', `rows=${rows(restored)} join=${restoredJoin}`);
  } finally {
    await service.from('rooms').delete().eq('id', R).like('name', 'qa-%');
  }

  const passed = results.filter(Boolean).length;
  console.log(`\nsummary: ${passed} pass, ${results.length - passed} fail`);
  process.exit(results.length === passed ? 0 : 1);
}

main().catch((error) => {
  console.error(`workspace probe aborted: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
});
