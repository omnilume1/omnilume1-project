// Activity, discovery and management probe (Action 13, migration 20261108100000).
//
//   node scripts/security/management-probe.mjs
//
// Two disposable QA accounts (OMNILUME_QA_{A,B}_{EMAIL,PASSWORD} or *_FILE).
// A owns new qa-* rooms; B is checked as member, then admin, and as an
// outsider of the private room; an anonymous client is checked too. Covers
// discovery privacy (private / locked / scheduled rooms never listed),
// activity and pulse RLS/RPC, activity over Postgres Changes, bookmarks,
// templates, trust levels, export (owner/admin, rate limit, no keys or
// ciphertext) and RSVPs. Fixtures are deleted with the service role at the
// end. Output: codes and pass/fail only.

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
  console.log(`${pass ? 'PASS' : 'FAIL'}  A13  ${check}${detail ? `  [${detail}]` : ''}`);
};
const codeOf = (res) => (res?.error ? String(res.error.code ?? res.error.statusCode ?? 'error') : 'ok');
const rows = (res) => (Array.isArray(res?.data) ? res.data.length : res?.data ? 1 : 0);
const ids = (res) => (Array.isArray(res?.data) ? res.data.map((row) => row.id ?? row.room_id) : []);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function signIn(label) {
  const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, options);
  const { data, error } = await client.auth.signInWithPassword({ email: secret(`OMNILUME_QA_${label}_EMAIL`), password: secret(`OMNILUME_QA_${label}_PASSWORD`) });
  if (error || !data.session) throw new Error(`Sign-in failed for account ${label}.`);
  client.realtime.setAuth(data.session.access_token);
  return { client, id: data.user.id };
}

async function createRoom(owner, tag, suffix, { isPrivate = true, scheduled = false } = {}) {
  const id = randomUUID();
  const insert = await owner.client.from('rooms').insert({
    id, name: `${tag}-${suffix}`, description: `Disposable management probe ${suffix}.`, is_private: isPrivate,
    expiration_type: 'recoverable', expires_at: new Date(Date.now() + (scheduled ? 4 : 2) * 3600_000).toISOString(), created_by: owner.id, username: null,
    ...(scheduled ? { scheduled_for: new Date(Date.now() + 3600_000).toISOString() } : {}),
  });
  if (insert.error) throw new Error(`room ${suffix}: ${codeOf(insert)}`);
  await owner.client.from('room_members').insert({ room_id: id, user_id: owner.id, role: 'owner', join_status: 'approved' });
  return id;
}

