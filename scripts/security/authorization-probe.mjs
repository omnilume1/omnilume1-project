// Authorization behavior probes for Actions 01-10 (audit T1-T8, D1/D2, F1).
//
//   node scripts/security/authorization-probe.mjs anon
//   node scripts/security/authorization-probe.mjs full
//
// "anon" needs only NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY
// (read from the environment or .env.local). "full" also needs two disposable
// accounts that hold no real content:
//   OMNILUME_QA_A_EMAIL, OMNILUME_QA_A_PASSWORD (room owner)
//   OMNILUME_QA_B_EMAIL, OMNILUME_QA_B_PASSWORD (second account)
// Each value may instead be supplied as a file path in <NAME>_FILE.
//
// Every call goes through the public Data, Storage and Realtime APIs with the
// anon key and the account's own session, exactly as a browser would. The
// service-role key is never read. Fixtures are new qa-<date>-<random> rooms
// that expire on their own (irreversible, 2 hours) and are destroyed by the
// normal cleanup job. No existing row is read or changed, and nothing is
// truncated or bulk-deleted. Output contains only ids, status codes and
// pass/fail: never tokens, signed URLs, or message content.

import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mode = process.argv[2];
if (mode !== 'anon' && mode !== 'full' && mode !== 'routes') {
  console.error('Usage: node scripts/security/authorization-probe.mjs <anon|full|routes [baseUrl]>');
  process.exit(2);
}

const projectRoot = resolve(import.meta.dirname, '..', '..');
const BUCKET = 'room_attachments';

