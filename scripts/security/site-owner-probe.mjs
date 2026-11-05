// Site-owner recovery and §9 lifecycle probe (Action 06 completion,
// migrations 20261105130000 and 20261105140000).
//
//   node scripts/security/site-owner-probe.mjs
//
// Uses the two disposable QA accounts (OMNILUME_QA_{A,B}_{EMAIL,PASSWORD} or
// *_FILE), the service-role key in .env.local (to verify rows and run the
// cron's per-room steps on fixtures only) and the linked Supabase CLI for:
//   - moving this run's own qa-* fixtures back in time, and
//   - the site-owner positive test, which inserts QA account A into
//     site_owners inside a transaction that is always rolled back. The real
//     site owners' accounts are never used.
// Output: ids, status codes and pass/fail only.

import { createClient } from '@supabase/supabase-js';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..', '..');
const env = Object.fromEntries(readFileSync(resolve(projectRoot, '.env.local'), 'utf8')
  .split(/\r?\n/)
  .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
  .filter(Boolean)
  .map((match) => [match[1], match[2].replace(/^(['"])(.*)\1$/, '$2')]));
const secret = (name) => process.env[name] ?? (process.env[`${name}_FILE`] ? readFileSync(process.env[`${name}_FILE`], 'utf8').trim() : undefined);
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, options);
const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, options);

const results = [];
const record = (test, check, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${test}  ${check}${detail ? `  [${detail}]` : ''}`);
};
const codeOf = (res) => (res?.error ? String(res.error.code ?? res.error.statusCode ?? 'error') : 'ok');
const one = (res) => (Array.isArray(res?.data) ? res.data[0] : res?.data);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const denied = (res) => Boolean(res.error) && ['42501', 'P0001'].includes(String(res.error.code));

async function signIn(label) {
  const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, options);
  const { data, error } = await client.auth.signInWithPassword({ email: secret(`OMNILUME_QA_${label}_EMAIL`), password: secret(`OMNILUME_QA_${label}_PASSWORD`) });
  if (error || !data.session) throw new Error(`Sign-in failed for account ${label}.`);
  return { client, id: data.user.id };
}

function runSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), 'omnilume-site-owner-'));
  const file = join(dir, 'probe.sql');
  writeFileSync(file, sql);
  // One fixed command string; the file path comes from mkdtemp.
  const result = spawnSync(`npx supabase db query --linked -f "${file}"`, { cwd: projectRoot, shell: true, encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

const uuidOnly = (value) => { if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error('bad id'); return value; };

function backdate(roomId, days, column = 'expires_at') {
  if (!['expires_at', 'deletion_scheduled_at'].includes(column)) throw new Error('bad column');
  const output = runSql(`BEGIN;
SET LOCAL session_replication_role = replica;
UPDATE public.rooms SET ${column} = now() - interval '${Number(days)} days'
WHERE id = '${uuidOnly(roomId)}' AND name LIKE 'qa-%';
COMMIT;
`);
  if (/ERROR/.test(output)) throw new Error('backdate failed');
}

async function createRoom(owner, tag, suffix, type, expiresInMs) {
  const id = randomUUID();
  const insert = await owner.client.from('rooms').insert({
    id, name: `${tag}-${suffix}`, description: 'Disposable site-owner probe.', is_private: true,
    expiration_type: type, expires_at: type === 'permanent' ? null : new Date(Date.now() + expiresInMs).toISOString(),
    created_by: owner.id, username: null,
  });
  if (insert.error) throw new Error(`room ${suffix}: ${codeOf(insert)}`);
  const member = await owner.client.from('room_members').insert({ room_id: id, user_id: owner.id, role: 'owner', join_status: 'approved' });
  if (member.error) throw new Error(`owner member ${suffix}: ${codeOf(member)}`);
  return id;
}

async function addMember(owner, member, roomId, role) {
  const join = await member.client.rpc('request_room_join', { p_identifier: roomId });
  const approve = await owner.client.rpc('review_room_member', { p_room_id: roomId, p_target_user_id: member.id, p_action: 'approve', p_reason: '' });
  const promote = role === 'admin' ? await owner.client.rpc('set_room_member_role', { p_room_id: roomId, p_target_user_id: member.id, p_role: 'admin' }) : { error: null };
  if (join.error || approve.error || promote.error) throw new Error(`membership ${roomId}: ${codeOf(join)}/${codeOf(approve)}/${codeOf(promote)}`);
}

async function destroyLikeCron(roomId) {
  const paths = [];
  for (const folder of ['files', 'media', 'subtitles']) {
    const { data } = await service.storage.from('room_attachments').list(`${roomId}/${folder}`, { limit: 1000 });
    paths.push(...(data ?? []).filter((entry) => entry.id).map((entry) => `${roomId}/${folder}/${entry.name}`));
  }
  if (paths.length) await service.storage.from('room_attachments').remove(paths);
  return service.rpc('destroy_expired_room', { p_room_id: roomId });
}

async function main() {
  const A = await signIn('A');
  const B = await signIn('B');
  const tag = `qa-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  console.log(`fixture tag ${tag}`);

  const RM = await createRoom(A, tag, 'member-room', 'recoverable', 75_000);
  const RA = await createRoom(A, tag, 'admin-room', 'recoverable', 75_000);
  const RI = await createRoom(A, tag, 'irreversible-room', 'irreversible', 75_000);
  const P = await createRoom(A, tag, 'permanent-room', 'permanent', 0);
  const P2 = await createRoom(A, tag, 'invite-room', 'permanent', 0);
  await addMember(A, B, RM, 'member');
  await addMember(A, B, RA, 'admin');
  await addMember(A, B, RI, 'member');
  await addMember(A, B, P, 'member');
  console.log(`fixtures RM=${RM} RA=${RA} RI=${RI} P=${P} P2=${P2}`);

  // ---- §9 invite preview (shown before joining).
  const invite = await A.client.rpc('create_room_invite', { p_room_id: P2, p_expires_at: null, p_max_uses: null, p_guest_lifetime_minutes: null });
  const token = (one(invite)?.token ?? one(invite)) || null;
  const preview = typeof token === 'string' ? await B.client.rpc('get_room_invite_preview', { p_token: token }) : { error: { code: 'no_token' } };
  const previewRow = one(preview);
  record('A06', 'invite preview shows the room and its deletion policy to an invitee', !preview.error && previewRow?.room_id === P2 && previewRow?.expiration_type === 'permanent', codeOf(preview));
  const badPreview = await B.client.rpc('get_room_invite_preview', { p_token: 'f'.repeat(48) });
  record('A06', 'invite preview returns nothing for an invalid token', !badPreview.error && (badPreview.data ?? []).length === 0, codeOf(badPreview));
  const anonPreview = await anon.rpc('get_room_invite_preview', { p_token: 'f'.repeat(48) });
  record('A06', 'anon cannot call the invite preview', denied(anonPreview), codeOf(anonPreview));

  // ---- §9 permanent-room scheduled deletion.
  const memberSchedule = await B.client.rpc('schedule_room_deletion', { p_room_id: P, p_grace_days: 7 });
  record('A06', 'a member cannot schedule deletion', denied(memberSchedule), codeOf(memberSchedule));
  const shortGrace = await A.client.rpc('schedule_room_deletion', { p_room_id: P, p_grace_days: 3 });
  record('A06', 'grace periods under 7 days are rejected', Boolean(shortGrace.error), codeOf(shortGrace));
  const longGrace = await A.client.rpc('schedule_room_deletion', { p_room_id: P, p_grace_days: 30 });
  record('A06', 'grace periods over 14 days are rejected', Boolean(longGrace.error), codeOf(longGrace));
  const scheduled = await A.client.rpc('schedule_room_deletion', { p_room_id: P, p_grace_days: 7 });
  const scheduledDays = scheduled.data ? (Date.parse(scheduled.data) - Date.now()) / 86_400_000 : 0;
  record('A06', 'the owner schedules deletion with a 7-day grace period', !scheduled.error && scheduledDays > 6.99 && scheduledDays <= 7.01, `${codeOf(scheduled)} days=${scheduledDays.toFixed(3)}`);
  const memberNotice = await B.client.from('room_notifications').select('id, notification_type').eq('room_id', P).eq('notification_type', 'room_deletion');
  record('A06', 'members are notified of the scheduled deletion', !memberNotice.error && (memberNotice.data ?? []).length === 1, `${codeOf(memberNotice)} n=${(memberNotice.data ?? []).length}`);
  const directClear = await A.client.from('rooms').update({ deletion_scheduled_at: null }).eq('id', P).select('id');
  record('A06', 'the deletion date cannot be changed directly (trigger)', Boolean(directClear.error), codeOf(directClear));
  const memberCancel = await B.client.rpc('cancel_room_deletion', { p_room_id: P });
  record('A06', 'a member cannot cancel deletion', denied(memberCancel), codeOf(memberCancel));
  const ownerCancel = await A.client.rpc('cancel_room_deletion', { p_room_id: P });
  record('A06', 'the owner cancels during the grace period', !ownerCancel.error, codeOf(ownerCancel));
  const cancelNotice = await B.client.from('room_notifications').select('id').eq('room_id', P).eq('notification_type', 'room_deletion');
  record('A06', 'members are notified of the cancellation', (cancelNotice.data ?? []).length === 2, `n=${(cancelNotice.data ?? []).length}`);
  const cancelTwice = await A.client.rpc('cancel_room_deletion', { p_room_id: P });
  record('A06', 'cancelling with nothing scheduled is rejected', Boolean(cancelTwice.error), codeOf(cancelTwice));
  const rescheduled = await A.client.rpc('schedule_room_deletion', { p_room_id: P, p_grace_days: 14 });
  record('A06', 'the owner can schedule again (14 days)', !rescheduled.error, codeOf(rescheduled));
  backdate(P, 1, 'deletion_scheduled_at');
  const dueList = await service.rpc('list_rooms_due_for_destruction', { p_limit: 500 });
  const dueIds = (dueList.data ?? []).map((row) => (typeof row === 'string' ? row : row.list_rooms_due_for_destruction));
  record('A06', 'after the grace period the permanent room is due for destruction', dueIds.includes(P));
  const destroyedP = await destroyLikeCron(P);
  const pLeft = await service.from('rooms').select('id', { count: 'exact', head: true }).eq('id', P);
  record('A06', 'cleanup deletes the permanent room after its grace period', !destroyedP.error && destroyedP.data === true && pLeft.count === 0, codeOf(destroyedP));

  // ---- Recovery requests (any member, inside the window, once).
  await sleep(80_000);
  const bMember = await B.client.from('recovery_requests').insert({ room_id: RM, requester_id: B.id }).select('id, status').single();
  record('A06', 'a normal member requests recovery', !bMember.error && bMember.data?.status === 'pending', codeOf(bMember));
  const bAgain = await B.client.from('recovery_requests').insert({ room_id: RM, requester_id: B.id }).select('id');
  record('A06', 'one pending request per user per room', Boolean(bAgain.error) && bAgain.error.code === '23505', codeOf(bAgain));
  const bAdmin = await B.client.from('recovery_requests').insert({ room_id: RA, requester_id: B.id }).select('id, status').single();
  record('A06', 'a room admin requests recovery', !bAdmin.error, codeOf(bAdmin));
  const aOwner = await A.client.from('recovery_requests').insert({ room_id: RM, requester_id: A.id }).select('id, status').single();
  record('A06', 'the room owner requests recovery', !aOwner.error, codeOf(aOwner));
  const irreversible = await B.client.from('recovery_requests').insert({ room_id: RI, requester_id: B.id }).select('id');
  record('A06', 'irreversible rooms cannot be recovered (request denied)', Boolean(irreversible.error), codeOf(irreversible));
  const forged = await B.client.from('recovery_requests').insert({ room_id: RA, requester_id: A.id }).select('id');
  record('A06', 'a member cannot file a request in someone else\'s name', Boolean(forged.error), codeOf(forged));

  const ownerView = await A.client.from('recovery_requests').select('id, requester_id').eq('room_id', RM);
  record('A06', 'the room owner sees only their own request, not other members\'', !ownerView.error && (ownerView.data ?? []).length === 1 && ownerView.data[0].requester_id === A.id, `n=${(ownerView.data ?? []).length}`);
  const siteOwnerNotices = bMember.data?.id
    ? await service.from('room_notifications').select('id', { count: 'exact', head: true }).eq('dedupe_key', `recovery_request:${bMember.data.id}`).eq('notification_type', 'recovery_request')
    : { count: 0 };
  record('A06', 'every site owner is notified of a new request', siteOwnerNotices.count === 2, `n=${siteOwnerNotices.count}`);

  // ---- Review: denied for everyone but site owners.
  const memberReview = await B.client.rpc('review_recovery_request', { p_request_id: bMember.data?.id, p_decision: 'approved' });
  record('A06', 'a normal member cannot review', denied(memberReview), codeOf(memberReview));
  const adminReview = await B.client.rpc('review_recovery_request', { p_request_id: bAdmin.data?.id, p_decision: 'approved' });
  record('A06', 'a room admin cannot review', denied(adminReview), codeOf(adminReview));
  const ownerReview = await A.client.rpc('review_recovery_request', { p_request_id: bMember.data?.id, p_decision: 'approved' });
  record('A06', 'the room owner cannot review', denied(ownerReview), codeOf(ownerReview));
  const anonReview = await anon.rpc('review_recovery_request', { p_request_id: bMember.data?.id, p_decision: 'approved' });
  record('A06', 'anon cannot review', denied(anonReview), codeOf(anonReview));
  const queueAsOwner = await A.client.rpc('list_recovery_review_queue');
  record('A06', 'the review queue is denied to non site owners', denied(queueAsOwner), codeOf(queueAsOwner));
  const ownerRow = await A.client.from('site_owners').select('user_id');
  record('A06', 'site_owners reveals no rows to a non site owner', !ownerRow.error && (ownerRow.data ?? []).length === 0, codeOf(ownerRow));
  const selfInsert = await A.client.from('site_owners').insert({ user_id: A.id });
  record('A06', 'a user cannot make themselves a site owner', Boolean(selfInsert.error), codeOf(selfInsert));

  // ---- Site owner (QA account A inserted into site_owners in a rolled-back
  // transaction): approve, auto-answer, double review, non-pending, after window.
  const clean = (expr) => `regexp_replace(left(${expr}, 70), '[^A-Za-z0-9 _.:-]', '', 'g')`;
  const txn = `DO $t$
DECLARE
  r text := '';
  v text;
  n integer;
BEGIN
  INSERT INTO public.site_owners (user_id) VALUES ('${uuidOnly(A.id)}');
  PERFORM set_config('request.jwt.claims', json_build_object('sub', '${uuidOnly(A.id)}', 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN SELECT count(*) INTO n FROM public.list_recovery_review_queue() q WHERE q.room_id IN ('${uuidOnly(RM)}', '${uuidOnly(RA)}'); r := r || 'queue=' || n || ';';
  EXCEPTION WHEN others THEN r := r || 'queue=ERR ' || ${clean('SQLERRM')} || ';'; END;
  BEGIN SELECT status INTO v FROM public.review_recovery_request('${uuidOnly(bMember.data?.id ?? randomUUID())}', 'approved'); r := r || 'approve=' || v || ';';
  EXCEPTION WHEN others THEN r := r || 'approve=ERR ' || ${clean('SQLERRM')} || ';'; END;
  SELECT status INTO v FROM public.recovery_requests WHERE id = '${uuidOnly(aOwner.data?.id ?? randomUUID())}'; r := r || 'sibling=' || COALESCE(v, 'none') || ';';
  SELECT CASE WHEN reopened_until > now() + interval '6 days 23 hours' THEN 'reopened7d' ELSE 'not_reopened' END INTO v FROM public.rooms WHERE id = '${uuidOnly(RM)}'; r := r || 'room=' || COALESCE(v, 'none') || ';';
  BEGIN PERFORM public.review_recovery_request('${uuidOnly(bMember.data?.id ?? randomUUID())}', 'rejected'); r := r || 'double=ALLOWED;';
  EXCEPTION WHEN others THEN r := r || 'double=denied;'; END;
  BEGIN PERFORM public.review_recovery_request('${randomUUID()}', 'approved'); r := r || 'missing=ALLOWED;';
  EXCEPTION WHEN others THEN r := r || 'missing=denied;'; END;
  BEGIN SELECT status INTO v FROM public.review_recovery_request('${uuidOnly(bAdmin.data?.id ?? randomUUID())}', 'rejected'); r := r || 'reject=' || v || ';';
  EXCEPTION WHEN others THEN r := r || 'reject=ERR ' || ${clean('SQLERRM')} || ';'; END;
  EXECUTE 'RESET ROLE';
  SELECT count(*) INTO n FROM public.room_notifications WHERE dedupe_key = 'recovery_decision:${uuidOnly(bMember.data?.id ?? randomUUID())}' AND recipient_id = '${uuidOnly(B.id)}'; r := r || 'decision_notice=' || n || ';';
  EXECUTE 'SET LOCAL session_replication_role = replica';
  UPDATE public.rooms SET expires_at = now() - interval '8 days' WHERE id = '${uuidOnly(RA)}';
  EXECUTE 'SET LOCAL session_replication_role = origin';
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT public.room_lifecycle_state('${uuidOnly(RA)}') INTO v; r := r || 'after_window_state=' || v || ';';
  BEGIN PERFORM public.review_recovery_request('${uuidOnly(bAdmin.data?.id ?? randomUUID())}', 'approved'); r := r || 'after_window_review=ALLOWED;';
  EXCEPTION WHEN others THEN r := r || 'after_window_review=denied;'; END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', '${uuidOnly(B.id)}', 'role', 'authenticated')::text, true);
  BEGIN INSERT INTO public.recovery_requests (room_id, requester_id) VALUES ('${uuidOnly(RA)}', '${uuidOnly(B.id)}'); r := r || 'after_window_request=ALLOWED;';
  EXCEPTION WHEN others THEN r := r || 'after_window_request=denied;'; END;
  RAISE EXCEPTION 'TXN_RESULT %', r;
END
$t$;
`;
  const txnOutput = runSql(txn).replace(/\\+"/g, '"');
  const txnResult = Object.fromEntries((txnOutput.match(/TXN_RESULT ([^"\\]*)/)?.[1] ?? '').split(';').filter(Boolean).map((pair) => pair.split('=')));
  record('A06', 'site owner sees all three fixture requests in the review queue', txnResult.queue === '3', `queue=${txnResult.queue}`);
  record('A06', 'site owner approves a pending request', txnResult.approve === 'approved', `approve=${txnResult.approve}`);
  record('A06', 'approval answers the other pending request for that room', txnResult.sibling === 'approved', `sibling=${txnResult.sibling}`);
  record('A06', 'approval reopens the room for 7 days', txnResult.room === 'reopened7d', `room=${txnResult.room}`);
  record('A06', 'the requester is notified of the decision', txnResult.decision_notice === '1', `notice=${txnResult.decision_notice}`);
  record('A06', 'a reviewed request cannot be reviewed again', txnResult.double === 'denied', `double=${txnResult.double}`);
  record('A06', 'reviewing a missing request fails', txnResult.missing === 'denied', `missing=${txnResult.missing}`);
  record('A06', 'site owner rejects a request', txnResult.reject === 'rejected', `reject=${txnResult.reject}`);
  record('A06', 'past the window with nothing pending the room is destroyed', txnResult.after_window_state === 'destroyed', `state=${txnResult.after_window_state}`);
  record('A06', 'no review after the window', txnResult.after_window_review === 'denied', `review=${txnResult.after_window_review}`);
  record('A06', 'no new request after the window', txnResult.after_window_request === 'denied', `request=${txnResult.after_window_request}`);
  const persisted = await service.from('site_owners').select('user_id', { count: 'exact', head: true }).eq('user_id', A.id);
  const stillPending = await service.from('recovery_requests').select('status').eq('id', bMember.data?.id).single();
  record('A06', 'the transaction rolled back (no site-owner row, request still pending)', persisted.count === 0 && stillPending.data?.status === 'pending', `site_owner_rows=${persisted.count} status=${stillPending.data?.status}`);

  // ---- Leave nothing behind: delete this run's fixture rooms (cascades).
  for (const roomId of [RM, RA, RI, P2]) {
    const deletion = await service.from('rooms').delete().eq('id', roomId).like('name', 'qa-%');
    if (deletion.error) console.log(`cleanup ${roomId}: ${codeOf(deletion)}`);
  }

  const passed = results.filter(Boolean).length;
  console.log(`\nsummary: ${passed} pass, ${results.length - passed} fail`);
  process.exit(results.length === passed ? 0 : 1);
}

main().catch((error) => {
  console.error(`site-owner probe aborted: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
});
