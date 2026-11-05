// Study and collaboration probe (Action 12, migration 20261107100000).
//
//   node scripts/security/collab-probe.mjs
//
// Two disposable QA accounts (OMNILUME_QA_{A,B}_{EMAIL,PASSWORD} or *_FILE).
// A owns new qa-* rooms; B is checked as member, then admin, and as an
// outsider of another room; an anonymous client is checked too. Covers notes
// history/lock, hands, polls, countdowns, tasks, events, study resources,
// voice moderation, consented recordings (private bucket), transcripts,
// search, and the Realtime topics used by Action 12. Fixtures (rooms and
// recording objects) are deleted with the service role at the end. Output:
// codes and pass/fail only.

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
  console.log(`${pass ? 'PASS' : 'FAIL'}  A12  ${check}${detail ? `  [${detail}]` : ''}`);
};
const codeOf = (res) => (res?.error ? String(res.error.code ?? res.error.statusCode ?? 'error') : 'ok');
const rows = (res) => (Array.isArray(res?.data) ? res.data.length : res?.data ? 1 : 0);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const webm = () => new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01])], { type: 'audio/webm' });

async function signIn(label) {
  const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, options);
  const { data, error } = await client.auth.signInWithPassword({ email: secret(`OMNILUME_QA_${label}_EMAIL`), password: secret(`OMNILUME_QA_${label}_PASSWORD`) });
  if (error || !data.session) throw new Error(`Sign-in failed for account ${label}.`);
  client.realtime.setAuth(data.session.access_token);
  return { client, id: data.user.id };
}