function readEnvLocal() {
  try {
    const values = {};
    for (const line of readFileSync(resolve(projectRoot, '.env.local'), 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
    return values;
  } catch {
    return {};
  }
}

const envLocal = readEnvLocal();
// Only the two public client values are taken from .env.local.
const setting = (name) => process.env[name] ?? (name.startsWith('NEXT_PUBLIC_') ? envLocal[name] : undefined);
function secret(name) {
  if (process.env[name]) return process.env[name];
  const file = process.env[`${name}_FILE`];
  return file ? readFileSync(file, 'utf8').trim() : undefined;
}

const url = setting('NEXT_PUBLIC_SUPABASE_URL');
const anonKey = setting('NEXT_PUBLIC_SUPABASE_ANON_KEY');
if (!url || !anonKey) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required.');
  process.exit(2);
}

const results = [];
function record(test, check, pass, detail = '') {
  results.push({ test, check, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${test}  ${check}${detail ? `  [${detail}]` : ''}`);
}
function blocked(test, check, reason) {
  results.push({ test, check, pass: null, detail: reason });
  console.log(`BLOCKED  ${test}  ${check}  [${reason}]`);
}
const codeOf = (res) => {
  if (!res?.error) return 'ok';
  const error = res.error;
  return String(error.code ?? error.statusCode ?? error.status ?? error.name ?? 'error');
};
const rowsOf = (res) => (Array.isArray(res?.data) ? res.data.length : res?.data ? 1 : 0);
const deniedOrEmpty = (res) => Boolean(res.error) || rowsOf(res) === 0;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const newClient = () =>
  createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });

async function signIn(label, email, password) {
  const client = newClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`Sign-in failed for account ${label}: ${error?.message ?? 'no session'}`);
  client.realtime.setAuth(data.session.access_token);
  return { client, id: data.user.id, label };
}

// Measured behavior that is neither pass nor fail (for example transport-level
// residuals that a design decision accepts).
function info(test, check, detail = '') {
  results.push({ test, check, pass: 'info', detail });
  console.log(`INFO  ${test}  ${check}${detail ? `  [${detail}]` : ''}`);
}

function joinChannel(channel) {
  return new Promise((done) => {
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(status);
    };
    const timer = setTimeout(() => finish('NO_RESPONSE'), 10_000);
    channel.subscribe((status) => {
      if (['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) finish(status);
    });
  });
}

async function subscribe(client, topic, onEvent) {
  const channel = client.channel(topic, { config: { private: true, broadcast: { self: false } } });
  if (onEvent) channel.on('broadcast', { event: 'qa-probe' }, (message) => onEvent(message.payload));
  return { channel, status: await joinChannel(channel) };
}

// Opens exactly the room subscriptions the app opens (useRoomSync and
// useRoomPresence) and records everything delivered. Used for both the
// hostile removed connection and the remaining-member observer.
async function mirrorRoomSubscriptions(client, roomId, log) {
  const now = () => Date.now();
  const userId = (await client.auth.getUser()).data.user?.id;
  const general = client.channel(`sync:${roomId}`, { config: { private: true } });
  general.on('broadcast', { event: 'room_action' }, (message) => log.push({ at: now(), kind: 'broadcast', topic: 'sync', payload: message.payload }));
  for (const event of ['INSERT', 'UPDATE']) {
    general.on('postgres_changes', { event, schema: 'public', table: 'messages', filter: `room_id=eq.${roomId}` }, (change) => log.push({ at: now(), kind: 'chat', eventType: change.eventType, row: change.new }));
  }
  general.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_control_events', filter: `room_id=eq.${roomId}` }, (change) => log.push({ at: now(), kind: 'control', row: change.new }));
  // Postgres Changes becomes active only when Realtime sends this system
  // message, some time after SUBSCRIBED.
  general.on('system', {}, (message) => log.push({ at: now(), kind: 'system', extension: message?.extension, status: message?.status }));
  const control = client.channel(`sync-control:${roomId}`, { config: { private: true } });
  control.on('broadcast', { event: 'room_action' }, (message) => log.push({ at: now(), kind: 'broadcast', topic: 'sync-control', payload: message.payload }));
  const presence = client.channel(`presence:${roomId}`, { config: { private: true, presence: { key: userId } } });
  presence.on('presence', { event: 'sync' }, () => log.push({ at: now(), kind: 'presence', keys: Object.keys(presence.presenceState()) }));
  const channels = [general, control, presence];
  const statuses = await Promise.all(channels.map(joinChannel));
  if (statuses[2] === 'SUBSCRIBED') await presence.track({ user_id: userId, online_at: new Date().toISOString() }).catch(() => undefined);
  return { channels, statuses };
}

// Phase 2: the same room topics joined as PUBLIC channels (no private flag),
// recording every Broadcast and every presence state they see.
async function openPublicListeners(client, roomId, log) {
  const now = () => Date.now();
  const channels = ['sync', 'sync-control', 'presence'].map((kind) => {
    const channel = client.channel(`${kind}:${roomId}`, { config: { private: false } });
    channel.on('broadcast', { event: '*' }, (message) => log.push({ at: now(), kind: 'broadcast', topic: kind, event: message.event }));
    if (kind === 'presence') channel.on('presence', { event: 'sync' }, () => log.push({ at: now(), kind: 'presence', keys: Object.keys(channel.presenceState()) }));
    return channel;
  });
  return { channels, statuses: await Promise.all(channels.map(joinChannel)) };
}

function jwtLifetimeSeconds(accessToken) {
  try {
    const claims = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'));
    return claims.exp - claims.iat;
  } catch {
    return null;
  }
}

async function anonPhase() {
  const anon = newClient();
  const zero = randomUUID();

  // D2 / T5: privilege denial (42501) proves the revoke, not just a function-body check.
  const restricted = [
    ['is_room_admin_or_owner', { p_room_id: zero, p_user_id: zero }],
    ['get_room_for_join', { identifier: `qa-${zero}` }],
    ['review_recovery_request', { p_request_id: zero, p_decision: 'rejected' }],
    ['review_permanent_room_request', { p_request_id: zero, p_decision: 'rejected' }],
    ['convert_active_room_to_permanent', { p_room_id: zero, p_username: null }],
  ];
  for (const [name, args] of restricted) {
    const res = await anon.rpc(name, args);
    const code = codeOf(res);
    record('T5', `anon EXECUTE ${name} denied by privilege`, code === '42501' || code === 'PGRST202', code);
  }

  for (const table of ['messages', 'room_members', 'room_messages', 'room_notifications', 'temporary_media', 'study_notes', 'room_files', 'message_requests']) {
    const res = await anon.from(table).select('*').limit(1);
    record('T5', `anon SELECT ${table} returns nothing`, deniedOrEmpty(res), `${codeOf(res)} rows=${rowsOf(res)}`);
  }
  const privateRooms = await anon.from('rooms').select('id').eq('is_private', true).limit(1);
  record('T5', 'anon cannot list private rooms', deniedOrEmpty(privateRooms), `${codeOf(privateRooms)} rows=${rowsOf(privateRooms)}`);

  const insert = await anon.from('messages').insert({ room_id: zero, sender_id: zero, content: 'qa anon probe' });
  record('T5', 'anon INSERT messages denied', Boolean(insert.error), codeOf(insert));

  const list = await anon.storage.from(BUCKET).list('', { limit: 1 });
  record('T6', 'anon cannot list room_attachments', deniedOrEmpty(list), `${codeOf(list)} rows=${rowsOf(list)}`);

  const channel = await subscribe(anon, `sync:${zero}`);
  record('T7', 'anon cannot join a private room channel', channel.status !== 'SUBSCRIBED', channel.status);
  await anon.removeChannel(channel.channel);
}

async function createRoom(owner, { tag, suffix, type = 'irreversible', expiresInMs = 2 * 60 * 60 * 1000 }) {
  const roomId = randomUUID();
  const room = await owner.client.from('rooms').insert({
    id: roomId,
    name: `${tag}-${suffix}`,
    description: 'Disposable authorization probe. Expires automatically.',
    is_private: true,
    expiration_type: type,
    expires_at: new Date(Date.now() + expiresInMs).toISOString(),
    created_by: owner.id,
    username: null,
  });
  if (room.error) throw new Error(`room fixture ${suffix}: ${codeOf(room)} ${room.error.message}`);
  const member = await owner.client.from('room_members').insert({ room_id: roomId, user_id: owner.id, role: 'owner', join_status: 'approved' });
  if (member.error) throw new Error(`owner membership fixture ${suffix}: ${codeOf(member)} ${member.error.message}`);
  return roomId;
}

const tinyMedia = () => new Blob([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50])], { type: 'video/mp4' });

async function objectExists(client, path) {
  const folder = path.slice(0, path.lastIndexOf('/'));
  const name = path.slice(path.lastIndexOf('/') + 1);
  const res = await client.storage.from(BUCKET).list(folder, { search: name, limit: 10 });
  return !res.error && (res.data ?? []).some((entry) => entry.name === name);
}

async function fullPhase() {
  const creds = ['A', 'B'].map((label) => ({
    label,
    email: secret(`OMNILUME_QA_${label}_EMAIL`),
    password: secret(`OMNILUME_QA_${label}_PASSWORD`),
  }));
  const missing = creds.filter((cred) => !cred.email || !cred.password).map((cred) => cred.label);
  if (missing.length) {
    blocked('T1-T8', 'two disposable accounts', `missing credentials for account(s) ${missing.join(', ')}`);
    return;
  }

  const [A, B] = await Promise.all(creds.map((cred) => signIn(cred.label, cred.email, cred.password)));
  // D: JWT lifetime bounds how long a non-refreshing removed connection keeps
  // its Realtime join (measured, never changed by this script).
  const { data: sessionData } = await A.client.auth.getSession();
  info('D7', 'access-token lifetime (exp - iat)', `${jwtLifetimeSeconds(sessionData.session?.access_token ?? '') ?? 'unknown'} s`);
  if (A.id === B.id) throw new Error('Accounts A and B must be different users.');

  const tag = `qa-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  console.log(`fixture tag ${tag}`);
  const R1 = await createRoom(A, { tag, suffix: 'r1' });
  const R2 = await createRoom(B, { tag, suffix: 'r2' });
  console.log(`fixture rooms R1=${R1} (owner A) R2=${R2} (owner B)`);

  const channels = [];
  const extraClients = [];
  let restoreBPrivacy = null;
  try {
    // ---- Fixtures in R1 created by the owner through normal APIs.
    const ownerMessage = await A.client.from('messages').insert({ room_id: R1, sender_id: A.id, content: 'qa owner probe' });
    record('T3', 'owner sends a room message', !ownerMessage.error, codeOf(ownerMessage));

    const mediaPath = `${R1}/media/${randomUUID()}.mp4`;
    const upload = await A.client.storage.from(BUCKET).upload(mediaPath, tinyMedia(), { contentType: 'video/mp4', upsert: false });
    record('F1', 'owner uploads to the <room>/media/<uuid>.mp4 contract path', !upload.error, codeOf(upload));
    const legacy = await A.client.storage.from(BUCKET).upload(`${R1}/temp-${Date.now()}-qa.mp4`, tinyMedia(), { contentType: 'video/mp4', upsert: false });
    record('F1', 'legacy <room>/temp-* upload path is rejected (pre-fix app path)', Boolean(legacy.error), codeOf(legacy));
    const directMedia = await A.client.from('temporary_media').insert({
      room_id: R1, user_id: A.id, file_name: 'qa.mp4', file_url: mediaPath, media_type: 'video', expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    record('F1', 'direct temporary_media INSERT is rejected (pre-fix app call)', Boolean(directMedia.error), codeOf(directMedia));
    const registered = await A.client.rpc('register_temporary_media', {
      p_room_id: R1, p_file_name: 'qa-probe.mp4', p_file_path: mediaPath, p_media_type: 'video', p_mime_type: 'video/mp4', p_file_size: tinyMedia().size,
    });
    record('F1', 'register_temporary_media accepts the fixed app call shape', !registered.error, codeOf(registered));
    const mediaId = (Array.isArray(registered.data) ? registered.data[0] : registered.data)?.id ?? null;

    const note = await A.client.rpc('create_study_note', { p_room_id: R1, p_scope: 'room', p_title: 'qa probe', p_content: 'qa probe' });
    const noteRow = Array.isArray(note.data) ? note.data[0] : note.data;
    if (note.error || !noteRow?.id) blocked('T5', 'study-note fixture', codeOf(note));

    // ---- Phase 2: public-channel bypass. "Allow public access" is enabled,
    // so B (not a member) subscribes to the room topics WITHOUT private:true.
    // These listeners stay open for the whole run (non-member, member,
    // removed). A publishes only on the private topics. Any delivery here
    // means the public and private topics are not isolated.
    // Separate connections: one client cannot join the same topic twice, and
    // A and B join these topics privately later in the run.
    const publicB = await signIn('B', creds[1].email, creds[1].password);
    const publisherA = await signIn('A', creds[0].email, creds[0].password);
    extraClients.push(publicB.client, publisherA.client);
    const publicLog = [];
    const publicListener = await openPublicListeners(publicB.client, R1, publicLog);
    for (const channel of publicListener.channels) channels.push([publicB.client, channel]);
    info('P2', 'public (non-private) joins of sync/sync-control/presence for R1', publicListener.statuses.join('/'));
    const ownerPrivateSync = await subscribe(publisherA.client, `sync:${R1}`);
    const ownerPrivatePresence = publisherA.client.channel(`presence:${R1}`, { config: { private: true, presence: { key: A.id } } });
    const ownerPresenceStatus = await joinChannel(ownerPrivatePresence);
    channels.push([publisherA.client, ownerPrivateSync.channel], [publisherA.client, ownerPrivatePresence]);
    if (ownerPresenceStatus === 'SUBSCRIBED') await ownerPrivatePresence.track({ user_id: A.id, online_at: new Date().toISOString() }).catch(() => undefined);
    await ownerPrivateSync.channel.send({ type: 'broadcast', event: 'room_action', payload: { event_id: randomUUID(), sender_id: A.id, timestamp: Date.now(), room_id: R1, event_type: 'typing', payload: {}, state_version: 1 } });
    await ownerPrivateSync.channel.send({ type: 'broadcast', event: 'qa-probe', payload: { n: 0 } });
    await sleep(3_000);
    record('P2', 'non-member public subscriber receives no private room Broadcast', !publicLog.some((entry) => entry.kind === 'broadcast'), `entries=${publicLog.length}`);
    record('P2', 'non-member public presence does not see members on the private topic', !publicLog.some((entry) => entry.kind === 'presence' && entry.keys.includes(A.id)));

    // ---- T6 / T8 / T5: B is authenticated but not a member of R1.
    const r2Message = await B.client.from('messages').insert({ room_id: R2, sender_id: B.id, content: 'qa r2 probe' });
    const r2Read = await B.client.from('messages').select('id').eq('room_id', R2);
    record('T8', 'positive control: B reads its own room R2', !r2Message.error && rowsOf(r2Read) >= 1, `${codeOf(r2Message)} rows=${rowsOf(r2Read)}`);

    for (const table of ['messages', 'room_members', 'temporary_media', 'room_messages', 'room_notifications']) {
      const res = await B.client.from(table).select('*').eq('room_id', R1);
      record('T8', `non-member B reads no R1 ${table}`, deniedOrEmpty(res), `${codeOf(res)} rows=${rowsOf(res)}`);
    }
    const roomRow = await B.client.from('rooms').select('id').eq('id', R1);
    record('T8', 'non-member B cannot see private room R1', deniedOrEmpty(roomRow), `${codeOf(roomRow)} rows=${rowsOf(roomRow)}`);
    for (const [name, args] of [
      ['list_study_notes', { p_room_id: R1 }],
      ['get_room_realtime_snapshots', { p_room_id: R1 }],
      ['get_room_whiteboard', { p_room_id: R1 }],
      ['get_room_member_identities', { p_room_id: R1 }],
    ]) {
      const res = await B.client.rpc(name, args);
      record('T8', `non-member B ${name}(R1) denied`, deniedOrEmpty(res), `${codeOf(res)} rows=${rowsOf(res)}`);
    }
    const crossSync = await subscribe(B.client, `sync:${R1}`);
    record('T8', 'non-member B cannot join sync:R1', crossSync.status !== 'SUBSCRIBED', crossSync.status);
    await B.client.removeChannel(crossSync.channel);
    const crossPresence = await subscribe(B.client, `presence:${R1}`);
    record('T8', 'non-member B cannot join presence:R1', crossPresence.status !== 'SUBSCRIBED', crossPresence.status);
    await B.client.removeChannel(crossPresence.channel);

    const outsiderSigned = await B.client.storage.from(BUCKET).createSignedUrl(mediaPath, 60);
    record('T6', 'non-member B cannot create a signed URL', Boolean(outsiderSigned.error) || !outsiderSigned.data?.signedUrl, codeOf(outsiderSigned));
    const outsiderDownload = await B.client.storage.from(BUCKET).download(mediaPath);
    record('T6', 'non-member B cannot download the object', Boolean(outsiderDownload.error), codeOf(outsiderDownload));
    const outsiderUpload = await B.client.storage.from(BUCKET).upload(`${R1}/media/${randomUUID()}.mp4`, tinyMedia(), { contentType: 'video/mp4' });
    record('T6', 'non-member B cannot upload into R1', Boolean(outsiderUpload.error), codeOf(outsiderUpload));
    const traversal = await B.client.storage.from(BUCKET).createSignedUrl(`${R2}/media/../../${mediaPath}`, 60);
    record('T6', 'path traversal from B-owned R2 into R1 is denied', Boolean(traversal.error) || !traversal.data?.signedUrl, codeOf(traversal));
    await B.client.storage.from(BUCKET).remove([mediaPath]);
    record('T6', 'non-member B delete leaves the object intact', await objectExists(A.client, mediaPath));

    if (noteRow?.id) {
      const tamper = await B.client.rpc('update_study_note', { p_note_id: noteRow.id, p_expected_version: noteRow.version ?? 1, p_title: 'tampered', p_content: 'tampered' });
      record('T5', 'non-member B update_study_note denied', Boolean(tamper.error), codeOf(tamper));
      const remove = await B.client.rpc('delete_study_note', { p_note_id: noteRow.id });
      record('T5', 'non-member B delete_study_note denied', Boolean(remove.error), codeOf(remove));
    }
    const board = await B.client.rpc('save_room_whiteboard', { p_room_id: R1, p_expected_version: 0, p_state: {} });
    record('T5', 'non-member B save_room_whiteboard denied', Boolean(board.error), codeOf(board));
    const memberDelete = await B.client.rpc('begin_room_file_delete', { p_file_id: randomUUID() });
    record('T5', 'B begin_room_file_delete on an unknown file denied', Boolean(memberDelete.error), codeOf(memberDelete));

    // ---- B joins R1 and the owner approves.
    const join = await B.client.rpc('request_room_join', { p_identifier: R1 });
    const joinRow = Array.isArray(join.data) ? join.data[0] : join.data;
    record('T1', 'B requests to join private R1 (pending)', !join.error && joinRow?.status === 'pending', `${codeOf(join)} ${joinRow?.status ?? ''}`);
    const approve = await A.client.rpc('review_room_member', { p_room_id: R1, p_target_user_id: B.id, p_action: 'approve', p_reason: '' });
    record('T2', 'owner approves B', !approve.error, codeOf(approve));

    // ---- T1 member access.
    const memberRead = await B.client.from('messages').select('id').eq('room_id', R1);
    record('T1', 'member B reads R1 messages', !memberRead.error && rowsOf(memberRead) >= 1, `${codeOf(memberRead)} rows=${rowsOf(memberRead)}`);
    const memberSigned = await B.client.storage.from(BUCKET).createSignedUrl(mediaPath, 60);
    record('T6', 'member B (watch) creates a signed URL', !memberSigned.error && Boolean(memberSigned.data?.signedUrl), codeOf(memberSigned));
    const memberNotes = await B.client.rpc('list_study_notes', { p_room_id: R1 });
    record('T1', 'member B lists study notes', !memberNotes.error, codeOf(memberNotes));
    const memberUpload = await B.client.storage.from(BUCKET).upload(`${R1}/media/${randomUUID()}.mp4`, tinyMedia(), { contentType: 'video/mp4' });
    record('T6', 'member B without watch_control cannot upload media', Boolean(memberUpload.error), codeOf(memberUpload));
    await B.client.storage.from(BUCKET).remove([mediaPath]);
    record('T6', 'member B without watch_control cannot delete media', await objectExists(A.client, mediaPath));

    // ---- D8: subtitle bound to its media row (20261105100000).
    const subtitlePath = `${R1}/subtitles/${randomUUID()}.vtt`;
    const subtitleUpload = await A.client.storage.from(BUCKET).upload(subtitlePath, new Blob(['WEBVTT\n\n00:00.000 --> 00:01.000\nqa\n'], { type: 'text/vtt' }), { contentType: 'text/vtt', upsert: false });
    const attach = mediaId ? await A.client.rpc('set_temporary_media_subtitle', { p_media_id: mediaId, p_subtitle_path: subtitlePath }) : { error: { code: 'no_media' } };
    record('D8', 'owner attaches a valid <room>/subtitles/<uuid>.vtt to its media', !subtitleUpload.error && !attach.error, `${codeOf(subtitleUpload)}/${codeOf(attach)}`);
    const badAttach = mediaId ? await A.client.rpc('set_temporary_media_subtitle', { p_media_id: mediaId, p_subtitle_path: `${R2}/subtitles/${randomUUID()}.vtt` }) : { error: { code: 'no_media' } };
    record('D8', 'subtitle path from another room is rejected', Boolean(badAttach.error), codeOf(badAttach));
    const memberAttach = mediaId ? await B.client.rpc('set_temporary_media_subtitle', { p_media_id: mediaId, p_subtitle_path: subtitlePath }) : { error: { code: 'no_media' } };
    record('D8', 'member without watch_control cannot attach subtitles', Boolean(memberAttach.error), codeOf(memberAttach));
    const memberSubtitleRow = await B.client.from('temporary_media').select('subtitle_path').eq('id', mediaId).maybeSingle();
    const memberSubtitleUrl = memberSubtitleRow.data?.subtitle_path ? await B.client.storage.from(BUCKET).createSignedUrl(memberSubtitleRow.data.subtitle_path, 60) : { error: { code: 'no_subtitle' } };
    record('D8', 'member resolves the subtitle under RLS (resolveRoomMedia path)', memberSubtitleRow.data?.subtitle_path === subtitlePath && !memberSubtitleUrl.error, `${codeOf(memberSubtitleRow)}/${codeOf(memberSubtitleUrl)}`);

    // ---- D6: `files` deletion through room_file_owned_by_caller (20261105090000).
    const tinyPdf = () => new Blob(['%PDF-1.4\n%qa\n'], { type: 'application/pdf' });
    const registerFile = async (actor, label) => {
      const path = `${R1}/files/${randomUUID()}.pdf`;
      const upload = await actor.client.storage.from(BUCKET).upload(path, tinyPdf(), { contentType: 'application/pdf', upsert: false });
      const registered = upload.error ? upload : await actor.client.rpc('register_room_file', {
        p_room_id: R1, p_object_path: path, p_original_name: `${label}.pdf`, p_normalized_name: `${label}.pdf`, p_mime_type: 'application/pdf', p_size_bytes: tinyPdf().size, p_metadata: {},
      });
      const row = Array.isArray(registered.data) ? registered.data[0] : registered.data;
      return { path, id: row?.id ?? null, code: codeOf(registered) };
    };
    const ownerFile = await registerFile(A, 'qa-owner-file');
    const memberFile = await registerFile(B, 'qa-member-file');
    const memberFileForOwner = await registerFile(B, 'qa-member-file-2');
    const formerUploaderFile = await registerFile(B, 'qa-member-file-3');
    record('D6', 'owner and member upload and register room files', [ownerFile, memberFile, memberFileForOwner, formerUploaderFile].every((file) => file.id), [ownerFile, memberFile, memberFileForOwner, formerUploaderFile].map((file) => file.code).join('/'));
    await B.client.storage.from(BUCKET).remove([ownerFile.path]);
    record('D6', 'member cannot delete a file owned by someone else', await objectExists(A.client, ownerFile.path));
    const beginOwn = memberFile.id ? await B.client.rpc('begin_room_file_delete', { p_file_id: memberFile.id }) : { error: { code: 'no_file' } };
    const removeOwn = await B.client.storage.from(BUCKET).remove([memberFile.path]);
    const ownGone = !(await objectExists(A.client, memberFile.path));
    const completeOwn = memberFile.id ? await B.client.rpc('complete_room_file_delete', { p_file_id: memberFile.id, p_error: null }) : { error: { code: 'no_file' } };
    record('D6', 'file owner deletes own file (begin, storage delete, complete)', !beginOwn.error && !removeOwn.error && ownGone && !completeOwn.error, `${codeOf(beginOwn)}/${removeOwn.error ? `${codeOf(removeOwn)} ${removeOwn.error.message}` : 'ok'}/gone=${ownGone}/${codeOf(completeOwn)}`);
    const ownerRemoves = await A.client.storage.from(BUCKET).remove([memberFileForOwner.path]);
    record('D6', 'room owner deletes a member file (owner/admin branch)', !ownerRemoves.error && !(await objectExists(A.client, memberFileForOwner.path)), ownerRemoves.error ? `${codeOf(ownerRemoves)} ${ownerRemoves.error.message}` : 'ok');
    const crossRoom = await B.client.storage.from(BUCKET).remove([`${R1}/files/../../${R2}/media/${randomUUID()}.mp4`, ownerFile.path]);
    record('D6', 'cross-room and traversal deletes change nothing', await objectExists(A.client, ownerFile.path), codeOf(crossRoom));

    // ---- T7 realtime while a member.
    const received = [];
    const ownerChannel = await subscribe(A.client, `sync:${R1}`);
    const memberChannel = await subscribe(B.client, `sync:${R1}`, (payload) => received.push(payload?.n));
    channels.push([A.client, ownerChannel.channel], [B.client, memberChannel.channel]);
    record('T7', 'owner and member join sync:R1', ownerChannel.status === 'SUBSCRIBED' && memberChannel.status === 'SUBSCRIBED', `${ownerChannel.status}/${memberChannel.status}`);
    await ownerChannel.channel.send({ type: 'broadcast', event: 'qa-probe', payload: { n: 1 } });
    await sleep(3_000);
    record('T7', 'member receives an owner broadcast', received.includes(1), `received=${JSON.stringify(received)}`);

    // ---- T3 chat capability (D1) through direct Data API inserts.
    const send = (n) => B.client.from('messages').insert({ room_id: R1, sender_id: B.id, content: `qa member probe ${n}` });
    const baseline = await send(1);
    record('T3', 'member with chat sends a room message', !baseline.error, codeOf(baseline));
    const revoke = await A.client.rpc('set_room_role_permission', { p_room_id: R1, p_role: 'member', p_capability: 'chat', p_allowed: false });
    record('T2', 'owner revokes member chat permission', !revoke.error, codeOf(revoke));
    const blockedByRole = await send(2);
    record('T3', 'member without chat permission cannot insert (D1)', Boolean(blockedByRole.error), codeOf(blockedByRole));
    const restore = await A.client.rpc('set_room_role_permission', { p_room_id: R1, p_role: 'member', p_capability: 'chat', p_allowed: true });
    const restored = await send(3);
    record('T3', 'restored chat permission sends again', !restore.error && !restored.error, `${codeOf(restore)}/${codeOf(restored)}`);
    const disable = await A.client.rpc('update_room_controls', { p_room_id: R1, p_rules: null, p_welcome_message: null, p_is_locked: null, p_feature_flags: { chat: false } });
    record('T2', 'owner disables the chat feature', !disable.error, codeOf(disable));
    const blockedByFeature = await send(4);
    record('T3', 'chat feature off blocks member inserts', Boolean(blockedByFeature.error), codeOf(blockedByFeature));
    const ownerBlocked = await A.client.from('messages').insert({ room_id: R1, sender_id: A.id, content: 'qa owner probe 2' });
    record('T3', 'chat feature off blocks owner inserts', Boolean(ownerBlocked.error), codeOf(ownerBlocked));
    const enable = await A.client.rpc('update_room_controls', { p_room_id: R1, p_rules: null, p_welcome_message: null, p_is_locked: null, p_feature_flags: { chat: true } });
    const afterEnable = await send(5);
    record('T3', 'chat feature on restores member inserts', !enable.error && !afterEnable.error, `${codeOf(enable)}/${codeOf(afterEnable)}`);

    // ---- T2 role boundaries for an ordinary member.
    for (const [name, args] of [
      ['set_room_member_role', { p_room_id: R1, p_target_user_id: B.id, p_role: 'admin' }],
      ['set_room_role_permission', { p_room_id: R1, p_role: 'member', p_capability: 'manage_settings', p_allowed: true }],
      ['update_room_controls', { p_room_id: R1, p_rules: 'qa tamper', p_welcome_message: null, p_is_locked: null, p_feature_flags: null }],
      ['create_room_invite', { p_room_id: R1, p_expires_at: null, p_max_uses: 1, p_guest_lifetime_minutes: null }],
      ['review_room_member', { p_room_id: R1, p_target_user_id: A.id, p_action: 'kick', p_reason: '' }],
      ['transfer_room_ownership', { p_room_id: R1, p_target_user_id: B.id }],
      ['create_room_announcement', { p_room_id: R1, p_body: 'qa tamper', p_is_pinned: false }],
    ]) {
      const res = await B.client.rpc(name, args);
      record('T2', `member B ${name} denied`, Boolean(res.error), codeOf(res));
    }
    const escalate = await B.client.from('room_members').update({ role: 'admin' }).eq('room_id', R1).eq('user_id', B.id).select('role');
    record('T2', 'member B direct role escalation changes nothing', deniedOrEmpty(escalate), `${codeOf(escalate)} rows=${rowsOf(escalate)}`);
    const rename = await B.client.from('rooms').update({ name: 'qa tamper' }).eq('id', R1).select('id');
    record('T2', 'member B direct room update changes nothing', deniedOrEmpty(rename), `${codeOf(rename)} rows=${rowsOf(rename)}`);
    const permissionRow = await B.client.from('room_role_permissions').insert({ room_id: R1, role: 'member', capability: 'manage_members', allowed: true });
    record('T2', 'member B direct permission insert denied', Boolean(permissionRow.error), codeOf(permissionRow));
    const roles = await A.client.from('room_members').select('user_id, role').eq('room_id', R1);
    const roleOf = (id) => (roles.data ?? []).find((row) => row.user_id === id)?.role;
    record('T2', 'post-check: A is owner and B is member', roleOf(A.id) === 'owner' && roleOf(B.id) === 'member', `A=${roleOf(A.id)} B=${roleOf(B.id)}`);

    // ---- T2 admin positive path, then restore.
    const promote = await A.client.rpc('set_room_member_role', { p_room_id: R1, p_target_user_id: B.id, p_role: 'admin' });
    record('T2', 'owner promotes B to admin', !promote.error, codeOf(promote));
    const invite = await B.client.rpc('create_room_invite', { p_room_id: R1, p_expires_at: null, p_max_uses: 1, p_guest_lifetime_minutes: null });
    const inviteRow = Array.isArray(invite.data) ? invite.data[0] : invite.data;
    record('T2', 'admin B creates an invite', !invite.error && Boolean(inviteRow?.id), codeOf(invite));
    if (inviteRow?.id) {
      const revokeInvite = await B.client.rpc('revoke_room_invite', { p_invite_id: inviteRow.id });
      record('T2', 'admin B revokes the invite', !revokeInvite.error, codeOf(revokeInvite));
    }
    const adminKicksOwner = await B.client.rpc('review_room_member', { p_room_id: R1, p_target_user_id: A.id, p_action: 'kick', p_reason: '' });
    record('T2', 'admin B cannot kick the owner', Boolean(adminKicksOwner.error), codeOf(adminKicksOwner));
    const adminTransfers = await B.client.rpc('transfer_room_ownership', { p_room_id: R1, p_target_user_id: B.id });
    record('T2', 'admin B cannot take ownership', Boolean(adminTransfers.error), codeOf(adminTransfers));
    const demote = await A.client.rpc('set_room_member_role', { p_room_id: R1, p_target_user_id: B.id, p_role: 'member' });
    record('T2', 'owner demotes B back to member', !demote.error, codeOf(demote));

    // ---- D7 setup. HOSTILE: a separate raw connection for B that mirrors the
    // app's room subscriptions, never refreshes its token and ignores removal
    // events. OBSERVER: an independent connection for the remaining member.
    // A publishes through the app's real wire contract module.
    const contract = await import(new URL('../../src/lib/room-broadcast-contract.ts', import.meta.url).href);
    const marker = `qa-d7-${randomUUID().slice(0, 8)}`;
    const hostile = await signIn('B', creds[1].email, creds[1].password);
    const observer = await signIn('A', creds[0].email, creds[0].password);
    extraClients.push(hostile.client, observer.client);
    const hostileLog = [];
    const observerLog = [];
    const subscribedAt = Date.now();
    const hostileSubs = await mirrorRoomSubscriptions(hostile.client, R1, hostileLog);
    const observerSubs = await mirrorRoomSubscriptions(observer.client, R1, observerLog);
    const feedReady = (log) => log.find((entry) => entry.kind === 'system' && entry.extension === 'postgres_changes' && entry.status === 'ok');
    for (let waited = 0; waited < 20_000 && !(feedReady(hostileLog) && feedReady(observerLog)); waited += 250) await sleep(250);
    info('D7', 'Postgres Changes ready after channel join (hostile/observer)', `${feedReady(hostileLog) ? feedReady(hostileLog).at - subscribedAt : 'never'} ms / ${feedReady(observerLog) ? feedReady(observerLog).at - subscribedAt : 'never'} ms`);
    for (const channel of hostileSubs.channels) channels.push([hostile.client, channel]);
    for (const channel of observerSubs.channels) channels.push([observer.client, channel]);
    record('D7', 'hostile and observer connections join sync, sync-control and presence', [...hostileSubs.statuses, ...observerSubs.statuses].every((status) => status === 'SUBSCRIBED'), `${hostileSubs.statuses.join('/')} | ${observerSubs.statuses.join('/')}`);
    const ownerControl = await subscribe(A.client, `sync-control:${R1}`);
    channels.push([A.client, ownerControl.channel]);

    const MEDIA_EVENTS = new Set(['cast', 'stop_cast', 'subtitle_upload', 'force_sync', 'play', 'pause', 'seek', 'mute']);
    const sendRoomAction = async (eventType, fullPayload = {}) => {
      // Exactly what useRoomSync.broadcastEvent sends: the full local payload
      // reduced to the wire contract.
      const wire = contract.toRoomBroadcastPayload(eventType, fullPayload);
      if (!wire) throw new Error(`contract rejected ${eventType}`);
      const channel = MEDIA_EVENTS.has(eventType) ? ownerControl.channel : ownerChannel.channel;
      await channel.send({
        type: 'broadcast',
        event: 'room_action',
        payload: { event_id: randomUUID(), sender_id: A.id, timestamp: Date.now(), room_id: R1, event_type: eventType, payload: wire, state_version: 1 },
      });
    };
    const playback = (extra = {}) => ({
      // The publisher's full local state, including protected fields the
      // contract must strip.
      url: `https://example.invalid/storage/v1/object/sign/room_attachments/${marker}.mp4?token=${marker}`,
      title: `${marker} private title`,
      subtitleUrl: `https://example.invalid/${marker}.vtt`,
      mediaId,
      castId: randomUUID(),
      controllerId: A.id,
      sourceType: 'upload',
      time: 3,
      speed: 1,
      playing: true,
      muted: false,
      volume: 1,
      ...extra,
    });
    const SENSITIVE = new RegExp(`${marker}|https?:|/storage/v1/|token=|/media/|/subtitles/`, 'i');

    const beforeMessage = await A.client.from('messages').insert({ room_id: R1, sender_id: A.id, content: `${marker} before removal` }).select('id').single();
    await sendRoomAction('cast', playback());
    await sleep(3_000);
    record('D7', 'positive control: member connection receives chat through Postgres Changes', hostileLog.some((entry) => entry.kind === 'chat' && entry.row?.id === beforeMessage.data?.id), `chat events=${hostileLog.filter((entry) => entry.kind === 'chat').length}`);
    record('D7', 'positive control: observer receives the same chat row', observerLog.some((entry) => entry.kind === 'chat' && entry.row?.id === beforeMessage.data?.id));
    record('D7', 'positive control: member connection receives the cast by mediaId', hostileLog.some((entry) => entry.kind === 'broadcast' && entry.payload?.event_type === 'cast' && entry.payload?.payload?.mediaId === mediaId));
    record('D7', 'Broadcast carries no title or URL even to current members', !SENSITIVE.test(JSON.stringify(hostileLog.filter((entry) => entry.kind === 'broadcast'))));

    // ---- T1 / T7 removal.
    const kick = await A.client.rpc('review_room_member', { p_room_id: R1, p_target_user_id: B.id, p_action: 'kick', p_reason: '' });
    const kickedAt = Date.now();
    record('T1', 'owner removes B', !kick.error, codeOf(kick));
    const formerRead = await B.client.from('messages').select('id').eq('room_id', R1);
    record('T1', 'former member reads no R1 messages', deniedOrEmpty(formerRead), `${codeOf(formerRead)} rows=${rowsOf(formerRead)}`);
    const formerInsert = await B.client.from('messages').insert({ room_id: R1, sender_id: B.id, content: 'qa former probe' });
    record('T1', 'former member cannot insert messages', Boolean(formerInsert.error), codeOf(formerInsert));
    const formerSigned = await B.client.storage.from(BUCKET).createSignedUrl(mediaPath, 60);
    record('T1', 'former member cannot create a signed URL', Boolean(formerSigned.error) || !formerSigned.data?.signedUrl, codeOf(formerSigned));
    const formerMedia = await B.client.from('temporary_media').select('id').eq('room_id', R1);
    record('T1', 'former member reads no temporary media', deniedOrEmpty(formerMedia), `${codeOf(formerMedia)} rows=${rowsOf(formerMedia)}`);
    for (const [name, args] of [['list_study_notes', { p_room_id: R1 }], ['get_room_realtime_snapshots', { p_room_id: R1 }]]) {
      const res = await B.client.rpc(name, args);
      record('T1', `former member ${name} denied`, deniedOrEmpty(res), `${codeOf(res)} rows=${rowsOf(res)}`);
    }

    // ---- D7: keep generating every room event after the removal.
    await sleep(2_000);
    const afterMessage = await A.client.from('messages').insert({ room_id: R1, sender_id: A.id, content: `${marker} after removal` }).select('id').single();
    const softDelete = await A.client.from('messages').update({ is_deleted: true, content: '🚫 This message was deleted' }).eq('id', beforeMessage.data?.id).select('id');
    for (const [eventType, payload] of [
      ['cast', playback()],
      ['play', playback({ time: 5 })],
      ['pause', playback({ time: 6, playing: false })],
      ['seek', playback({ time: 40 })],
      ['mute', playback({ muted: true, volume: 0 })],
      ['subtitle_upload', { mediaId, subtitleUrl: `https://example.invalid/${marker}.vtt` }],
      ['force_sync', playback({ time: 41 })],
      ['timer_start', { subject: 'qa timer', endTime: Date.now() + 60_000, remaining: 60, duration: 60, sessionId: randomUUID(), ownerId: A.id, startedAt: Date.now(), segmentStartedAt: Date.now(), elapsedSeconds: 0, completed: false }],
      ['typing', { sender_id: A.id }],
      ['request_sync', {}],
    ]) {
      await sendRoomAction(eventType, payload);
    }
    await sleep(5_000);

    const hostileAfter = hostileLog.filter((entry) => entry.at >= kickedAt);
    const observerAfter = observerLog.filter((entry) => entry.at >= kickedAt);
    record('D7', 'removed connection receives no chat rows (insert or soft-delete)', !hostileAfter.some((entry) => entry.kind === 'chat'), `chat=${hostileAfter.filter((entry) => entry.kind === 'chat').length}`);
    record('D7', 'removed connection receives no message text, titles, URLs or storage paths', !SENSITIVE.test(JSON.stringify(hostileAfter)), `${hostileAfter.length} payloads inspected`);
    const countChat = (id, eventType) => observerAfter.filter((entry) => entry.kind === 'chat' && entry.row?.id === id && entry.eventType === eventType).length;
    record('D7', 'remaining member receives the new chat row exactly once', !afterMessage.error && countChat(afterMessage.data?.id, 'INSERT') === 1, `count=${countChat(afterMessage.data?.id, 'INSERT')}`);
    record('D7', 'remaining member receives the soft-delete update exactly once', !softDelete.error && countChat(beforeMessage.data?.id, 'UPDATE') === 1, `count=${countChat(beforeMessage.data?.id, 'UPDATE')}`);
    const observedTypes = new Set(observerAfter.filter((entry) => entry.kind === 'broadcast').map((entry) => entry.payload?.event_type));
    record('D7', 'remaining member receives every Watch, timer, typing and sync event', ['cast', 'play', 'pause', 'seek', 'mute', 'subtitle_upload', 'force_sync', 'timer_start', 'typing', 'request_sync'].every((type) => observedTypes.has(type)), [...observedTypes].join(','));
    const resolvedRow = await observer.client.from('temporary_media').select('id, storage_path').eq('id', mediaId).eq('room_id', R1).maybeSingle();
    const resolvedUrl = resolvedRow.data?.storage_path ? await observer.client.storage.from(BUCKET).createSignedUrl(resolvedRow.data.storage_path, 60) : { error: { code: 'no_row' } };
    record('D7', 'remaining member resolves the mediaId under RLS (resolveRoomMedia path)', Boolean(resolvedRow.data) && !resolvedUrl.error, `${codeOf(resolvedRow)}/${codeOf(resolvedUrl)}`);
    const hostileResolve = await hostile.client.from('temporary_media').select('id, storage_path').eq('id', mediaId);
    record('D7', 'removed connection cannot resolve the mediaId', deniedOrEmpty(hostileResolve), `${codeOf(hostileResolve)} rows=${rowsOf(hostileResolve)}`);
    const hostileSigned = await hostile.client.storage.from(BUCKET).createSignedUrl(mediaPath, 60);
    record('D7', 'removed connection cannot sign the media object', Boolean(hostileSigned.error) || !hostileSigned.data?.signedUrl, codeOf(hostileSigned));
    const hostileMessages = await hostile.client.from('messages').select('id').eq('room_id', R1);
    record('D7', 'removed connection cannot fetch room messages', deniedOrEmpty(hostileMessages), `${codeOf(hostileMessages)} rows=${rowsOf(hostileMessages)}`);
    const hostileSubtitle = await hostile.client.storage.from(BUCKET).createSignedUrl(subtitlePath, 60);
    record('D8', 'removed member cannot sign the subtitle', Boolean(hostileSubtitle.error) || !hostileSubtitle.data?.signedUrl, codeOf(hostileSubtitle));
    // Accepted design (owner decision 2026-11-05): an uploader keeps the right
    // to delete their own file after leaving, like begin_room_file_delete.
    await hostile.client.storage.from(BUCKET).remove([formerUploaderFile.path]);
    info('D6', 'former uploader deletes own file after removal (accepted design)', `deleted=${!(await objectExists(A.client, formerUploaderFile.path))}`);
    record('P2', 'public subscriber received nothing during non-member, member and removed phases', !publicLog.some((entry) => entry.kind === 'broadcast'), `broadcast=${publicLog.filter((entry) => entry.kind === 'broadcast').length}`);
    record('P2', 'public presence never exposed private-topic members', !publicLog.some((entry) => entry.kind === 'presence' && (entry.keys.includes(A.id) || entry.keys.includes(B.id))), `presence syncs=${publicLog.filter((entry) => entry.kind === 'presence').length}`);
    const residual = [...new Set(hostileAfter.map((entry) => {
      if (entry.kind === 'broadcast') return `${entry.topic}:${entry.payload?.event_type}{${Object.keys(entry.payload?.payload ?? {}).sort().join(',')}}`;
      if (entry.kind === 'presence') return `presence:{${entry.keys.length} member key(s)}`;
      if (entry.kind === 'control') return `room_control_events:${entry.row?.event_type}(subject=self:${entry.row?.subject_user_id === B.id})`;
      return entry.kind;
    }))].sort();
    info('D7', 'residual metadata still delivered to the removed, non-refreshing connection', residual.join(' | ') || 'none');

    const lateJoiner = await signIn('A', creds[0].email, creds[0].password);
    extraClients.push(lateJoiner.client);
    const lateRead = await lateJoiner.client.from('messages').select('id, is_deleted').eq('room_id', R1);
    const lateRows = lateRead.data ?? [];
    record('D7', 'late joiner reads the current chat state through RLS', lateRows.some((row) => row.id === afterMessage.data?.id) && lateRows.some((row) => row.id === beforeMessage.data?.id && row.is_deleted === true), `${codeOf(lateRead)} rows=${lateRows.length}`);

    // Transport level (not a content leak): an already-joined Broadcast
    // subscription survives removal until token refresh. Accepted residual;
    // see the epoch-rotation evaluation in the ledger.
    await ownerChannel.channel.send({ type: 'broadcast', event: 'qa-probe', payload: { n: 2 } });
    await sleep(4_000);
    info('T7', 'existing Broadcast subscription after removal (transport level)', `still delivers=${received.includes(2)}`);
    // A second channel for the same topic on one client never gets a join
    // reply, so the re-join probe uses a separate signed-in client.
    const freshB = await signIn('B', creds[1].email, creds[1].password);
    const rejoin = await subscribe(freshB.client, `sync:${R1}`);
    record('T7', 'former member cannot re-join sync:R1 (fresh connection)', rejoin.status !== 'SUBSCRIBED', rejoin.status);
    await freshB.client.removeChannel(rejoin.channel);
    // Local scope: a global sign-out would revoke B's other refresh token too.
    await freshB.client.auth.signOut({ scope: 'local' });
    // Does pushing a refreshed token re-evaluate the existing subscription?
    const refreshed = await B.client.auth.refreshSession();
    if (refreshed.error || !refreshed.data.session) {
      blocked('T7', 'token-refresh re-check', codeOf(refreshed));
    } else {
      B.client.realtime.setAuth(refreshed.data.session.access_token);
      await sleep(2_000);
      await ownerChannel.channel.send({ type: 'broadcast', event: 'qa-probe', payload: { n: 3 } });
      await sleep(4_000);
      record('T7', 'existing subscription stops after the former member refreshes its token', !received.includes(3), `received=${JSON.stringify(received)}`);
    }

    // ---- Actions 02/04: profile RLS, privacy projection, follows, posts.
    const one = (res) => (Array.isArray(res.data) ? res.data[0] : res.data) ?? null;
    const ownProfile = await A.client.from('profiles').select('id').eq('id', A.id);
    record('A02', 'user reads own base profile row', rowsOf(ownProfile) === 1, codeOf(ownProfile));
    const otherProfile = await A.client.from('profiles').select('id').eq('id', B.id);
    record('A02', 'user cannot read another base profile row', deniedOrEmpty(otherProfile), `${codeOf(otherProfile)} rows=${rowsOf(otherProfile)}`);
    const otherProfileWrite = await A.client.from('profiles').update({ bio: 'qa tamper' }).eq('id', B.id).select('id');
    record('A02', 'user cannot update another profile', deniedOrEmpty(otherProfileWrite), `${codeOf(otherProfileWrite)} rows=${rowsOf(otherProfileWrite)}`);
    const privateColumns = await A.client.from('public_profiles').select('date_of_birth').limit(1);
    record('A04', 'public projection does not expose date of birth', Boolean(privateColumns.error), codeOf(privateColumns));
    // Owner decision 2026-11-05: QA account B is made private for this run so
    // the private-profile and pending-follow paths are exercised; its original
    // setting is restored afterwards (also in `finally`).
    const originalPrivacy = one(await B.client.from('profiles').select('is_private').eq('id', B.id))?.is_private;
    restoreBPrivacy = async () => { if (typeof originalPrivacy === 'boolean') await B.client.from('profiles').update({ is_private: originalPrivacy }).eq('id', B.id); };
    await A.client.rpc('unfollow_user', { p_target_id: B.id });
    const makePrivate = await B.client.from('profiles').update({ is_private: true }).eq('id', B.id).select('is_private');
    record('A04', 'owner switches own profile to private', !makePrivate.error && one(makePrivate)?.is_private === true, codeOf(makePrivate));
    const bPrivacy = one(await B.client.from('profiles').select('is_private').eq('id', B.id));
    const projectionBefore = await A.client.from('public_profiles').select('id').eq('id', B.id);
    const alreadyFollower = one(await A.client.rpc('is_accepted_follower', { p_follower_id: A.id, p_following_id: B.id })) === true;
    if (bPrivacy?.is_private && !alreadyFollower) {
      record('A04', 'private profile hidden from non-followers', rowsOf(projectionBefore) === 0, `rows=${rowsOf(projectionBefore)}`);
    } else {
      info('A04', 'private-profile projection check skipped', `is_private=${bPrivacy?.is_private} alreadyFollower=${alreadyFollower}`);
    }
    const directFollow = await A.client.from('follows').insert({ follower_id: A.id, following_id: B.id, status: 'accepted' });
    record('A04', 'direct follows insert denied (RPC only)', Boolean(directFollow.error), codeOf(directFollow));
    const followRequest = await A.client.rpc('request_follow', { p_target_id: B.id });
    const followRow = one(followRequest);
    record('A04', 'A requests to follow B', !followRequest.error && Boolean(followRow?.id), `${codeOf(followRequest)} ${followRow?.status ?? ''}`);
    if (followRow?.status === 'pending') {
      const selfAccept = await A.client.rpc('respond_to_follow_request', { p_follow_id: followRow.id, p_decision: 'accepted' });
      record('A04', 'requester cannot accept own follow request', Boolean(selfAccept.error), codeOf(selfAccept));
      const accept = await B.client.rpc('respond_to_follow_request', { p_follow_id: followRow.id, p_decision: 'accepted' });
      record('A04', 'private target accepts the follow request', !accept.error && one(accept)?.status === 'accepted', codeOf(accept));
    }
    const isFollower = one(await A.client.rpc('is_accepted_follower', { p_follower_id: A.id, p_following_id: B.id }));
    record('A04', 'A is now an accepted follower of B', isFollower === true);
    const projectionAfter = await A.client.from('public_profiles').select('id').eq('id', B.id);
    record('A04', 'accepted follower sees the private profile projection', rowsOf(projectionAfter) === 1, codeOf(projectionAfter));

    // Same call shapes as src/actions/profiles.ts createPost/deletePost
    // (insert/update ... select), which PostgREST runs with RETURNING (D9).
    const postFixtures = {};
    const postCodes = {};
    for (const visibility of ['profile', 'followers', 'public']) {
      const created = await B.client.from('posts').insert({ author_id: B.id, content: `qa ${visibility} post`, visibility, media_url: null }).select('id, visibility').single();
      postFixtures[visibility] = created.data?.id ?? null;
      postCodes[visibility] = codeOf(created);
    }
    record('A04', 'author creates posts with each visibility (createPost shape)', Object.values(postFixtures).every(Boolean), Object.entries(postCodes).map(([key, value]) => `${key}:${value}`).join(' '));
    const ownPosts = new Set(((await B.client.from('posts').select('id').eq('author_id', B.id).is('deleted_at', null)).data ?? []).map((row) => row.id));
    record('A04', 'author reads all own posts', Object.values(postFixtures).filter(Boolean).every((id) => ownPosts.has(id)));
    const visible = new Set(((await A.client.from('posts').select('id').eq('author_id', B.id).is('deleted_at', null)).data ?? []).map((row) => row.id));
    const expectPublic = bPrivacy?.is_private === false;
    record('A04', 'follower sees profile and followers posts', Boolean(postFixtures.profile && postFixtures.followers) && visible.has(postFixtures.profile) && visible.has(postFixtures.followers));
    if (postFixtures.public) record('A04', `public post visibility follows profile privacy (${expectPublic ? 'visible' : 'hidden for private author'})`, visible.has(postFixtures.public) === expectPublic);
    const anyPost = postFixtures.profile ?? postFixtures.public;
    if (anyPost) {
      const tamperPost = await A.client.from('posts').update({ content: 'qa tamper' }).eq('id', anyPost).select('id');
      record('A04', 'non-author cannot edit a post', deniedOrEmpty(tamperPost), `${codeOf(tamperPost)} rows=${rowsOf(tamperPost)}`);
      const deletePost = await A.client.from('posts').delete().eq('id', anyPost).select('id');
      record('A04', 'non-author cannot delete a post', deniedOrEmpty(deletePost), `${codeOf(deletePost)} rows=${rowsOf(deletePost)}`);
    }
    const created = Object.values(postFixtures).filter(Boolean);
    const softDeletes = [];
    for (const id of created) {
      softDeletes.push(await B.client.from('posts').update({ deleted_at: new Date().toISOString() }).eq('id', id).eq('author_id', B.id).is('deleted_at', null).select('id').maybeSingle());
    }
    const afterDelete = await A.client.from('posts').select('id').in('id', created);
    record('A04', 'author soft-deletes posts (deletePost shape) and readers lose them', softDeletes.every((res) => !res.error && res.data) && rowsOf(afterDelete) === 0, `${softDeletes.map(codeOf).join('/')} visible=${rowsOf(afterDelete)}`);
    // Remove any still-visible qa fixture posts (for example from runs before
    // D9 was applied, when soft delete was impossible) with posts_delete_own.
    const leftovers = await B.client.from('posts').delete().eq('author_id', B.id).like('content', 'qa %').is('deleted_at', null).select('id');
    if (rowsOf(leftovers) > 0) info('A04', 'leftover qa fixture posts removed (posts_delete_own)', `${rowsOf(leftovers)}`);

    // ---- T5 message-request roles (precondition: A follows B, accepted).
    const firstRequest = await A.client.rpc('send_message_request', { p_recipient_id: B.id, p_message: 'qa probe request' });
    const requestRow = Array.isArray(firstRequest.data) ? firstRequest.data[0] : firstRequest.data;
    if (firstRequest.error || !requestRow?.id) {
      blocked('T5', 'message-request fixture (A follows B)', firstRequest.error ? `${codeOf(firstRequest)} ${firstRequest.error.message}` : 'no row');
    } else {
      for (const [actor, name, label] of [
        [A, 'accept_message_request', 'requester cannot accept'],
        [A, 'reject_message_request', 'requester cannot reject'],
        [B, 'cancel_message_request', 'recipient cannot cancel'],
      ]) {
        const res = await actor.client.rpc(name, { p_request_id: requestRow.id });
        // cancel_message_request returns false (no exception) for a non-requester.
        record('T5', `message request: ${label}`, Boolean(res.error) || res.data === false, res.error ? codeOf(res) : `returned ${res.data}`);
      }
      const stillPending = await A.client.from('message_requests').select('status').eq('id', requestRow.id).single();
      record('T5', 'message request: post-check still pending', stillPending.data?.status === 'pending', codeOf(stillPending));
      const directUpdate = await B.client.from('message_requests').update({ status: 'accepted' }).eq('id', requestRow.id).select('id');
      record('T5', 'message request: direct status update denied', Boolean(directUpdate.error) || rowsOf(directUpdate) === 0, `${codeOf(directUpdate)} rows=${rowsOf(directUpdate)}`);
      const reject = await B.client.rpc('reject_message_request', { p_request_id: requestRow.id });
      const rejected = await A.client.from('message_requests').select('status').eq('id', requestRow.id).single();
      record('T5', 'message request: recipient rejects', !reject.error && rejected.data?.status === 'rejected', `${codeOf(reject)} ${rejected.data?.status ?? ''}`);
      const secondRequest = await A.client.rpc('send_message_request', { p_recipient_id: B.id, p_message: 'qa probe request 2' });
      const secondRow = Array.isArray(secondRequest.data) ? secondRequest.data[0] : secondRequest.data;
      if (secondRequest.error || !secondRow?.id) {
        info('T5', 'message request: re-send after rejection', `${codeOf(secondRequest)} ${secondRequest.error?.message ?? ''}`);
      } else {
        const cancel = await A.client.rpc('cancel_message_request', { p_request_id: secondRow.id });
        record('T5', 'message request: requester cancels', !cancel.error, codeOf(cancel));
      }
    }

    // ---- Action 04 friends (after message requests: friends cannot send them).
    const directFriendship = await A.client.from('friendships').insert({ user_one: A.id < B.id ? A.id : B.id, user_two: A.id < B.id ? B.id : A.id });
    record('A04', 'direct friendships insert denied (RPC only)', Boolean(directFriendship.error), codeOf(directFriendship));
    const friendRequest = await A.client.rpc('request_friend', { p_recipient_id: B.id });
    const friendRow = one(friendRequest);
    if (friendRequest.error || !friendRow?.id) {
      blocked('A04', 'friend-request fixture', `${codeOf(friendRequest)} ${friendRequest.error?.message ?? ''}`);
    } else {
      const selfFriendAccept = await A.client.rpc('respond_to_friend_request', { p_request_id: friendRow.id, p_decision: 'accepted' });
      record('A04', 'requester cannot accept own friend request', Boolean(selfFriendAccept.error), codeOf(selfFriendAccept));
      const friendAccept = await B.client.rpc('respond_to_friend_request', { p_request_id: friendRow.id, p_decision: 'accepted' });
      const nowFriends = one(await A.client.rpc('is_current_friend', { p_user_one: A.id, p_user_two: B.id }));
      record('A04', 'recipient accepts and the friendship exists', !friendAccept.error && nowFriends === true, codeOf(friendAccept));
      const blockedRequest = await A.client.rpc('send_message_request', { p_recipient_id: B.id, p_message: 'qa probe request 3' });
      record('A04', 'friends cannot open a message request (already friends)', Boolean(blockedRequest.error), codeOf(blockedRequest));
      const unfriend = await A.client.rpc('remove_friend', { p_other_user_id: B.id });
      const stillFriends = one(await A.client.rpc('is_current_friend', { p_user_one: A.id, p_user_two: B.id }));
      record('A04', 'remove_friend ends the friendship', !unfriend.error && stillFriends === false, codeOf(unfriend));
    }
    // Keep the intended standing fixture: A follows B (accepted).
    const followAgain = one(await A.client.rpc('request_follow', { p_target_id: B.id }));
    if (followAgain?.status === 'pending') await B.client.rpc('respond_to_follow_request', { p_follow_id: followAgain.id, p_decision: 'accepted' });
    if (restoreBPrivacy) { await restoreBPrivacy(); restoreBPrivacy = null; }
    const restoredPrivacy = one(await B.client.from('profiles').select('is_private').eq('id', B.id))?.is_private;
    info('A04', 'standing fixture after run', `A follows B accepted=${one(await A.client.rpc('is_accepted_follower', { p_follower_id: A.id, p_following_id: B.id }))}; B is_private restored=${restoredPrivacy}`);

    // ---- T4 notification isolation via the normal recovery lifecycle.
    const R3 = await createRoom(A, { tag, suffix: 'r3', type: 'recoverable', expiresInMs: 15_000 });
    console.log(`fixture room R3=${R3} (owner A, recoverable)`);
    let state = '';
    for (let attempt = 0; attempt < 20 && state !== 'recovery-window'; attempt += 1) {
      await sleep(3_000);
      state = (await A.client.rpc('room_lifecycle_state', { p_room_id: R3 })).data ?? '';
    }
    if (state !== 'recovery-window') {
      blocked('T4', 'recovery-window fixture', `lifecycle state ${state || 'unknown'}`);
    } else {
      const request = await A.client.from('recovery_requests').insert({ room_id: R3, requester_id: A.id, status: 'pending' }).select('id').single();
      if (request.error) {
        blocked('T4', 'recovery request fixture', codeOf(request));
      } else {
        const outsiderReview = await B.client.rpc('review_recovery_request', { p_request_id: request.data.id, p_decision: 'approved' });
        record('T5', 'unrelated B review_recovery_request denied', Boolean(outsiderReview.error), codeOf(outsiderReview));
        const decision = await A.client.rpc('review_recovery_request', { p_request_id: request.data.id, p_decision: 'rejected' });
        record('T4', 'owner rejects own recovery request (creates notification)', !decision.error, decision.error ? `${codeOf(decision)} ${decision.error.message}` : 'ok');
        const mine = await A.client.from('room_notifications').select('id, recipient_id, read_at').eq('room_id', R3).eq('recipient_id', A.id);
        const notification = (mine.data ?? [])[0];
        record('T4', 'recipient A reads the notification', Boolean(notification), `${codeOf(mine)} rows=${rowsOf(mine)}`);
        if (notification) {
          const peek = await B.client.from('room_notifications').select('id').eq('id', notification.id);
          record('T4', 'unrelated B cannot read it', deniedOrEmpty(peek), `${codeOf(peek)} rows=${rowsOf(peek)}`);
          const tamper = await B.client.from('room_notifications').update({ read_at: new Date().toISOString() }).eq('id', notification.id).select('id');
          record('T4', 'unrelated B cannot mark it read', deniedOrEmpty(tamper), `${codeOf(tamper)} rows=${rowsOf(tamper)}`);
          const reassign = await B.client.from('room_notifications').update({ recipient_id: B.id }).eq('id', notification.id).select('id');
          record('T4', 'unrelated B cannot reassign it', deniedOrEmpty(reassign), `${codeOf(reassign)} rows=${rowsOf(reassign)}`);
          const unchanged = await A.client.from('room_notifications').select('read_at, recipient_id').eq('id', notification.id).single();
          record('T4', 'post-check: still unread and owned by A', unchanged.data?.read_at === null && unchanged.data?.recipient_id === A.id, codeOf(unchanged));
          const markRead = await A.client.from('room_notifications').update({ read_at: new Date().toISOString() }).eq('id', notification.id).eq('recipient_id', A.id).select('id');
          record('T4', 'recipient A marks it read', !markRead.error && rowsOf(markRead) === 1, `${codeOf(markRead)} rows=${rowsOf(markRead)}`);
        }
      }
    }

    // ---- Cleanup through normal permissions. Rooms expire on their own.
    const cleanup = await A.client.storage.from(BUCKET).remove([mediaPath]);
    record('T6', 'owner (watch_control) deletes the probe media object', !cleanup.error, cleanup.error ? `${codeOf(cleanup)} ${cleanup.error.message}` : 'ok');
    console.log('cleanup: rooms and any remaining temporary media expire through the normal cleanup job');
  } finally {
    if (restoreBPrivacy) await restoreBPrivacy().catch(() => undefined);
    for (const [client, channel] of channels) await client.removeChannel(channel);
    await Promise.all([A.client, B.client, ...extraClients].map((client) => client.auth.signOut({ scope: 'local' })));
  }
}

// Action 02: unauthenticated route boundary against a running app
// (`npx next start` locally, or a Preview URL). No credentials are used.
async function routesPhase(base) {
  const origin = new URL(base).origin;
  const get = (path) => fetch(new URL(path, base), { redirect: 'manual' });
  for (const path of ['/home', '/messages', '/create-room', '/room', `/room/${randomUUID()}`, '/room-settings', '/profile/setup']) {
    const response = await get(path);
    const location = response.headers.get('location');
    const target = location ? new URL(location, base) : null;
    const next = target?.searchParams.get('next') ?? '';
    record('A02', `unauthenticated ${path} redirects to login`, response.status >= 300 && response.status < 400 && target?.origin === origin && target.pathname === '/login' && new URL(next, base).origin === origin, `${response.status} ${target ? target.pathname : '-'}`);
  }
  for (const path of ['/login', '/forgot-password', '/auth/update-password', '/']) {
    const response = await get(path);
    record('A02', `public ${path} is reachable`, response.status === 200, String(response.status));
  }
  // A destination is safe when it resolves to this origin, whatever text it contains.
  for (const next of ['https://evil.example/x', '//evil.example/x', '/\\evil.example', '/%5Cevil.example', '/%2F%2Fevil.example', `/${'a'.repeat(3000)}`]) {
    const response = await get(`/auth/callback?next=${encodeURIComponent(next)}`);
    const location = response.headers.get('location');
    const target = location ? new URL(location, base) : null;
    const carried = target?.searchParams.get('next');
    const safe = response.status >= 300 && response.status < 400 && target?.origin === origin
      && (carried === null || carried === '' || new URL(carried, base).origin === origin);
    record('A02', `callback keeps next same-origin (${next.slice(0, 22)}${next.length > 22 ? '…' : ''})`, safe, `${response.status} ${target ? target.pathname : '-'}`);
  }
}

try {
  if (mode === 'routes') {
    await routesPhase(process.argv[3] ?? 'http://localhost:3000');
  } else {
    await anonPhase();
    if (mode === 'full') await fullPhase();
  }
} catch (error) {
  blocked('harness', 'run', error instanceof Error ? error.message : String(error));
}

const failed = results.filter((result) => result.pass === false).length;
const blockedCount = results.filter((result) => result.pass === null).length;
const passed = results.filter((result) => result.pass === true).length;
const infoCount = results.filter((result) => result.pass === 'info').length;
console.log(`\nsummary: ${passed} pass, ${failed} fail, ${blockedCount} blocked, ${infoCount} info`);
process.exit(failed > 0 ? 1 : blockedCount > 0 ? 3 : 0);