async function main() {
  const A = await signIn('A');
  const B = await signIn('B');
  const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, options);
  const tag = `qa-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  const RPUB = await createRoom(A, tag, 'pub', { isPrivate: false });
  const RPRIV = await createRoom(A, tag, 'priv');
  const RLOCK = await createRoom(A, tag, 'lock', { isPrivate: false });
  const RSCH = await createRoom(A, tag, 'sched', { isPrivate: false, scheduled: true }).catch(() => null);
  const rooms = [RPUB, RPRIV, RLOCK, RSCH].filter(Boolean);
  const channels = [];
  const token = `probe${randomUUID().slice(0, 6)}`;

  try {
    const join = await B.client.rpc('request_room_join', { p_identifier: RPUB });
    if (join.data?.[0]?.status === 'pending') await A.client.rpc('review_room_member', { p_room_id: RPUB, p_target_user_id: B.id, p_action: 'approve', p_reason: '' });
    await A.client.rpc('update_room_controls', { p_room_id: RLOCK, p_rules: null, p_welcome_message: null, p_is_locked: true, p_feature_flags: null });
    const hidden = [RPRIV, RLOCK, RSCH].filter(Boolean);

    // --- Discovery privacy ------------------------------------------------
    const bPublic = await B.client.rpc('discover_rooms', { p_query: tag, p_limit: 48 });
    const bIds = ids(bPublic);
    record('a member discovers the public room but never the private, locked or scheduled ones', bIds.includes(RPUB) && hidden.every((id) => !bIds.includes(id)), `found=${bIds.length} ${codeOf(bPublic)}`);
    const anonPublic = await anon.rpc('discover_rooms', { p_query: tag, p_limit: 48 });
    record('anon discovers the same public room and none of the hidden ones', ids(anonPublic).includes(RPUB) && hidden.every((id) => !ids(anonPublic).includes(id)), `found=${ids(anonPublic).length}`);
    const byDescription = await B.client.rpc('discover_rooms', { p_query: 'management probe priv', p_limit: 48 });
    record('searching the private room by its text finds nothing for a non-member', !ids(byDescription).includes(RPRIV), `found=${ids(byDescription).length}`);
    const aMine = await A.client.rpc('discover_rooms', { p_query: tag, p_scope: 'mine', p_limit: 48 });
    const bMine = await B.client.rpc('discover_rooms', { p_query: tag, p_scope: 'mine', p_limit: 48 });
    record('"My rooms" lists the owner\'s private room and not a non-member\'s', ids(aMine).includes(RPRIV) && !ids(bMine).includes(RPRIV) && ids(bMine).includes(RPUB), `owner=${ids(aMine).length} member=${ids(bMine).length}`);
    const anonMine = await anon.rpc('discover_rooms', { p_scope: 'mine' });
    const badFilter = await B.client.rpc('discover_rooms', { p_lifespan: 'bogus' });
    record('"My rooms" needs a session; invalid filters are rejected', Boolean(anonMine.error) && badFilter.error?.code === '22023', `${codeOf(anonMine)}/${codeOf(badFilter)}`);
    const lifespan = await B.client.rpc('discover_rooms', { p_query: tag, p_lifespan: 'permanent', p_limit: 48 });
    const members = await B.client.rpc('discover_rooms', { p_query: tag, p_min_members: 2, p_limit: 48 });
    const sorted = await B.client.rpc('discover_rooms', { p_query: tag, p_sort: 'members', p_limit: 48 });
    record('lifespan, member-count and sort filters apply', !ids(lifespan).includes(RPUB) && ids(members).includes(RPUB) && ids(sorted).includes(RPUB), `${ids(lifespan).length}/${ids(members).length}/${ids(sorted).length}`);

    // --- Activity + realtime ---------------------------------------------
    const seen = [];
    const listener = B.client.channel(`sync:${RPUB}`, { config: { private: true } })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_activity', filter: `room_id=eq.${RPUB}` }, (message) => seen.push(message.new?.kind))
      .subscribe();
    channels.push([B.client, listener]);
    await sleep(3500);
    await A.client.rpc('create_room_announcement', { p_room_id: RPUB, p_body: `Welcome ${token}`, p_is_pinned: false });
    const poll = await A.client.rpc('create_room_poll', { p_room_id: RPUB, p_question: `Poll ${token}?`, p_options: ['Yes', 'No'] });
    const event = await A.client.rpc('create_room_event', { p_room_id: RPUB, p_title: `Event ${token}`, p_details: '', p_starts_at: new Date(Date.now() + 3 * 3600_000).toISOString(), p_ends_at: null });
    const task = await A.client.rpc('create_room_task', { p_room_id: RPUB, p_title: `Task ${token}`, p_details: '', p_assignee_id: B.id, p_due_at: null });
    await A.client.rpc('create_room_announcement', { p_room_id: RPRIV, p_body: 'private only', p_is_pinned: false });
    await sleep(3500);
    record('activity rows are written by the existing actions (announcement, poll, event, task)', !poll.error && !event.error && !task.error, `${codeOf(poll)}/${codeOf(event)}/${codeOf(task)}`);
    record('a member receives new activity over Postgres Changes on the private room channel', seen.includes('announcement') && seen.includes('poll_created'), `got=${[...new Set(seen)].join(',')}`);
    const bActivity = await B.client.rpc('list_room_activity', { p_room_id: RPUB, p_limit: 50 });
    const kinds = (bActivity.data ?? []).map((row) => row.kind);
    const eventLabel = (bActivity.data ?? []).find((row) => row.kind === 'event_scheduled')?.label;
    record('a member reads the room history with labels the role may see', ['member_joined', 'announcement', 'poll_created', 'event_scheduled', 'task_created'].every((kind) => kinds.includes(kind)) && eventLabel === `Event ${token}`, `${kinds.length} rows, ${codeOf(bActivity)}`);
    const outsiderRpc = await B.client.rpc('list_room_activity', { p_room_id: RPRIV });
    const outsiderRows = await B.client.from('room_activity').select('id').eq('room_id', RPRIV);
    const outsiderPulse = await B.client.rpc('get_room_pulse', { p_room_id: RPRIV });
    record('an outsider gets no history, no rows and no pulse from the private room', outsiderRpc.error?.code === '42501' && rows(outsiderRows) === 0 && outsiderPulse.error?.code === '42501', `${codeOf(outsiderRpc)}/${rows(outsiderRows)}/${codeOf(outsiderPulse)}`);
    const outsiderEvents = [];
    const outsiderChannel = B.client.channel(`sync:${RPRIV}`, { config: { private: true } })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_activity', filter: `room_id=eq.${RPRIV}` }, (message) => outsiderEvents.push(message.new?.kind))
      .subscribe();
    channels.push([B.client, outsiderChannel]);
    await sleep(3000);
    await A.client.rpc('create_room_announcement', { p_room_id: RPRIV, p_body: 'second private', p_is_pinned: false });
    await sleep(2500);
    record('an outsider receives no live activity from the private room', outsiderEvents.length === 0, `got=${outsiderEvents.length}`);
    const directInsert = await B.client.from('room_activity').insert({ room_id: RPUB, kind: 'announcement', dedupe_key: 'x' });
    const anonActivity = await anon.rpc('list_room_activity', { p_room_id: RPUB });
    const anonPulse = await anon.rpc('get_room_pulse', { p_room_id: RPUB });
    record('direct writes are refused; anon cannot read history or pulse', Boolean(directInsert.error) && Boolean(anonActivity.error) && Boolean(anonPulse.error), `${codeOf(directInsert)}/${codeOf(anonActivity)}/${codeOf(anonPulse)}`);
    const pulse = await B.client.rpc('get_room_pulse', { p_room_id: RPUB });
    record('the pulse returns counts and the next event for a member', typeof pulse.data?.activity_1h === 'number' && pulse.data?.next_event?.title === `Event ${token}` && pulse.data?.open_tasks_mine === 1, `${codeOf(pulse)}`);
    const crossRoom = await service.from('room_activity').select('room_id').in('room_id', [RPUB, RPRIV]).like('dedupe_key', 'announcement:%');
    record('activity rows stay in their own room (cross-room isolation)', (crossRoom.data ?? []).every((row) => [RPUB, RPRIV].includes(row.room_id)) && (bActivity.data ?? []).every((row) => row.label !== 'private only'), `rows=${rows(crossRoom)}`);

    // --- Bookmarks ----------------------------------------------------------
    const message = await A.client.from('messages').insert({ room_id: RPUB, sender_id: A.id, content: `Saved line ${token}` }).select('id').single();
    const privateMessage = await A.client.from('messages').insert({ room_id: RPRIV, sender_id: A.id, content: `private line ${token}` }).select('id').single();
    const saveRoom = await B.client.rpc('set_room_bookmark', { p_room_id: RPUB, p_kind: 'room', p_entity_id: RPUB, p_saved: true, p_note: '' });
    const saveMessage = await B.client.rpc('set_room_bookmark', { p_room_id: RPUB, p_kind: 'message', p_entity_id: message.data?.id, p_saved: true, p_note: '' });
    const savePrivateRoom = await B.client.rpc('set_room_bookmark', { p_room_id: RPRIV, p_kind: 'room', p_entity_id: RPRIV, p_saved: true, p_note: '' });
    const savePrivateMessage = await B.client.rpc('set_room_bookmark', { p_room_id: RPRIV, p_kind: 'message', p_entity_id: privateMessage.data?.id, p_saved: true, p_note: '' });
    const saveCross = await B.client.rpc('set_room_bookmark', { p_room_id: RPUB, p_kind: 'message', p_entity_id: privateMessage.data?.id, p_saved: true, p_note: '' });
    record('a member saves a room and a message; private rooms and cross-room ids are refused', !saveRoom.error && !saveMessage.error && savePrivateRoom.error?.code === '42501' && savePrivateMessage.error?.code === '42501' && saveCross.error?.code === '42501', `${codeOf(saveRoom)}/${codeOf(saveMessage)}/${codeOf(savePrivateRoom)}/${codeOf(savePrivateMessage)}/${codeOf(saveCross)}`);
    await A.client.rpc('set_room_bookmark', { p_room_id: RPRIV, p_kind: 'room', p_entity_id: RPRIV, p_saved: true, p_note: '' });
    const bSaved = await B.client.rpc('list_my_bookmarks', {});
    const bDirect = await B.client.from('room_bookmarks').select('room_id');
    const bookmarkInsert = await B.client.from('room_bookmarks').insert({ user_id: B.id, room_id: RPUB, kind: 'room', entity_id: RPUB });
    record('saved items are private to their owner and writable only through the RPC', rows(bSaved) === 2 && (bDirect.data ?? []).every((row) => row.room_id === RPUB) && Boolean(bookmarkInsert.error), `list=${rows(bSaved)} direct=${rows(bDirect)} insert=${codeOf(bookmarkInsert)}`);
    const anonBookmark = await anon.rpc('set_room_bookmark', { p_room_id: RPUB, p_kind: 'room', p_entity_id: RPUB, p_saved: true, p_note: '' });
    record('anon cannot save', Boolean(anonBookmark.error), codeOf(anonBookmark));
    await B.client.rpc('set_room_bookmark', { p_room_id: RPUB, p_kind: 'message', p_entity_id: message.data?.id, p_saved: false, p_note: '' });
    const afterRemove = await B.client.rpc('list_my_bookmarks', {});
    record('removing a saved item removes it', rows(afterRemove) === 1, `${rows(afterRemove)}`);

    // --- Templates ---------------------------------------------------------
    const builtIns = await B.client.from('room_templates').select('builtin_key').not('builtin_key', 'is', null);
    const aTemplate = await A.client.rpc('save_room_template', { p_room_id: RPUB, p_name: `T ${token}`, p_description: 'probe' });
    const bSeesOwners = await B.client.from('room_templates').select('id').eq('owner_id', A.id);
    const bSave = await B.client.rpc('save_room_template', { p_room_id: RPUB, p_name: 'nope', p_description: '' });
    const bApply = await B.client.rpc('apply_room_template', { p_room_id: RPUB, p_template_id: aTemplate.data });
    const aApply = await A.client.rpc('apply_room_template', { p_room_id: RPUB, p_template_id: (await A.client.from('room_templates').select('id').eq('builtin_key', 'study-session').single()).data?.id });
    const settings = await A.client.from('room_control_settings').select('feature_flags, theme').eq('room_id', RPUB).single();
    const templateInsert = await B.client.from('room_templates').insert({ name: 'x', config: {}, owner_id: B.id });
    record('built-in templates are shared, own templates are private, only managers save and only the owner applies', rows(builtIns) === 3 && !aTemplate.error && rows(bSeesOwners) === 0 && bSave.error?.code === '42501' && bApply.error?.code === '42501' && !aApply.error && settings.data?.feature_flags?.watch === false && Boolean(templateInsert.error), `builtins=${rows(builtIns)} ${codeOf(aTemplate)} ${codeOf(bSave)} ${codeOf(bApply)} ${codeOf(aApply)} theme=${settings.data?.theme}`);
    await A.client.rpc('update_room_controls', { p_room_id: RPUB, p_rules: null, p_welcome_message: null, p_is_locked: null, p_feature_flags: { watch: true, study: true } });

    // --- Trust ---------------------------------------------------------------
    const memberTrust = await B.client.rpc('get_room_trust_levels', { p_room_id: RPUB });
    const ownerTrust = await A.client.rpc('get_room_trust_levels', { p_room_id: RPUB });
    const outsiderTrust = await B.client.rpc('get_room_trust_levels', { p_room_id: RPRIV });
    record('trust levels: a member sees only their own, the owner sees everyone, outsiders see none', rows(memberTrust) === 1 && memberTrust.data?.[0]?.user_id === B.id && rows(ownerTrust) === 2 && ownerTrust.data?.find((row) => row.user_id === A.id)?.level === 'steward' && outsiderTrust.error?.code === '42501', `${rows(memberTrust)}/${rows(ownerTrust)}/${codeOf(outsiderTrust)}`);

    // --- Export ----------------------------------------------------------------
    await service.from('messages').insert({ room_id: RPUB, sender_id: A.id, ciphertext: 'ZmFrZQ==', iv: 'aXY=' });
    const memberExport = await B.client.rpc('export_room_snapshot', { p_room_id: RPUB });
    const anonExport = await anon.rpc('export_room_snapshot', { p_room_id: RPUB });
    const outsiderExport = await B.client.rpc('export_room_snapshot', { p_room_id: RPRIV });
    const ownerExport = await A.client.rpc('export_room_snapshot', { p_room_id: RPUB });
    const text = JSON.stringify(ownerExport.data ?? {});
    record('only an owner/admin exports; the file has no keys, ciphertext or links', memberExport.error?.code === '42501' && Boolean(anonExport.error) && outsiderExport.error?.code === '42501' && !ownerExport.error && ownerExport.data?.counts?.encrypted_messages_excluded >= 1 && !/public_key|ZmFrZQ|https?:\/\//.test(text) && text.includes(`Saved line ${token}`), `${codeOf(memberExport)}/${codeOf(anonExport)}/${codeOf(outsiderExport)}/${codeOf(ownerExport)}`);
    const digest = await A.client.rpc('record_room_export_digest', { p_export_id: ownerExport.data?.export_id, p_sha256: 'a'.repeat(64) });
    const digestAgain = await A.client.rpc('record_room_export_digest', { p_export_id: ownerExport.data?.export_id, p_sha256: 'b'.repeat(64) });
    const memberDigest = await B.client.rpc('record_room_export_digest', { p_export_id: ownerExport.data?.export_id, p_sha256: 'c'.repeat(64) });
    record('the digest is recorded once, by the requester only', !digest.error && digestAgain.error?.code === '42501' && memberDigest.error?.code === '42501', `${codeOf(digest)}/${codeOf(digestAgain)}/${codeOf(memberDigest)}`);
    await A.client.rpc('export_room_snapshot', { p_room_id: RPUB });
    await A.client.rpc('export_room_snapshot', { p_room_id: RPUB });
    const limited = await A.client.rpc('export_room_snapshot', { p_room_id: RPUB });
    const audit = await A.client.from('room_exports').select('id, sha256').eq('room_id', RPUB);
    const memberAudit = await B.client.from('room_exports').select('id').eq('room_id', RPUB);
    record('exports are rate limited and audited; members cannot read the audit', limited.error?.code === 'P0429' && rows(audit) === 3 && rows(memberAudit) === 0, `${codeOf(limited)} audit=${rows(audit)} member=${rows(memberAudit)}`);

    // --- RSVPs ---------------------------------------------------------------------
    const eventId = event.data;
    const going = await B.client.rpc('set_event_rsvp', { p_event_id: eventId, p_response: 'going' });
    const bad = await B.client.rpc('set_event_rsvp', { p_event_id: eventId, p_response: 'later' });
    const counts = await A.client.rpc('list_event_rsvp_counts', { p_room_id: RPUB });
    const mine = await B.client.rpc('list_event_rsvp_counts', { p_room_id: RPUB });
    const ownerSeesRows = await A.client.from('room_event_rsvps').select('user_id').eq('event_id', eventId);
    const anonRsvp = await anon.rpc('set_event_rsvp', { p_event_id: eventId, p_response: 'going' });
    record('members respond to events; counts are visible, answers are validated, anon is refused', !going.error && bad.error?.code === '22023' && counts.data?.find((row) => row.event_id === eventId)?.going === 1 && mine.data?.find((row) => row.event_id === eventId)?.my_response === 'going' && rows(ownerSeesRows) === 1 && Boolean(anonRsvp.error), `${codeOf(going)}/${codeOf(bad)}/${codeOf(anonRsvp)}`);

    // --- Overview --------------------------------------------------------------------
    const overview = await B.client.rpc('list_my_room_overview', {});
    const overviewIds = ids(overview);
    const upcoming = await B.client.rpc('list_my_upcoming_events', {});
    const tasks = await B.client.rpc('list_my_open_tasks', {});
    const anonOverview = await anon.rpc('list_my_room_overview', {});
    record('the cross-room dashboard returns only the caller\'s rooms, events and tasks', overviewIds.includes(RPUB) && !overviewIds.includes(RPRIV) && (upcoming.data ?? []).some((row) => row.event_id === eventId) && (tasks.data ?? []).some((row) => row.title === `Task ${token}`) && Boolean(anonOverview.error), `rooms=${overviewIds.length} events=${rows(upcoming)} tasks=${rows(tasks)}`);

    // --- Admin role ------------------------------------------------------------------
    await A.client.rpc('set_room_member_role', { p_room_id: RPUB, p_target_user_id: B.id, p_role: 'admin' });
    const adminTrust = await B.client.rpc('get_room_trust_levels', { p_room_id: RPUB });
    const adminApply = await B.client.rpc('apply_room_template', { p_room_id: RPUB, p_template_id: aTemplate.data });
    const adminExport = await B.client.rpc('export_room_snapshot', { p_room_id: RPUB });
    record('an admin sees all trust levels and may attempt export (rate limit applies) but cannot apply templates', rows(adminTrust) === 2 && adminApply.error?.code === '42501' && ['P0429', 'ok'].includes(codeOf(adminExport)), `${rows(adminTrust)}/${codeOf(adminApply)}/${codeOf(adminExport)}`);
  } finally {
    for (const [client, channel] of channels) await client.removeChannel(channel);
    await service.from('room_templates').delete().like('name', 'T probe%');
    for (const roomId of rooms) await service.from('rooms').delete().eq('id', roomId).like('name', 'qa-%');
  }

  const passed = results.filter(Boolean).length;
  console.log(`\nsummary: ${passed} pass, ${results.length - passed} fail`);
  process.exit(results.length === passed ? 0 : 1);
}

main().catch((error) => {
  console.error(`management probe aborted: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
});