async function createRoom(owner, tag, suffix) {
  const id = randomUUID();
  const insert = await owner.client.from('rooms').insert({ id, name: `${tag}-${suffix}`, description: 'Disposable collaboration probe.', is_private: true, expiration_type: 'recoverable', expires_at: new Date(Date.now() + 2 * 3600_000).toISOString(), created_by: owner.id, username: null });
  if (insert.error) throw new Error(`room: ${codeOf(insert)}`);
  await owner.client.from('room_members').insert({ room_id: id, user_id: owner.id, role: 'owner', join_status: 'approved' });
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
  const R = await createRoom(A, tag, 'collab');
  const R2 = await createRoom(A, tag, 'outsider');
  const channels = [];
  const objects = [];
  const token = `probe${randomUUID().slice(0, 6)}`;

  try {
    await B.client.rpc('request_room_join', { p_identifier: R });
    const approve = await A.client.rpc('review_room_member', { p_room_id: R, p_target_user_id: B.id, p_action: 'approve', p_reason: '' });
    if (approve.error) throw new Error(`approve: ${codeOf(approve)}`);

    // Notes: history and read-only lock.
    const note = await A.client.rpc('create_study_note', { p_room_id: R, p_scope: 'room', p_title: 'Probe note', p_content: 'v1' });
    const noteId = note.data?.id;
    const memberEdit = await B.client.rpc('update_study_note', { p_note_id: noteId, p_expected_version: 1, p_title: 'Probe note', p_content: `v2 ${token}` });
    const memberLock = await B.client.rpc('set_study_note_locked', { p_note_id: noteId, p_locked: true });
    const ownerLock = await A.client.rpc('set_study_note_locked', { p_note_id: noteId, p_locked: true });
    const lockedEdit = await B.client.rpc('update_study_note', { p_note_id: noteId, p_expected_version: 2, p_title: 'x', p_content: 'sneaky' });
    record('a member edits a room note; only the author/manager can lock it; locked notes refuse member edits', !memberEdit.error && memberLock.error?.code === '42501' && !ownerLock.error && lockedEdit.error?.code === '42501', `${codeOf(memberEdit)}/${codeOf(memberLock)}/${codeOf(ownerLock)}/${codeOf(lockedEdit)}`);
    const history = await B.client.rpc('list_study_note_versions', { p_note_id: noteId });
    const directVersions = await B.client.from('study_note_versions').select('id').eq('note_id', noteId);
    record('note history is readable through the RPC only', rows(history) === 1 && (Boolean(directVersions.error) || rows(directVersions) === 0), `${rows(history)} via rpc, direct=${codeOf(directVersions)}`);
    const restore = await A.client.rpc('restore_study_note_version', { p_note_id: noteId, p_version: 1, p_expected_version: 2 });
    record('the author restores an earlier version', restore.data?.content === 'v1', codeOf(restore));

    // Hands.
    await A.client.rpc('raise_room_hand', { p_room_id: R });
    const memberRaise = await B.client.rpc('raise_room_hand', { p_room_id: R });
    const memberLowerOther = await B.client.rpc('lower_room_hand', { p_room_id: R, p_user_id: A.id });
    const ownerLowerMember = await A.client.rpc('lower_room_hand', { p_room_id: R, p_user_id: B.id });
    const handsLeft = await B.client.from('room_hand_raises').select('user_id').eq('room_id', R);
    record('members raise hands; only managers lower others', !memberRaise.error && memberLowerOther.error?.code === '42501' && !ownerLowerMember.error && rows(handsLeft) === 1, `${codeOf(memberLowerOther)} left=${rows(handsLeft)}`);

    // Polls.
    const poll = await B.client.rpc('create_room_poll', { p_room_id: R, p_question: `Which chapter ${token}?`, p_options: ['Four', 'Five'] });
    const ownerVote = await A.client.rpc('vote_room_poll', { p_poll_id: poll.data, p_option_index: 1 });
    const memberVote = await B.client.rpc('vote_room_poll', { p_poll_id: poll.data, p_option_index: 0 });
    const doubleVote = await B.client.rpc('vote_room_poll', { p_poll_id: poll.data, p_option_index: 1 });
    record('one vote per member', !ownerVote.error && !memberVote.error && doubleVote.error?.code === '23505', `${codeOf(doubleVote)}`);
    const seenVotes = await B.client.from('room_poll_votes').select('user_id').eq('poll_id', poll.data);
    const totals = await B.client.rpc('get_room_poll_results', { p_room_id: R });
    const pollTotals = totals.data?.find((row) => row.poll_id === poll.data);
    record('votes stay private: members see only their own vote and the totals', rows(seenVotes) === 1 && seenVotes.data?.[0]?.user_id === B.id && pollTotals?.total === 2 && pollTotals?.my_vote === 0, `own=${rows(seenVotes)} total=${pollTotals?.total}`);
    const memberClose = await B.client.rpc('close_room_poll', { p_poll_id: poll.data });
    const lateVote = await A.client.rpc('vote_room_poll', { p_poll_id: poll.data, p_option_index: 0 });
    record('the creator closes their poll; closed polls refuse votes', !memberClose.error && Boolean(lateVote.error), `${codeOf(memberClose)}/${codeOf(lateVote)}`);
    const directPoll = await B.client.from('room_polls').insert({ room_id: R, created_by: B.id, question: 'x', options: ['a', 'b'] });
    record('direct poll writes are refused', Boolean(directPoll.error), codeOf(directPoll));

    // Countdowns.
    const countdown = await B.client.rpc('create_room_countdown', { p_room_id: R, p_label: 'Break', p_ends_at: new Date(Date.now() + 600_000).toISOString() });
    const pastCountdown = await B.client.rpc('create_room_countdown', { p_room_id: R, p_label: 'Late', p_ends_at: new Date(Date.now() - 60_000).toISOString() });
    const ownerCancel = await A.client.rpc('cancel_room_countdown', { p_countdown_id: countdown.data });
    record('members start countdowns, invalid ends are refused, managers cancel', !countdown.error && pastCountdown.error?.code === '22023' && !ownerCancel.error, `${codeOf(pastCountdown)}/${codeOf(ownerCancel)}`);

    // Tasks + notification to the assignee.
    const task = await A.client.rpc('create_room_task', { p_room_id: R, p_title: `Summarise ${token}`, p_details: '', p_assignee_id: B.id, p_due_at: null });
    await sleep(500);
    const taskNotice = await B.client.from('room_notifications').select('id').eq('room_id', R).eq('notification_type', 'task');
    const assigneeDone = await B.client.rpc('set_room_task_done', { p_task_id: task.data, p_done: true });
    const assigneeDelete = await B.client.rpc('delete_room_task', { p_task_id: task.data });
    record('a task notifies its assignee, who can complete but not delete it', !task.error && rows(taskNotice) === 1 && !assigneeDone.error && assigneeDelete.error?.code === '42501', `notice=${rows(taskNotice)} ${codeOf(assigneeDelete)}`);

    // Room events (announcement managers) + member notification.
    const memberEvent = await B.client.rpc('create_room_event', { p_room_id: R, p_title: 'Mine', p_details: '', p_starts_at: new Date(Date.now() + 86400_000).toISOString(), p_ends_at: null });
    const ownerEvent = await A.client.rpc('create_room_event', { p_room_id: R, p_title: `Review ${token}`, p_details: 'Bring notes', p_starts_at: new Date(Date.now() + 86400_000).toISOString(), p_ends_at: null });
    await sleep(500);
    const eventNotice = await B.client.from('room_notifications').select('id').eq('room_id', R).eq('notification_type', 'room_event');
    record('only announcement managers schedule events; members are notified', memberEvent.error?.code === '42501' && !ownerEvent.error && rows(eventNotice) === 1, `${codeOf(memberEvent)} notice=${rows(eventNotice)}`);

    // Study resources, progress, timestamped notes.
    const resource = await B.client.rpc('add_study_resource', { p_room_id: R, p_kind: 'youtube', p_title: `Lecture ${token}`, p_url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', p_media_id: null });
    const badResource = await B.client.rpc('add_study_resource', { p_room_id: R, p_kind: 'youtube', p_title: 'Bad', p_url: 'https://evil.example/watch?v=1', p_media_id: null });
    const progress = await B.client.rpc('save_resource_progress', { p_resource_id: resource.data, p_position: 125, p_duration: 600 });
    const ownerSeesProgress = await A.client.from('room_resource_progress').select('user_id').eq('room_id', R);
    const personalNote = await B.client.rpc('add_resource_note', { p_resource_id: resource.data, p_at_seconds: 42, p_body: 'private', p_scope: 'personal' });
    const ownerSeesNotes = await A.client.from('room_resource_notes').select('id').eq('room_id', R);
    record('resources validate links; progress and personal notes stay private', !resource.error && badResource.error?.code === '22023' && !progress.error && rows(ownerSeesProgress) === 0 && !personalNote.error && rows(ownerSeesNotes) === 0, `${codeOf(badResource)} progress=${rows(ownerSeesProgress)} notes=${rows(ownerSeesNotes)}`);

    // Voice moderation.
    const memberMute = await B.client.rpc('set_room_voice_moderation', { p_room_id: R, p_user_id: A.id, p_audio_muted: true, p_screen_blocked: false });
    const ownerMute = await A.client.rpc('set_room_voice_moderation', { p_room_id: R, p_user_id: B.id, p_audio_muted: true, p_screen_blocked: true });
    const memberSeesMute = await B.client.from('room_voice_moderation').select('audio_muted, screen_blocked').eq('room_id', R).eq('user_id', B.id).maybeSingle();
    record('only managers mute or stop screen share; the member sees it', memberMute.error?.code === '42501' && !ownerMute.error && memberSeesMute.data?.audio_muted === true && memberSeesMute.data?.screen_blocked === true, `${codeOf(memberMute)}/${codeOf(ownerMute)}`);

    // Admin defaults: managers moderate, but never the owner.
    const promote = await A.client.rpc('set_room_member_role', { p_room_id: R, p_target_user_id: B.id, p_role: 'admin' });
    const adminLower = await B.client.rpc('lower_room_hand', { p_room_id: R, p_user_id: A.id });
    const adminMuteOwner = await B.client.rpc('set_room_voice_moderation', { p_room_id: R, p_user_id: A.id, p_audio_muted: true, p_screen_blocked: false });
    record('an admin lowers hands but cannot mute the owner', !promote.error && !adminLower.error && adminMuteOwner.error?.code === '42501', `${codeOf(adminLower)}/${codeOf(adminMuteOwner)}`);
    await A.client.rpc('set_room_member_role', { p_room_id: R, p_target_user_id: B.id, p_role: 'member' });

    // Consented recording.
    const memberRequest = await B.client.rpc('request_room_recording', { p_room_id: R, p_participants: [A.id] });
    const request = await A.client.rpc('request_room_recording', { p_room_id: R, p_participants: [B.id] });
    const recordingId = request.data;
    const earlyUpload = await A.client.storage.from('room_recordings').upload(`${R}/${recordingId}.webm`, webm(), { contentType: 'audio/webm' });
    record('only managers ask to record; nothing uploads before everyone consents', memberRequest.error?.code === '42501' && !request.error && Boolean(earlyUpload.error), `${codeOf(memberRequest)}/early=${earlyUpload.error ? 'refused' : 'ALLOWED'}`);
    const consent = await B.client.rpc('respond_room_recording', { p_recording_id: recordingId, p_granted: true });
    const memberUpload = await B.client.storage.from('room_recordings').upload(`${R}/${recordingId}.webm`, webm(), { contentType: 'audio/webm' });
    const ownerUpload = await A.client.storage.from('room_recordings').upload(`${R}/${recordingId}.webm`, webm(), { contentType: 'audio/webm' });
    if (!ownerUpload.error) objects.push(`${R}/${recordingId}.webm`);
    record('after full consent only the requester uploads', consent.data === 'recording' && Boolean(memberUpload.error) && !ownerUpload.error, `${consent.data}/${memberUpload.error ? 'member refused' : 'member ALLOWED'}/${codeOf(ownerUpload)}`);
    const finish = await A.client.rpc('finish_room_recording', { p_recording_id: recordingId, p_storage_path: `${R}/${recordingId}.webm`, p_duration_seconds: 3 });
    const participantUrl = await B.client.storage.from('room_recordings').createSignedUrl(`${R}/${recordingId}.webm`, 60);
    const anonUrl = await anon.storage.from('room_recordings').createSignedUrl(`${R}/${recordingId}.webm`, 60);
    record('participants can play a finished recording; anon cannot', !finish.error && Boolean(participantUrl.data?.signedUrl) && Boolean(anonUrl.error), `${codeOf(finish)}/${participantUrl.data?.signedUrl ? 'url' : 'none'}/${anonUrl.error ? 'anon refused' : 'anon ALLOWED'}`);
    const t1 = await A.client.rpc('save_room_transcript', { p_recording_id: recordingId, p_expected_version: 0, p_body: `Transcript ${token}` });
    const t2 = await B.client.rpc('save_room_transcript', { p_recording_id: recordingId, p_expected_version: 1, p_body: `Transcript ${token} edited` });
    const stale = await A.client.rpc('save_room_transcript', { p_recording_id: recordingId, p_expected_version: 1, p_body: 'stale' });
    record('participants edit the manual transcript with version checks', t1.data === 1 && t2.data === 2 && stale.error?.code === '23514', `${codeOf(t1)}/${codeOf(t2)}/${codeOf(stale)}`);

    // One participant declining cancels the request; nothing can be uploaded.
    const declineReq = await A.client.rpc('request_room_recording', { p_room_id: R, p_participants: [B.id] });
    const decline = await B.client.rpc('respond_room_recording', { p_recording_id: declineReq.data, p_granted: false });
    const declinedUpload = await A.client.storage.from('room_recordings').upload(`${R}/${declineReq.data}.webm`, webm(), { contentType: 'audio/webm' });
    record('a single decline cancels the recording and blocks any upload', !declineReq.error && decline.data === 'cancelled' && Boolean(declinedUpload.error), `${codeOf(declineReq)}/${decline.data}/${declinedUpload.error ? 'refused' : 'ALLOWED'}`);
    if (!declinedUpload.error) objects.push(`${R}/${declineReq.data}.webm`);

    // A recording in a room B is not in stays invisible to B.
    const solo = await A.client.rpc('request_room_recording', { p_room_id: R2, p_participants: [] });
    const soloUpload = await A.client.storage.from('room_recordings').upload(`${R2}/${solo.data}.webm`, webm(), { contentType: 'audio/webm' });
    if (!soloUpload.error) objects.push(`${R2}/${solo.data}.webm`);
    await A.client.rpc('finish_room_recording', { p_recording_id: solo.data, p_storage_path: `${R2}/${solo.data}.webm`, p_duration_seconds: 1 });
    const outsiderRow = await B.client.from('room_recordings').select('id').eq('id', solo.data);
    const outsiderUrl = await B.client.storage.from('room_recordings').createSignedUrl(`${R2}/${solo.data}.webm`, 60);
    record('outsiders see neither the recording row nor its file', !solo.error && rows(outsiderRow) === 0 && Boolean(outsiderUrl.error), `rows=${rows(outsiderRow)} url=${outsiderUrl.error ? 'refused' : 'ALLOWED'}`);

    // Search is capability-scoped.
    const search = await B.client.rpc('search_room_history', { p_room_id: R, p_query: token, p_limit: 40 });
    const kinds = [...new Set((search.data ?? []).map((row) => row.kind))].sort();
    const outsiderSearch = await B.client.rpc('search_room_history', { p_room_id: R2, p_query: 'probe', p_limit: 40 });
    const anonSearch = await anon.rpc('search_room_history', { p_room_id: R, p_query: token, p_limit: 40 });
    record('members search what they can see; outsiders and anon cannot', ['event', 'poll', 'resource', 'task', 'transcript'].every((kind) => kinds.includes(kind)) && outsiderSearch.error?.code === '42501' && Boolean(anonSearch.error), `kinds=${kinds.join(',')} ${codeOf(outsiderSearch)}/${codeOf(anonSearch)}`);

    // Anonymous callers.
    const anonRaise = await anon.rpc('raise_room_hand', { p_room_id: R });
    const anonRead = await anon.from('room_polls').select('id').eq('room_id', R);
    record('anon can neither call RPCs nor read rows', Boolean(anonRaise.error) && (Boolean(anonRead.error) || rows(anonRead) === 0), `${codeOf(anonRaise)}/${codeOf(anonRead)}`);

    // Realtime: hints and signaling on sync-chat, cursors on sync-study.
    const aEvents = [];
    const bEvents = [];
    const aChat = await listen(A, `sync-chat:${R}`, aEvents);
    const bChat = await listen(B, `sync-chat:${R}`, bEvents);
    const aStudy = await listen(A, `sync-study:${R}`, aEvents);
    const bStudy = await listen(B, `sync-study:${R}`, bEvents);
    channels.push([A.client, aChat.channel], [B.client, bChat.channel], [A.client, aStudy.channel], [B.client, bStudy.channel]);
    await aChat.channel.send(wire(A, R, 'collab_changed', { version: Date.now(), kind: 'polls' }));
    await bChat.channel.send(wire(B, R, 'rtc_signal', { kind: 'hello' }));
    await aStudy.channel.send(wire(A, R, 'cursor', { x: 10, y: 20 }));
    await sleep(2500);
    record('collaboration hints, signaling and cursors reach members on private topics', bEvents.includes('collab_changed') && bEvents.includes('cursor') && aEvents.includes('rtc_signal'), `member got=${bEvents.join(',')} owner got=${aEvents.join(',')}`);

    // Study off: study data disappears and the study topic refuses the member.
    await A.client.rpc('update_room_controls', { p_room_id: R, p_rules: null, p_welcome_message: null, p_is_locked: null, p_feature_flags: { study: false } });
    const offTasks = await B.client.from('room_tasks').select('id').eq('room_id', R);
    const offCreate = await B.client.rpc('create_room_task', { p_room_id: R, p_title: 'x', p_details: '', p_assignee_id: null, p_due_at: null });
    const offEvents = [];
    const offStudy = await listen(B, `sync-study:${R}`, offEvents);
    channels.push([B.client, offStudy.channel]);
    record('with Study off, tasks are hidden, writes refused and the study topic is closed', rows(offTasks) === 0 && offCreate.error?.code === '42501' && offStudy.status !== 'SUBSCRIBED', `rows=${rows(offTasks)} ${codeOf(offCreate)} topic=${offStudy.status}`);
  } finally {
    for (const [client, channel] of channels) await client.removeChannel(channel);
    if (objects.length) await service.storage.from('room_recordings').remove(objects);
    for (const roomId of [R, R2]) await service.from('rooms').delete().eq('id', roomId).like('name', 'qa-%');
  }

  const passed = results.filter(Boolean).length;
  console.log(`\nsummary: ${passed} pass, ${results.length - passed} fail`);
  process.exit(results.length === passed ? 0 : 1);
}

main().catch((error) => {
  console.error(`collab probe aborted: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
});
