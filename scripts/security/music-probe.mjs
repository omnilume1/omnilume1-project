// Music library probe (Action 16 Stage 2, migration 20261110100000).
//
//   node scripts/security/music-probe.mjs
//
// Throw-away accounts (service role, deleted at the end): A owner, M member of
// A's room, B stranger; plus an anonymous client. Covers the real Storage API
// (own-prefix upload, cross-user/anon refusal, owner-only reads), service
// registration, playback authorization, opt-in room sharing with attestation
// and revocation, history and playlists RLS, signed-URL lifetime capped by the
// upload's remaining life, forced expiry (unreadable while the object still
// exists), cleanup (storage first, then the tombstone row) and the flat
// per-user prefix that account deletion sweeps. Stage 3 (migration
// 20261111100000): "Listening to …" for friends only (privacy, blocks), and
// Listen Together on the private topic music_listen_room_<id> — real Realtime
// delivery to a member, refusal for the stranger/anon/public channel, no client
// publishing, host-only control, queue deltas and the idempotent advance.
// Output: codes and pass/fail only.

import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..', '..');
const env = Object.fromEntries(readFileSync(resolve(projectRoot, '.env.local'), 'utf8')
  .split(/\r?\n/).map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean)
  .map((match) => [match[1], match[2].replace(/^(['"])(.*)\1$/, '$2')]));
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, options);
const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, options);
const BUCKET = 'music_uploads';

const results = [];
const record = (check, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  A16  ${check}${detail ? `  [${detail}]` : ''}`);
};
const codeOf = (res) => (res?.error ? String(res.error.code ?? res.error.statusCode ?? res.error.status ?? 'error') : 'ok');
const rows = (res) => (Array.isArray(res?.data) ? res.data.length : res?.data ? 1 : 0);
const mp3 = () => new Blob([new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64, ...new Array(2000).fill(0)])], { type: 'audio/mpeg' });
const jwtExp = (signedUrl) => JSON.parse(Buffer.from(new URL(signedUrl).searchParams.get('token').split('.')[1], 'base64url').toString()).exp;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
function joinChannel(client, topic, isPrivate = true) {
  const channel = client.channel(topic, { config: { private: isPrivate, broadcast: { self: false } } });
  const got = [];
  channel.on('broadcast', { event: 'state' }, (message) => got.push(message.payload));
  return new Promise((done) => {
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ channel, status, got });
    };
    const timer = setTimeout(() => finish('NO_RESPONSE'), 10_000);
    channel.subscribe((status) => {
      if (['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) finish(status);
    });
  });
}

const throwaway = [];
async function makeUser(tag) {
  const email = `qa16-${tag}-${randomUUID().slice(0, 8)}@example.invalid`;
  const password = `Pw-${randomUUID()}`;
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw new Error(`createUser ${tag}: ${created.error.message}`);
  const id = created.data.user.id;
  throwaway.push(id);
  await service.from('profiles').upsert({ id, display_name: `qa16 ${tag}`, username: `qa16${tag}${id.slice(0, 6)}`, date_of_birth: '1990-01-01', gender: 'non_binary', profile_completed: true });
  const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, options);
  const signed = await client.auth.signInWithPassword({ email, password });
  if (signed.error) throw new Error(`signIn ${tag}: ${signed.error.message}`);
  client.realtime.setAuth(signed.data.session.access_token);
  return { client, id };
}

const register = (owner, uploadId, overrides = {}) => service.rpc('register_music_upload', {
  p_owner_id: owner.id, p_upload_id: uploadId, p_ext: 'mp3', p_mime_type: 'audio/mpeg', p_original_name: 'probe.mp3',
  p_title: 'Probe Song', p_artist: 'Probe', p_album: 'Probe Album', p_album_artist: '', p_track_no: 1, p_year: 2026,
  p_genre: '', p_duration_ms: 1000, p_hue: 260, p_lyrics: '[00:00.50]probe', p_has_cover: false, ...overrides,
});

async function main() {
  const A = await makeUser('a');
  const M = await makeUser('m');
  const B = await makeUser('b');
  const rooms = [];
  const objects = [];

  try {
    // Room R owned by A, M approved as a member.
    const R = randomUUID();
    const room = await A.client.from('rooms').insert({ id: R, name: `qa16-${R.slice(0, 6)}`, description: 'Disposable music probe.', is_private: true, expiration_type: 'recoverable', expires_at: new Date(Date.now() + 2 * 3600_000).toISOString(), created_by: A.id, username: null });
    if (room.error) throw new Error(`room: ${codeOf(room)}`);
    rooms.push(R);
    await A.client.from('room_members').insert({ room_id: R, user_id: A.id, role: 'owner', join_status: 'approved' });
    await M.client.rpc('request_room_join', { p_identifier: R });
    const approve = await A.client.rpc('review_room_member', { p_room_id: R, p_target_user_id: M.id, p_action: 'approve', p_reason: '' });
    if (approve.error) throw new Error(`approve: ${codeOf(approve)}`);

    // Storage: own-prefix upload through the real Storage API; others refused.
    const U = randomUUID();
    const path = `${A.id}/${U}.mp3`;
    objects.push(path);
    const up = await A.client.storage.from(BUCKET).upload(path, mp3(), { contentType: 'audio/mpeg', upsert: false });
    record('owner uploads into own prefix (Storage API)', !up.error, codeOf(up));
    const intoA = await B.client.storage.from(BUCKET).upload(`${A.id}/${randomUUID()}.mp3`, mp3(), { contentType: 'audio/mpeg' });
    record('stranger cannot upload into owner prefix', Boolean(intoA.error), codeOf(intoA));
    const nested = await A.client.storage.from(BUCKET).upload(`${A.id}/x/${randomUUID()}.mp3`, mp3(), { contentType: 'audio/mpeg' });
    record('nested path refused', Boolean(nested.error), codeOf(nested));
    const anonUp = await anon.storage.from(BUCKET).upload(`${A.id}/${randomUUID()}.mp3`, mp3(), { contentType: 'audio/mpeg' });
    record('anon upload refused', Boolean(anonUp.error), codeOf(anonUp));
    const badType = await A.client.storage.from(BUCKET).upload(`${A.id}/${randomUUID()}.mp3`, new Blob(['<html>'], { type: 'text/html' }), { contentType: 'text/html' });
    record('bucket refuses a non-audio MIME type', Boolean(badType.error), codeOf(badType));

    // Registration is service-role only (the route sniffs bytes first).
    const userRegister = await A.client.rpc('register_music_upload', { p_owner_id: A.id, p_upload_id: U, p_ext: 'mp3', p_mime_type: 'audio/mpeg', p_original_name: 'x.mp3', p_title: 'x', p_artist: '', p_album: '', p_album_artist: '', p_track_no: null, p_year: null, p_genre: '', p_duration_ms: null, p_hue: 1, p_lyrics: '', p_has_cover: false });
    record('users cannot call register_music_upload', Boolean(userRegister.error), codeOf(userRegister));
    const wrongOwner = await register(B, U);
    record('register refuses an object the owner does not hold', Boolean(wrongOwner.error), codeOf(wrongOwner));
    const reg = await register(A, U);
    record('service registers the upload', !reg.error, codeOf(reg));
    const life = reg.data ? (Date.parse(reg.data.expires_at) - Date.parse(reg.data.created_at)) / 3600_000 : 0;
    record('expiry is exactly 7 days from upload', life === 168, `${life} h`);
    const dup = await register(A, U);
    record('double registration refused', codeOf(dup) === '23505', codeOf(dup));

    // Owner reads.
    const ownRows = await A.client.from('music_uploads').select('id, state');
    record('owner sees own row', rows(ownRows) === 1, `${rows(ownRows)} row(s)`);
    const ownPlay = await A.client.rpc('get_music_playback', { p_upload_id: U });
    record('owner playback path', rows(ownPlay) === 1 && ownPlay.data?.[0]?.object_path === path, codeOf(ownPlay));
    const ownSigned = await A.client.storage.from(BUCKET).createSignedUrl(path, 60);
    record('owner storage read allowed while active', !ownSigned.error, codeOf(ownSigned));

    // Sharing: opt-in, attested, members only.
    const mBefore = await M.client.rpc('get_music_playback', { p_upload_id: U });
    record('member cannot play before it is shared', codeOf(mBefore) === '42501', codeOf(mBefore));
    const noAttest = await A.client.rpc('share_music_upload', { p_upload_id: U, p_target_kind: 'room', p_target_id: R, p_attest: false });
    record('share without attestation refused', codeOf(noAttest) === '22023', codeOf(noAttest));
    const bShare = await B.client.rpc('share_music_upload', { p_upload_id: U, p_target_kind: 'room', p_target_id: R, p_attest: true });
    record('non-owner cannot share', codeOf(bShare) === '42501', codeOf(bShare));
    const targets = await A.client.rpc('list_music_share_targets');
    record('owner sees the room as a share target', (targets.data ?? []).some((t) => t.target_id === R), codeOf(targets));
    const shared = await A.client.rpc('share_music_upload', { p_upload_id: U, p_target_kind: 'room', p_target_id: R, p_attest: true });
    record('owner shares to own room', !shared.error, codeOf(shared));
    const mList = await M.client.rpc('list_music_shared_with_me');
    record('member sees the shared song', rows(mList) === 1 && mList.data[0].upload_id === U, `${rows(mList)} row(s)`);
    const mPlay = await M.client.rpc('get_music_playback', { p_upload_id: U });
    record('member playback allowed', rows(mPlay) === 1, codeOf(mPlay));
    const mRows = await M.client.from('music_uploads').select('id');
    record('member cannot read upload rows', rows(mRows) === 0, `${rows(mRows)} row(s)`);
    const mSigned = await M.client.storage.from(BUCKET).createSignedUrl(path, 60);
    record('member cannot sign the object directly', Boolean(mSigned.error), codeOf(mSigned));
    const bPlay = await B.client.rpc('get_music_playback', { p_upload_id: U });
    record('stranger playback refused', codeOf(bPlay) === '42501', codeOf(bPlay));
    const bList = await B.client.rpc('list_music_shared_with_me');
    record('stranger sees nothing shared', rows(bList) === 0, `${rows(bList)} row(s)`);
    const bSigned = await B.client.storage.from(BUCKET).createSignedUrl(path, 60);
    record('stranger cannot sign the object', Boolean(bSigned.error), codeOf(bSigned));
    const anonPlay = await anon.rpc('get_music_playback', { p_upload_id: U });
    record('anon playback refused', Boolean(anonPlay.error), codeOf(anonPlay));
    const anonRows = await anon.from('music_uploads').select('id');
    record('anon reads no rows', Boolean(anonRows.error) || rows(anonRows) === 0, codeOf(anonRows));

    // History and playlists.
    const mRecord = await M.client.rpc('record_music_play', { p_upload_id: U });
    const mHistory = await M.client.rpc('list_my_music_history', { p_limit: 10 });
    record('member play recorded in own history', !mRecord.error && rows(mHistory) === 1 && mHistory.data[0].playable === true, codeOf(mRecord));
    const bRecord = await B.client.rpc('record_music_play', { p_upload_id: U });
    record('stranger cannot record a play', codeOf(bRecord) === '42501', codeOf(bRecord));
    const aHistoryOfM = await A.client.from('music_listening_history').select('id').eq('user_id', M.id);
    record('owner cannot read member history', rows(aHistoryOfM) === 0, `${rows(aHistoryOfM)} row(s)`);
    const pl = await A.client.from('music_playlists').insert({ name: 'qa16 list' }).select('id').single();
    const item = pl.data ? await A.client.from('music_playlist_items').insert({ playlist_id: pl.data.id, upload_id: U }) : pl;
    record('owner playlist + item', !pl.error && !item.error, `${codeOf(pl)}/${codeOf(item)}`);
    const mPl = await M.client.from('music_playlists').insert({ name: 'm list' }).select('id').single();
    const mItem = mPl.data ? await M.client.from('music_playlist_items').insert({ playlist_id: mPl.data.id, upload_id: U }) : mPl;
    record('member cannot add someone else\'s upload to a playlist', Boolean(mItem.error), codeOf(mItem));
    const mSeesA = await M.client.from('music_playlists').select('id').eq('id', pl.data?.id ?? randomUUID());
    record('playlists are owner-only', rows(mSeesA) === 0, `${rows(mSeesA)} row(s)`);

    // Signed URL lifetime = min(1 h, remaining life).
    const tenMinutes = new Date(Date.now() + 10 * 60_000);
    const shift = await service.from('music_uploads').update({ created_at: new Date(tenMinutes.getTime() - 7 * 86_400_000).toISOString(), expires_at: tenMinutes.toISOString() }).eq('id', U);
    const playNow = await A.client.rpc('get_music_playback', { p_upload_id: U });
    const remaining = Math.floor((Date.parse(playNow.data?.[0]?.expires_at) - Date.now()) / 1000);
    const ttl = Math.max(0, Math.min(3600, remaining));
    const signed = await service.storage.from(BUCKET).createSignedUrl(path, ttl);
    const exp = signed.data ? jwtExp(signed.data.signedUrl) : 0;
    record('signed URL never outlives the upload', !shift.error && ttl <= 600 && exp > 0 && exp <= Math.ceil(tenMinutes.getTime() / 1000) + 2, `ttl=${ttl}s`);

    // Revocation.
    const shareRow = await A.client.from('music_upload_shares').select('id').eq('upload_id', U).single();
    const unshare = await A.client.rpc('unshare_music_upload', { p_share_id: shareRow.data?.id });
    const mAfter = await M.client.rpc('get_music_playback', { p_upload_id: U });
    record('revoking the share stops member playback', unshare.data === true && codeOf(mAfter) === '42501', codeOf(mAfter));
    await A.client.rpc('share_music_upload', { p_upload_id: U, p_target_kind: 'room', p_target_id: R, p_attest: true });

    // ---- Stage 3: "Listening to …" (friends only).
    const pair = [A.id, M.id].sort();
    const friends = await service.from('friendships').insert({ user_one: pair[0], user_two: pair[1] });
    const mNow = await M.client.rpc('set_music_now_playing', { p_upload_id: U });
    const aSees = await A.client.rpc('list_friends_listening');
    record('friend sees "Listening to" with the upload title', !friends.error && !mNow.error && (aSees.data ?? []).some((row) => row.user_id === M.id && row.title === 'Probe Song'), codeOf(mNow));
    const bSees = await B.client.rpc('list_friends_listening');
    record('non-friend sees nothing', !bSees.error && !(bSees.data ?? []).some((row) => row.user_id === M.id), `${rows(bSees)} row(s)`);
    const bNow = await B.client.rpc('set_music_now_playing', { p_upload_id: U });
    record('cannot publish a song you may not play', codeOf(bNow) === '42501', codeOf(bNow));
    const npDirect = await A.client.from('music_now_playing').select('user_id');
    record('now-playing table not readable directly', Boolean(npDirect.error), codeOf(npDirect));
    const anonFriends = await anon.rpc('list_friends_listening');
    record('anon cannot list listeners', Boolean(anonFriends.error), codeOf(anonFriends));
    await M.client.rpc('set_music_presence', { p_presence: 'nobody' });
    const hidden = await A.client.rpc('list_friends_listening');
    const mSetting = await M.client.from('music_settings').select('presence').single();
    record('privacy "nobody" hides it from friends', !(hidden.data ?? []).some((row) => row.user_id === M.id) && mSetting.data?.presence === 'nobody', mSetting.data?.presence);
    const aReadsM = await A.client.from('music_settings').select('user_id').eq('user_id', M.id);
    record('music settings are owner-only', rows(aReadsM) === 0, `${rows(aReadsM)} row(s)`);
    await M.client.rpc('set_music_presence', { p_presence: 'friends' });

    // ---- Stage 3: Listen Together on room R.
    const topic = `music_listen_room_${R}`;
    const mChannel = await joinChannel(M.client, topic);
    record('member joins the private Listen Together topic', mChannel.status === 'SUBSCRIBED', mChannel.status);
    const bChannel = await joinChannel(B.client, topic);
    record('stranger is refused the topic', bChannel.status !== 'SUBSCRIBED', bChannel.status);
    const anonChannel = await joinChannel(anon, topic);
    record('anon is refused the topic', anonChannel.status !== 'SUBSCRIBED', anonChannel.status);
    const publicChannel = await joinChannel(B.client, topic, false);
    record('public (non-private) channel on the topic is refused', publicChannel.status !== 'SUBSCRIBED', publicChannel.status);

    const control = (who, action, args = {}) => who.client.rpc('music_listen_control', {
      p_kind: 'room', p_target: R, p_action: action, p_upload_id: args.upload ?? null,
      p_position_ms: args.position ?? null, p_index: args.index ?? null, p_flag: args.flag ?? null,
    });
    const start = await control(A, 'start', { flag: false });
    record('host starts a session', !start.error && start.data?.host_id === A.id, codeOf(start));
    const load = await control(M, 'load', { upload: U });
    await sleep(2_500);
    record('member loads a shared song; members get it over Realtime', !load.error && mChannel.got.some((state) => state.upload_id === U && state.seq === load.data?.seq), `got=${mChannel.got.length}`);
    record('stranger channel received nothing', bChannel.got.length === 0 && anonChannel.got.length === 0 && publicChannel.got.length === 0);
    const aChannel = await joinChannel(A.client, topic);
    const forged = await mChannel.channel.send({ type: 'broadcast', event: 'state', payload: { seq: 999, upload_id: null } });
    await sleep(2_500);
    record('clients cannot publish on the topic (no INSERT policy)', aChannel.status === 'SUBSCRIBED' && !aChannel.got.some((state) => state.seq === 999), `send=${forged} got=${aChannel.got.length}`);
    const unshared = randomUUID();
    const loadOther = await control(M, 'load', { upload: unshared });
    record('songs not shared here are refused', codeOf(loadOther) === '22023', codeOf(loadOther));
    const bControl = await control(B, 'pause', { position: 0 });
    record('stranger cannot control', codeOf(bControl) === '42501', codeOf(bControl));
    const bGet = await B.client.rpc('get_music_listen_session', { p_kind: 'room', p_target: R });
    record('stranger cannot read the session', codeOf(bGet) === '42501', codeOf(bGet));
    const sessDirect = await M.client.from('music_listen_sessions').select('id');
    record('session table not readable directly', Boolean(sessDirect.error), codeOf(sessDirect));
    const tracksM = await M.client.rpc('list_music_listen_tracks', { p_kind: 'room', p_target: R });
    record('member lists the songs shared here', rows(tracksM) === 1 && tracksM.data[0].upload_id === U, `${rows(tracksM)} row(s)`);
    await control(A, 'host_only', { flag: true });
    const mPause = await control(M, 'pause', { position: 1000 });
    record('host-only: member cannot control', codeOf(mPause) === '42501', codeOf(mPause));
    const mFlag = await control(M, 'host_only', { flag: false });
    record('only the host toggles host-only', codeOf(mFlag) === '42501', codeOf(mFlag));
    const aPause = await control(A, 'pause', { position: 4000 });
    record('host pauses at a position', aPause.data?.is_playing === false && aPause.data?.position_ms === 4000, codeOf(aPause));
    await control(A, 'enqueue', { upload: U });
    const stale = await control(A, 'remove', { upload: unshared, index: 0 });
    record('queue delta with a stale index is refused (not retried by PostgREST)', codeOf(stale) === '55000', codeOf(stale));
    // Only one song is shared here, so the queue holds the current song again; a "next"
    // from any other song is a stale advance (another listener already moved on) and is ignored.
    const before = await control(A, 'seek', { position: 0 });
    const staleNext = await control(A, 'next', { upload: unshared });
    const advanced = await control(A, 'next', { upload: U });
    record('stale advance is ignored; a real one moves the queue', staleNext.data?.seq === before.data?.seq && advanced.data?.seq === before.data?.seq + 1 && (advanced.data?.queue ?? []).length === 0, `${before.data?.seq}/${staleNext.data?.seq}/${advanced.data?.seq}`);
    const ended = await control(A, 'end');
    const afterEnd = await control(M, 'play', { position: 0 });
    record('ended session refuses control until someone starts again', ended.data?.ended === true && codeOf(afterEnd) === 'P0002', codeOf(afterEnd));
    for (const joined of [mChannel, bChannel, anonChannel, publicChannel, aChannel]) await joined.channel.unsubscribe();

    // Forced expiry: refused everywhere although the object still exists.
    const base = Date.now(); // one clock read: the TTL CHECK needs expires_at - created_at = exactly 7 days
    const expire = await service.from('music_uploads').update({ created_at: new Date(base - 8 * 86_400_000).toISOString(), expires_at: new Date(base - 86_400_000).toISOString() }).eq('id', U);
    const aExpired = await A.client.rpc('get_music_playback', { p_upload_id: U });
    record('expired: owner playback refused', !expire.error && codeOf(aExpired) === '42501', codeOf(aExpired));
    const aExpiredSign = await A.client.storage.from(BUCKET).createSignedUrl(path, 60);
    record('expired: owner storage read refused', Boolean(aExpiredSign.error), codeOf(aExpiredSign));
    const mExpired = await M.client.rpc('list_music_shared_with_me');
    record('expired: no longer shared', rows(mExpired) === 0, `${rows(mExpired)} row(s)`);
    const stillThere = await service.storage.from(BUCKET).list(A.id, { search: U });
    record('expired: object still present (cron not needed for expiry)', (stillThere.data ?? []).length === 1, `${(stillThere.data ?? []).length}`);
    const mHistExpired = await M.client.rpc('list_my_music_history', { p_limit: 10 });
    record('expired: history keeps the entry, not playable', rows(mHistExpired) === 1 && mHistExpired.data[0].playable === false);

    // Cleanup: storage first, then the tombstone row.
    const due = await service.rpc('list_music_uploads_due_for_cleanup', { p_limit: 500 });
    const mine = (due.data ?? []).find((rowIn) => rowIn.id === U);
    record('cleanup lists the expired upload', Boolean(mine), codeOf(due));
    const removed = mine ? await service.storage.from(BUCKET).remove([mine.object_path]) : { error: { message: 'missing' } };
    const completed = await service.rpc('complete_music_upload_cleanup', { p_upload_id: U, p_error: removed.error ? removed.error.message : null });
    const tomb = await service.from('music_uploads').select('state').eq('id', U).single();
    const gone = await service.storage.from(BUCKET).list(A.id, { search: U });
    record('cleanup removes the object and tombstones the row', !removed.error && !completed.error && tomb.data?.state === 'deleted' && (gone.data ?? []).length === 0, tomb.data?.state);
    const userComplete = await A.client.rpc('complete_music_upload_cleanup', { p_upload_id: U, p_error: null });
    record('users cannot call the cleanup RPC', Boolean(userComplete.error), codeOf(userComplete));

    // Unregistered object: owner-visible, listed flat under <uid>/ (what account deletion sweeps).
    const orphan = `${A.id}/${randomUUID()}.mp3`;
    objects.push(orphan);
    const orphanUp = await A.client.storage.from(BUCKET).upload(orphan, mp3(), { contentType: 'audio/mpeg' });
    const orphanFresh = await service.rpc('list_music_orphan_objects', { p_limit: 500 });
    record('fresh unregistered object is not swept yet (< 1 h)', !orphanUp.error && !(orphanFresh.data ?? []).some((rowIn) => rowIn.name === orphan), codeOf(orphanUp));
    const sweep = await service.storage.from(BUCKET).list(A.id, { limit: 1000 });
    record('account-deletion sweep sees music objects at <uid>/', (sweep.data ?? []).some((entry) => entry.id && `${A.id}/${entry.name}` === orphan));

    // Stage 4: custom sources (owner-only rows; the server never calls a source).
    const source = { manifest_url: 'https://qa16-source.example/omnilume.json', name: 'QA source', search_url: 'https://qa16-source.example/search?q={query}', health_url: null, responsibility_accepted: true };
    const added = await A.client.from('music_custom_sources').insert(source).select('id').single();
    record('owner adds an https custom source', !added.error, codeOf(added));
    const plainHttp = await A.client.from('music_custom_sources').insert({ ...source, manifest_url: 'http://qa16-source.example/m.json' });
    record('non-local http source refused', codeOf(plainHttp) === '23514', codeOf(plainHttp));
    const noResponsibility = await A.client.from('music_custom_sources').insert({ ...source, manifest_url: 'https://qa16-two.example/m.json', responsibility_accepted: false });
    record('source without the responsibility box refused', codeOf(noResponsibility) === '23514', codeOf(noResponsibility));
    const noQuery = await A.client.from('music_custom_sources').insert({ ...source, manifest_url: 'https://qa16-two.example/m.json', search_url: 'https://qa16-two.example/search' });
    record('search URL without {query} refused', codeOf(noQuery) === '23514', codeOf(noQuery));
    const mSources = await M.client.from('music_custom_sources').select('id');
    record('other users cannot read my sources', rows(mSources) === 0, `${rows(mSources)} row(s)`);
    await M.client.from('music_custom_sources').delete().eq('id', added.data?.id ?? randomUUID());
    const stillMine = await A.client.from('music_custom_sources').select('id').eq('id', added.data?.id ?? randomUUID());
    record('other users cannot delete my sources', rows(stillMine) === 1, `${rows(stillMine)} row(s)`);
    const forA = await B.client.from('music_custom_sources').insert({ ...source, owner_id: A.id, manifest_url: 'https://qa16-three.example/m.json' });
    record('cannot add a source for someone else', codeOf(forA) === '42501', codeOf(forA));
    const toggle = await A.client.from('music_custom_sources').update({ enabled: false, last_status: 'error', last_message: 'probe', last_checked_at: new Date().toISOString() }).eq('id', added.data?.id);
    record('owner can toggle and record a health check', !toggle.error, codeOf(toggle));
    const moveUrl = await A.client.from('music_custom_sources').update({ manifest_url: 'https://elsewhere.example/m.json' }).eq('id', added.data?.id);
    record('manifest URL cannot be rewritten (re-add instead)', codeOf(moveUrl) === '42501', codeOf(moveUrl));
    const anonSources = await anon.from('music_custom_sources').select('id');
    record('anon cannot read sources', Boolean(anonSources.error), codeOf(anonSources));
  } finally {
    // Account-deletion order: objects first, then the auth users (rows cascade).
    for (const user of [A, M, B]) {
      const listed = await service.storage.from(BUCKET).list(user.id, { limit: 1000 });
      const paths = (listed.data ?? []).filter((entry) => entry.id).map((entry) => `${user.id}/${entry.name}`);
      if (paths.length) await service.storage.from(BUCKET).remove(paths);
    }
    for (const id of rooms) {
      await service.from('music_listen_sessions').delete().eq('target_id', id);
      await service.from('rooms').delete().eq('id', id);
    }
    for (const id of throwaway) await service.auth.admin.deleteUser(id);
    const leftover = await service.from('music_uploads').select('id').in('owner_id', throwaway);
    record('fixtures removed (rows cascade with the users)', rows(leftover) === 0, `${rows(leftover)} row(s)`);
    const leftoverSources = await service.from('music_custom_sources').select('id').in('owner_id', throwaway);
    record('custom sources cascade with account deletion', rows(leftoverSources) === 0, `${rows(leftoverSources)} row(s)`);
  }

  const failed = results.filter((pass) => !pass).length;
  console.log(`\nA16 music probe: ${results.length - failed} pass, ${failed} fail`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(`A16 music probe aborted: ${error.message}`);
  process.exit(1);
});
