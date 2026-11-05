// Room-to-group conversion probe (Action 14, migration 20261108110000).
//
//   node scripts/security/conversion-probe.mjs
//
// Two disposable QA accounts (OMNILUME_QA_{A,B}_{EMAIL,PASSWORD} or *_FILE)
// plus three throw-away users created and deleted by this script with the
// service role (guest C, pending requester D, outsider E). Covers: who may
// convert, ineligible rooms, a concurrent double call, exactly-once members /
// notices / event, what migrates (and what does not), post-conversion RLS,
// closed joins, lifecycle cleanup never deleting the room, the legacy RPC,
// and the E2EE gate with untouched ciphertext. Fixtures are removed at the
// end (groups first: the source room is RESTRICTed while a group exists).
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

const results = [];
const record = (check, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  A14  ${check}${detail ? `  [${detail}]` : ''}`);
};
const codeOf = (res) => (res?.error ? String(res.error.code ?? res.error.statusCode ?? 'error') : 'ok');
const hintOf = (res) => res?.error?.hint ?? '';
const rows = (res) => (Array.isArray(res?.data) ? res.data.length : res?.data ? 1 : 0);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const newClient = () => createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, options);

async function signIn(label) {
  const client = newClient();
  const { data, error } = await client.auth.signInWithPassword({ email: secret(`OMNILUME_QA_${label}_EMAIL`), password: secret(`OMNILUME_QA_${label}_PASSWORD`) });
  if (error || !data.session) throw new Error(`Sign-in failed for account ${label}.`);
  client.realtime.setAuth(data.session.access_token);
  return { client, id: data.user.id };
}

const throwaway = [];
async function makeUser(tag) {
  const email = `qa14-${tag}-${randomUUID().slice(0, 8)}@example.invalid`;
  const password = `Pw-${randomUUID()}`;
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw new Error(`createUser ${tag}: ${created.error.message}`);
  throwaway.push(created.data.user.id);
  const client = newClient();
  const signed = await client.auth.signInWithPassword({ email, password });
  if (signed.error) throw new Error(`signIn ${tag}: ${signed.error.message}`);
  client.realtime.setAuth(signed.data.session.access_token);
  return { client, id: created.data.user.id };
}

async function createRoom(owner, name, { isPrivate = true, type = 'recoverable' } = {}) {
  const id = randomUUID();
  const insert = await owner.client.from('rooms').insert({
    id, name, description: 'Disposable conversion probe.', is_private: isPrivate, expiration_type: type,
    expires_at: type === 'permanent' ? null : new Date(Date.now() + 3 * 3600_000).toISOString(), created_by: owner.id, username: null,
  });
  if (insert.error) throw new Error(`room ${name}: ${codeOf(insert)}`);
  await owner.client.from('room_members').insert({ room_id: id, user_id: owner.id, role: 'owner', join_status: 'approved' });
  return id;
}

async function main() {
  const A = await signIn('A');
  const B = await signIn('B');
  const C = await makeUser('guest');
  const D = await makeUser('pending');
  const E = await makeUser('outsider');
  const anon = newClient();
  const tag = `qa-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  const roomName = `${tag} Conv  Room`;
  const R = await createRoom(A, roomName);
  const RIRR = await createRoom(A, `${tag}-irreversible`, { isPrivate: false, type: 'irreversible' });
  const RDEL = await createRoom(A, `${tag}-deleting`, { type: 'permanent' });
  const RENC = await createRoom(A, `${tag}-encrypted`);
  const rooms = [R, RIRR, RDEL, RENC];
  const channels = [];

  try {
    // Members: B approved, C guest through an invite, D pending, E outsider.
    await B.client.rpc('request_room_join', { p_identifier: R });
    await A.client.rpc('review_room_member', { p_room_id: R, p_target_user_id: B.id, p_action: 'approve', p_reason: '' });
    const guestInvite = await A.client.rpc('create_room_invite', { p_room_id: R, p_expires_at: null, p_max_uses: 5, p_guest_lifetime_minutes: 60 });
    const guestToken = guestInvite.data?.token ?? guestInvite.data?.[0]?.token;
    const guestJoin = guestToken ? await C.client.rpc('join_room_with_invite', { p_token: guestToken }) : { error: { code: 'noinvite' } };
    const plainInvite = await A.client.rpc('create_room_invite', { p_room_id: R, p_expires_at: null, p_max_uses: 5, p_guest_lifetime_minutes: null });
    const plainToken = plainInvite.data?.token ?? plainInvite.data?.[0]?.token;
    const pending = await D.client.rpc('request_room_join', { p_identifier: R });
    await A.client.from('messages').insert({ room_id: R, sender_id: A.id, content: 'history from the owner' });
    await B.client.from('messages').insert({ room_id: R, sender_id: B.id, content: 'history from a member' });
    await A.client.rpc('create_room_announcement', { p_room_id: R, p_body: 'kept announcement', p_is_pinned: false });
    const membersBefore = await service.from('room_members').select('user_id, role, join_status').eq('room_id', R);
    const roleOf = (userId) => membersBefore.data?.find((row) => row.user_id === userId);
    record('fixture: owner, approved member, guest and pending requester exist', roleOf(A.id)?.role === 'owner' && roleOf(B.id)?.join_status === 'approved' && roleOf(C.id)?.role === 'guest' && roleOf(D.id)?.join_status === 'pending', `guest=${codeOf(guestJoin)} pending=${codeOf(pending)}`);

    // One conversion event must be published in total.
    const events = [];
    const listener = B.client.channel(`sync:${R}`, { config: { private: true } })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_control_events', filter: `room_id=eq.${R}` }, (message) => events.push(message.new?.event_type))
      .subscribe();
    channels.push([B.client, listener]);
    await sleep(3500);

    // --- Who may convert -------------------------------------------------------
    const byMember = await B.client.rpc('convert_room_to_group', { p_room_id: R });
    const byGuest = await C.client.rpc('convert_room_to_group', { p_room_id: R });
    const byPending = await D.client.rpc('convert_room_to_group', { p_room_id: R });
    const byOutsider = await E.client.rpc('convert_room_to_group', { p_room_id: R });
    const byAnon = await anon.rpc('convert_room_to_group', { p_room_id: R });
    record('only the owner may convert: member, guest, pending, outsider and anon are refused', [byMember, byGuest, byPending, byOutsider].every((res) => res.error?.code === '42501') && Boolean(byAnon.error), `${codeOf(byMember)}/${codeOf(byGuest)}/${codeOf(byPending)}/${codeOf(byOutsider)}/${codeOf(byAnon)}`);
    const legacy = await A.client.rpc('convert_active_room_to_permanent', { p_room_id: R, p_username: 'legacyname' });
    record('the legacy permanent-room RPC (group username) is no longer callable', Boolean(legacy.error), codeOf(legacy));

    // --- Ineligible rooms ---------------------------------------------------------
    const irreversible = await A.client.rpc('convert_room_to_group', { p_room_id: RIRR });
    await A.client.rpc('schedule_room_deletion', { p_room_id: RDEL, p_grace_days: 7 });
    const deleting = await A.client.rpc('convert_room_to_group', { p_room_id: RDEL });
    const ineligibleGroups = await service.from('groups').select('id').in('source_room_id', [RIRR, RDEL]);
    record('irreversible and deletion-scheduled rooms are refused and stay unchanged', hintOf(irreversible) === 'irreversible' && hintOf(deleting) === 'deletion_scheduled' && rows(ineligibleGroups) === 0, `${hintOf(irreversible)}/${hintOf(deleting)} groups=${rows(ineligibleGroups)}`);

    // --- Concurrent double call ------------------------------------------------------
    const [first, second] = await Promise.all([
      A.client.rpc('convert_room_to_group', { p_room_id: R }),
      A.client.rpc('convert_room_to_group', { p_room_id: R }),
    ]);
    const outcomes = [first.data?.already_converted, second.data?.already_converted].sort();
    record('two simultaneous conversions create exactly one group and the same answer', !first.error && !second.error && first.data?.group_id === second.data?.group_id && outcomes[0] === false && outcomes[1] === true, `${codeOf(first)}/${codeOf(second)} ${outcomes.join(',')}`);
    const again = await A.client.rpc('convert_room_to_group', { p_room_id: R });
    record('a later retry returns the existing group', again.data?.already_converted === true && again.data?.group_id === first.data?.group_id);
    const groupId = first.data?.group_id;

    // --- What migrated ------------------------------------------------------------------
    const groupRows = await service.from('groups').select('id, name, source_room_id').eq('source_room_id', R);
    const groupMembers = await service.from('group_members').select('user_id, role').eq('group_id', groupId);
    const migrated = new Map((groupMembers.data ?? []).map((row) => [row.user_id, row.role]));
    record('exactly one group with the exact room name; owner and approved member migrate with roles; guest and pending do not', rows(groupRows) === 1 && groupRows.data?.[0]?.name === roomName && migrated.size === 2 && migrated.get(A.id) === 'owner' && migrated.get(B.id) === 'member' && !migrated.has(C.id) && !migrated.has(D.id), `members=${migrated.size}`);
    const conversion = await service.from('room_group_conversions').select('*').eq('room_id', R).single();
    record('the conversion record keeps counts, previous settings and what it resolved', conversion.data?.member_count === 2 && conversion.data?.content_refs?.messages >= 2 && conversion.data?.previous?.expiration_type === 'recoverable' && conversion.data?.resolved?.invites_revoked >= 2 && conversion.data?.resolved?.join_requests_rejected === 1, JSON.stringify(conversion.data?.resolved ?? {}));
    const roomAfter = await service.from('rooms').select('expiration_type, expires_at, username, is_private, is_group, name').eq('id', R).single();
    const settingsAfter = await service.from('room_control_settings').select('is_locked').eq('room_id', R).single();
    const invitesActive = await service.from('room_invites').select('id').eq('room_id', R).is('revoked_at', null);
    const pendingAfter = await service.from('room_members').select('join_status').eq('room_id', R).eq('user_id', D.id).single();
    record('the room is kept: permanent, private, locked, no username, invites revoked, pending request closed', roomAfter.data?.expiration_type === 'permanent' && roomAfter.data?.expires_at === null && roomAfter.data?.username === null && roomAfter.data?.is_private && roomAfter.data?.is_group && settingsAfter.data?.is_locked && rows(invitesActive) === 0 && pendingAfter.data?.join_status === 'rejected', `${roomAfter.data?.expiration_type}/${settingsAfter.data?.is_locked}/${rows(invitesActive)}`);
    const messagesKept = await service.from('messages').select('id').eq('room_id', R);
    const announcementsKept = await service.from('room_announcements').select('id').eq('room_id', R);
    const stillMembers = await service.from('room_members').select('user_id').eq('room_id', R).eq('join_status', 'approved');
    record('history, announcements and room membership are untouched', rows(messagesKept) === 2 && rows(announcementsKept) === 1 && rows(stillMembers) >= 3, `${rows(messagesKept)}/${rows(announcementsKept)}/${rows(stillMembers)}`);

    // --- Notices and the single event ------------------------------------------------------
    await sleep(2500);
    const noticesB = await service.from('room_notifications').select('id').eq('room_id', R).eq('notification_type', 'group_conversion').eq('recipient_id', B.id);
    const noticesOthers = await service.from('room_notifications').select('recipient_id').eq('room_id', R).eq('notification_type', 'group_conversion').neq('recipient_id', B.id);
    record('each migrated member (not the actor, not guests or requesters) gets exactly one notice', rows(noticesB) === 1 && rows(noticesOthers) === 0, `b=${rows(noticesB)} others=${rows(noticesOthers)}`);
    const conversionEvents = events.filter((type) => type === 'group_converted').length;
    const storedEvents = await service.from('room_control_events').select('id').eq('room_id', R).eq('event_type', 'group_converted');
    record('one conversion event is published (stored once; the member received it once)', rows(storedEvents) === 1 && conversionEvents === 1, `stored=${rows(storedEvents)} received=${conversionEvents}`);

    // --- Post-conversion RLS --------------------------------------------------------------------
    const bGroups = await B.client.from('groups').select('id');
    const bMembers = await B.client.from('group_members').select('user_id').eq('group_id', groupId);
    const bConversion = await B.client.from('room_group_conversions').select('id').eq('group_id', groupId);
    const aConversion = await A.client.from('room_group_conversions').select('id').eq('group_id', groupId);
    const bRoomGroup = await B.client.rpc('get_room_group', { p_room_id: R });
    record('members see their group and its member list; only managers see the conversion record', rows(bGroups) === 1 && rows(bMembers) === 2 && rows(bConversion) === 0 && rows(aConversion) === 1 && bRoomGroup.data?.group_id === groupId, `${rows(bGroups)}/${rows(bMembers)}/${rows(bConversion)}/${rows(aConversion)}`);
    const outsiderReads = await Promise.all([C, D, E].map((user) => user.client.from('groups').select('id')));
    const outsiderMembers = await E.client.from('group_members').select('user_id').eq('group_id', groupId);
    const outsiderRoomGroup = await E.client.rpc('get_room_group', { p_room_id: R });
    const anonRead = await anon.from('groups').select('id');
    record('guests, requesters, outsiders and anon see no group', outsiderReads.every((res) => rows(res) === 0) && rows(outsiderMembers) === 0 && outsiderRoomGroup.error?.code === '42501' && (Boolean(anonRead.error) || rows(anonRead) === 0), `${outsiderReads.map(rows).join(',')}/${codeOf(outsiderRoomGroup)}/${codeOf(anonRead)}`);
    const directGroup = await A.client.from('groups').insert({ name: 'x', source_room_id: RDEL });
    const directMember = await B.client.from('group_members').insert({ group_id: groupId, user_id: B.id, role: 'owner' });
    const directDelete = await A.client.from('groups').delete().eq('id', groupId);
    const stillThere = await service.from('groups').select('id').eq('id', groupId);
    record('groups can only be created or changed by the RPC (direct insert, role change and delete refused)', Boolean(directGroup.error) && Boolean(directMember.error) && rows(stillThere) === 1, `${codeOf(directGroup)}/${codeOf(directMember)}/${codeOf(directDelete)}`);

    // --- Closed room --------------------------------------------------------------------------------
    const joinAfter = await E.client.rpc('request_room_join', { p_identifier: R });
    const oldInvite = plainToken ? await E.client.rpc('join_room_with_invite', { p_token: plainToken }) : { error: { code: 'x' } };
    const outsiderMember = await service.from('room_members').select('user_id').eq('room_id', R).eq('user_id', E.id);
    record('nobody can join the converted room by request or by an old invite', rows(outsiderMember) === 0 && (Boolean(joinAfter.error) || joinAfter.data?.[0]?.status !== 'approved') && Boolean(oldInvite.error), `${codeOf(joinAfter)}/${codeOf(oldInvite)}`);
    const discover = await anon.rpc('discover_rooms', { p_query: tag, p_limit: 48 });
    record('a converted room is not discoverable', !(discover.data ?? []).some((row) => row.id === R));

    // --- Lifecycle can never delete it --------------------------------------------------------------------
    const schedule = await A.client.rpc('schedule_room_deletion', { p_room_id: R, p_grace_days: 7 });
    const due = await service.rpc('list_rooms_due_for_destruction', { p_limit: 500 });
    const dueIds = (due.data ?? []).map((row) => (typeof row === 'string' ? row : Object.values(row)[0]));
    const destroy = await service.rpc('destroy_expired_room', { p_room_id: R });
    const forced = await service.from('rooms').delete().eq('id', R);
    const roomStill = await service.from('rooms').select('id').eq('id', R);
    record('deletion cannot be scheduled, listed, destroyed or forced for a converted room', Boolean(schedule.error) && !dueIds.includes(R) && destroy.data === false && Boolean(forced.error) && rows(roomStill) === 1, `${codeOf(schedule)}/due=${dueIds.includes(R)}/destroy=${destroy.data}/force=${codeOf(forced)}`);

    // --- E2EE: gate on keys, ciphertext untouched ------------------------------------------------------------
    await B.client.rpc('request_room_join', { p_identifier: RENC });
    await A.client.rpc('review_room_member', { p_room_id: RENC, p_target_user_id: B.id, p_action: 'approve', p_reason: '' });
    await service.from('messages').insert([{ room_id: RENC, sender_id: A.id, ciphertext: 'Y2lwaGVy', iv: 'aXY=' }, { room_id: RENC, sender_id: B.id, ciphertext: 'Y2lwaGVyMg==', iv: 'aXY=' }]);
    const digest = async () => createHash('sha256').update(JSON.stringify((await service.from('messages').select('id, ciphertext, iv').eq('room_id', RENC).order('id')).data)).digest('hex');
    const keys = await service.from('profiles').select('id, public_key').in('id', [A.id, B.id]);
    const allKeys = (keys.data ?? []).length === 2 && keys.data.every((row) => row.public_key && row.public_key.trim() !== '');
    const before = await digest();
    const encrypted = await A.client.rpc('convert_room_to_group', { p_room_id: RENC });
    const after = await digest();
    const expectation = allKeys ? !encrypted.error : hintOf(encrypted) === 'e2ee_keys_missing';
    const encGroups = await service.from('groups').select('id').eq('source_room_id', RENC);
    record('an encrypted room converts only when every member has keys; ciphertext is byte-identical', expectation && before === after && rows(encGroups) === (allKeys ? 1 : 0), `keys=${allKeys} ${allKeys ? codeOf(encrypted) : hintOf(encrypted)}`);
  } finally {
    for (const [client, channel] of channels) await client.removeChannel(channel);
    await service.from('groups').delete().in('source_room_id', rooms);
    for (const roomId of rooms) await service.from('rooms').delete().eq('id', roomId).like('name', 'qa-%');
    for (const id of throwaway) await service.auth.admin.deleteUser(id);
  }

  const passed = results.filter(Boolean).length;
  console.log(`\nsummary: ${passed} pass, ${results.length - passed} fail`);
  process.exit(results.length === passed ? 0 : 1);
}

main().catch((error) => {
  console.error(`conversion probe aborted: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
});
