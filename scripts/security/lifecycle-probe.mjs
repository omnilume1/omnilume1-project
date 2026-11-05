// End-to-end lifecycle probe for Actions 04 and 06 (owner decisions,
// migration 20261105120000):
//   - minimum age 13 is enforced by the database for the account itself;
//   - an expired recoverable room is recoverable for 7 days, its content is
//     inaccessible while quarantined, and approval reopens it for 7 days;
//   - a pending recovery request keeps the room even past 7 days;
//   - a room past the window without a request is destroyed with all of its
//     database rows and storage objects (the same steps the cron route runs).
//
//   node scripts/security/lifecycle-probe.mjs
//
// Needs the two disposable QA accounts (OMNILUME_QA_{A,B}_{EMAIL,PASSWORD} or
// *_FILE, as for authorization-probe.mjs), the service-role key in
// .env.local (to verify deletion and to run the cron's per-room steps on the
// fixtures only), and a linked Supabase CLI. The CLI is used for exactly one
// thing: moving a qa-* fixture room's expiry 8 days into the past, which the
// validate_room_expiration trigger otherwise forbids. Only rooms this run
// created are touched; account A's date of birth is restored at the end.
// Output contains ids, status codes and pass/fail only.

import { createClient } from '@supabase/supabase-js';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..', '..');
const BUCKET = 'room_attachments';
const env = Object.fromEntries(readFileSync(resolve(projectRoot, '.env.local'), 'utf8')
  .split(/\r?\n/)
  .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
  .filter(Boolean)
  .map((match) => [match[1], match[2].replace(/^(['"])(.*)\1$/, '$2')]));
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !anonKey || !serviceKey) {
  console.error('NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are required in .env.local.');
  process.exit(2);
}
function secret(name) {
  if (process.env[name]) return process.env[name];
  const file = process.env[`${name}_FILE`];
  return file ? readFileSync(file, 'utf8').trim() : undefined;
}

const results = [];
const record = (test, check, pass, detail = '') => {
  results.push({ pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${test}  ${check}${detail ? `  [${detail}]` : ''}`);
};
const codeOf = (res) => (res?.error ? String(res.error.code ?? res.error.statusCode ?? res.error.name ?? 'error') : 'ok');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const service = createClient(url, serviceKey, options);

async function signIn(label) {
  const client = createClient(url, anonKey, options);
  const { data, error } = await client.auth.signInWithPassword({ email: secret(`OMNILUME_QA_${label}_EMAIL`), password: secret(`OMNILUME_QA_${label}_PASSWORD`) });
  if (error || !data.session) throw new Error(`Sign-in failed for account ${label}.`);
  return { client, id: data.user.id };
}

// The only privileged write: move this run's own qa-* fixture into the past.
function backdateFixture(roomId, days, { reopened = false } = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(roomId)) throw new Error('Invalid fixture id.');
  const dir = mkdtempSync(join(tmpdir(), 'omnilume-lifecycle-'));
  const file = join(dir, 'backdate.sql');
  writeFileSync(file, `BEGIN;
SET LOCAL session_replication_role = replica;
UPDATE public.rooms
SET expires_at = now() - interval '${Number(days)} days'${reopened ? `, reopened_until = now() - interval '${Number(days)} days'` : ''}
WHERE id = '${roomId}' AND name LIKE 'qa-%' AND expiration_type = 'recoverable';
COMMIT;
`);
  // One fixed command string (no user input): the file path comes from mkdtemp.
  const result = spawnSync(`npx supabase db query --linked -f "${file}"`, { cwd: projectRoot, shell: true, encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  if (result.status !== 0) throw new Error(`Backdating fixture failed (exit ${result.status}).`);
}

function runSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), 'omnilume-lifecycle-'));
  const file = join(dir, 'probe.sql');
  writeFileSync(file, sql);
  const result = spawnSync(`npx supabase db query --linked -f "${file}"`, { cwd: projectRoot, shell: true, encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

// Site-owner decisions on fixtures without the real owners: a rejection is
// written by the service role with audit fields (allowed by the request
// tamper trigger); approvals run in a rolled-back transaction instead.
async function serviceReject(requestId, reviewerId) {
  return service.from('recovery_requests').update({ status: 'rejected', reviewed_at: new Date().toISOString(), reviewed_by: reviewerId }).eq('id', requestId).eq('status', 'pending');
}

async function createRoom(owner, tag, suffix, expiresInMs) {
  const roomId = randomUUID();
  const room = await owner.client.from('rooms').insert({
    id: roomId,
    name: `${tag}-${suffix}`,
    description: 'Disposable lifecycle probe.',
    is_private: true,
    expiration_type: 'recoverable',
    expires_at: new Date(Date.now() + expiresInMs).toISOString(),
    created_by: owner.id,
    username: null,
  });
  if (room.error) throw new Error(`room fixture ${suffix}: ${codeOf(room)}`);
  const member = await owner.client.from('room_members').insert({ room_id: roomId, user_id: owner.id, role: 'owner', join_status: 'approved' });
  if (member.error) throw new Error(`owner membership ${suffix}: ${codeOf(member)}`);
  return roomId;
}

// Content in every kind of room-owned table, plus a storage object.
async function seedContent(owner, roomId) {
  const message = await owner.client.from('messages').insert({ room_id: roomId, sender_id: owner.id, content: 'qa lifecycle' });
  const note = await owner.client.rpc('create_study_note', { p_room_id: roomId, p_scope: 'room', p_title: 'qa', p_content: 'qa' });
  const board = await owner.client.rpc('save_room_whiteboard', { p_room_id: roomId, p_expected_version: 0, p_state: { v: 2, elements: [], legacyImage: null } });
  const path = `${roomId}/files/${randomUUID()}.pdf`;
  const body = new Blob(['%PDF-1.4\n%qa\n'], { type: 'application/pdf' });
  const upload = await owner.client.storage.from(BUCKET).upload(path, body, { contentType: 'application/pdf', upsert: false });
  const file = await owner.client.rpc('register_room_file', { p_room_id: roomId, p_object_path: path, p_original_name: 'qa.pdf', p_normalized_name: 'qa.pdf', p_mime_type: 'application/pdf', p_size_bytes: body.size, p_metadata: {} });
  const ok = [message, note, board, upload, file].every((res) => !res.error);
  return { ok, detail: [message, note, board, upload, file].map(codeOf).join('/'), path };
}

async function roomFootprint(roomId) {
  const counts = {};
  for (const table of ['rooms', 'room_members', 'messages', 'study_notes', 'room_whiteboards', 'room_files', 'recovery_requests', 'room_control_settings']) {
    const column = table === 'rooms' ? 'id' : 'room_id';
    const { count, error } = await service.from(table).select('*', { count: 'exact', head: true }).eq(column, roomId);
    counts[table] = error ? `err:${error.code}` : count;
  }
  const listing = await service.storage.from(BUCKET).list(`${roomId}/files`, { limit: 100 });
  counts.storage_files = listing.error ? `err` : (listing.data ?? []).filter((entry) => entry.id).length;
  return counts;
}

async function listDue() {
  const { data, error } = await service.rpc('list_rooms_due_for_destruction', { p_limit: 500 });
  if (error) throw new Error(`list_rooms_due_for_destruction: ${error.code}`);
  return (data ?? []).map((row) => (typeof row === 'string' ? row : row.list_rooms_due_for_destruction));
}

// The cron route's per-room steps (src/app/api/internal/cleanup-expired-rooms).
async function destroyLikeCron(roomId) {
  const folders = ['files', 'media', 'subtitles'];
  const paths = [];
  for (const folder of folders) {
    const { data } = await service.storage.from(BUCKET).list(`${roomId}/${folder}`, { limit: 1000 });
    paths.push(...(data ?? []).filter((entry) => entry.id).map((entry) => `${roomId}/${folder}/${entry.name}`));
  }
  if (paths.length) await service.storage.from(BUCKET).remove(paths);
  return service.rpc('destroy_expired_room', { p_room_id: roomId });
}

async function main() {
  const A = await signIn('A');
  const B = await signIn('B');
  if (A.id === B.id) throw new Error('Accounts A and B must differ.');

  // ---- A04: minimum age 13 for the account itself.
  const own = await A.client.from('profiles').select('date_of_birth').eq('id', A.id).single();
  const originalDob = own.data?.date_of_birth ?? null;
  try {
    const twelve = new Date();
    twelve.setUTCFullYear(twelve.getUTCFullYear() - 12);
    const young = await A.client.from('profiles').update({ date_of_birth: twelve.toISOString().slice(0, 10) }).eq('id', A.id).select('id');
    record('A04', 'database rejects an own date of birth under 13', Boolean(young.error) && young.error.code === '23514', codeOf(young));
    const thirteen = new Date();
    thirteen.setUTCFullYear(thirteen.getUTCFullYear() - 13);
    const ok = await A.client.from('profiles').update({ date_of_birth: thirteen.toISOString().slice(0, 10) }).eq('id', A.id).select('id');
    record('A04', 'database accepts a 13th birthday today', !ok.error && (ok.data ?? []).length === 1, codeOf(ok));
    const other = await B.client.from('profiles').update({ date_of_birth: '2000-01-01' }).eq('id', A.id).select('id');
    record('A04', 'another account cannot change A\'s date of birth', Boolean(other.error) || (other.data ?? []).length === 0, codeOf(other));
  } finally {
    const restore = await A.client.from('profiles').update({ date_of_birth: originalDob }).eq('id', A.id).select('id');
    record('A04', 'account A date of birth restored', !restore.error, codeOf(restore));
  }

  // ---- A06: recovery lifecycle on three fixtures that expire in ~70 s.
  const tag = `qa-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  console.log(`fixture tag ${tag}`);
  const W = await createRoom(A, tag, 'recover', 70_000);
  const P = await createRoom(A, tag, 'pending', 70_000);
  const D = await createRoom(A, tag, 'destroy', 70_000);
  console.log(`fixtures W=${W} P=${P} D=${D}`);
  for (const [label, roomId] of [['W', W], ['P', P], ['D', D]]) {
    const seeded = await seedContent(A, roomId);
    record('A06', `owner seeds messages, notes, whiteboard and a stored file in ${label}`, seeded.ok, seeded.detail);
  }
  const early = await A.client.from('recovery_requests').insert({ room_id: W, requester_id: A.id }).select('id');
  record('A06', 'no recovery request while the room is still active', Boolean(early.error) || (early.data ?? []).length === 0, codeOf(early));

  await sleep(75_000);

  const inWindow = await A.client.rpc('room_in_recovery_window', { p_room_id: W });
  record('A06', 'expired recoverable room enters the recovery window', !inWindow.error && inWindow.data === true, codeOf(inWindow));
  const quarantined = await A.client.from('messages').select('id').eq('room_id', W);
  record('A06', 'room content is inaccessible while quarantined', !quarantined.error && (quarantined.data ?? []).length === 0, `${codeOf(quarantined)} rows=${(quarantined.data ?? []).length}`);
  const outsider = await B.client.from('recovery_requests').insert({ room_id: W, requester_id: B.id }).select('id');
  record('A06', 'a non-member cannot request recovery', Boolean(outsider.error) || (outsider.data ?? []).length === 0, codeOf(outsider));
  const request = await A.client.from('recovery_requests').insert({ room_id: W, requester_id: A.id }).select('id, status').single();
  record('A06', 'owner requests recovery inside the window', !request.error && request.data?.status === 'pending', codeOf(request));
  const outsiderReview = request.data?.id ? await B.client.rpc('review_recovery_request', { p_request_id: request.data.id, p_decision: 'approved' }) : { error: { code: 'no_request' } };
  record('A06', 'a non-member cannot approve the request', Boolean(outsiderReview.error), codeOf(outsiderReview));
  const ownerApprove = request.data?.id ? await A.client.rpc('review_recovery_request', { p_request_id: request.data.id, p_decision: 'approved' }) : { error: { code: 'no_request' } };
  record('A06', 'the room owner can no longer approve (site owners only)', Boolean(ownerApprove.error) && ownerApprove.error.code === '42501', codeOf(ownerApprove));
  // Site-owner approval in a rolled-back transaction (QA account A is made a
  // site owner only inside it): 7-day reopen and restored content access.
  if (!/^[0-9a-f-]{36}$/i.test(request.data?.id ?? '') || !/^[0-9a-f-]{36}$/i.test(A.id) || !/^[0-9a-f-]{36}$/i.test(W)) throw new Error('bad id');
  const txnOutput = runSql(`DO $t$
DECLARE r text := ''; v text; n integer;
BEGIN
  INSERT INTO public.site_owners (user_id) VALUES ('${A.id}');
  PERFORM set_config('request.jwt.claims', json_build_object('sub', '${A.id}', 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT status INTO v FROM public.review_recovery_request('${request.data.id}', 'approved'); r := r || 'approve=' || v || ';';
  SELECT round(extract(epoch FROM (reopened_until - now())) / 86400.0, 3)::text INTO v FROM public.rooms WHERE id = '${W}'; r := r || 'days=' || COALESCE(v, 'none') || ';';
  SELECT count(*) INTO n FROM public.messages WHERE room_id = '${W}'; r := r || 'messages=' || n || ';';
  RAISE EXCEPTION 'TXN_RESULT %', r;
END
$t$;
`).replace(/\\+"/g, '"');
  const txn = Object.fromEntries((txnOutput.match(/TXN_RESULT ([^"\\]*)/)?.[1] ?? '').split(';').filter(Boolean).map((pair) => pair.split('=')));
  const reopenDays = Number(txn.days);
  record('A06', 'site-owner approval reopens the room for 7 days', txn.approve === 'approved' && reopenDays > 6.99 && reopenDays <= 7.01, `approve=${txn.approve} days=${txn.days}`);
  record('A06', 'content is back after reopening', Number(txn.messages) >= 1, `messages=${txn.messages}`);

  const pendingRequest = await A.client.from('recovery_requests').insert({ room_id: P, requester_id: A.id }).select('id, status').single();
  record('A06', 'owner requests recovery for P', !pendingRequest.error, codeOf(pendingRequest));
  const notDueYet = (await listDue()).includes(D);
  record('A06', 'a room inside its 7-day window is not due for destruction', !notDueYet);
  const earlyDestroy = await service.rpc('destroy_expired_room', { p_room_id: D });
  record('A06', 'destroy_expired_room refuses a room inside its window', !earlyDestroy.error && earlyDestroy.data === false, codeOf(earlyDestroy));

  backdateFixture(P, 8);
  backdateFixture(D, 8);
  const due = await listDue();
  record('A06', 'a pending request keeps a room past 7 days', !due.includes(P));
  const heldDestroy = await service.rpc('destroy_expired_room', { p_room_id: P });
  record('A06', 'destroy_expired_room refuses a room held by a pending request', !heldDestroy.error && heldDestroy.data === false, codeOf(heldDestroy));
  record('A06', 'a room 8 days past expiry without a request is due', due.includes(D));

  const before = await roomFootprint(D);
  const destroyed = await destroyLikeCron(D);
  const after = await roomFootprint(D);
  const allGone = Object.values(after).every((value) => value === 0);
  record('A06', 'cleanup deletes the room with every row and stored file', !destroyed.error && destroyed.data === true && allGone, `${codeOf(destroyed)} before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);

  // Rejecting P's request ends the hold; the room is then destroyed too.
  const reject = pendingRequest.data?.id ? await serviceReject(pendingRequest.data.id, A.id) : { error: { code: 'no_request' } };
  const dueAfterReject = (await listDue()).includes(P);
  record('A06', 'after the request is rejected the held room becomes due', !reject.error && dueAfterReject, codeOf(reject));
  const destroyedP = await destroyLikeCron(P);
  const afterP = await roomFootprint(P);
  record('A06', 'the rejected room is deleted with all of its data', !destroyedP.error && destroyedP.data === true && Object.values(afterP).every((value) => value === 0), `${codeOf(destroyedP)} after=${JSON.stringify(afterP)}`);

  // Leave nothing behind: W is still held by its (rolled-back, so pending)
  // request; answer it, end its window and destroy it the same way.
  if (request.data?.id) await serviceReject(request.data.id, A.id);
  backdateFixture(W, 8);
  const destroyedW = await destroyLikeCron(W);
  const afterW = await roomFootprint(W);
  record('A06', 'fixture W cleaned up', !destroyedW.error && destroyedW.data === true && Object.values(afterW).every((value) => value === 0), codeOf(destroyedW));

  const passed = results.filter((result) => result.pass).length;
  const failed = results.length - passed;
  console.log(`\nsummary: ${passed} pass, ${failed} fail`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`lifecycle probe aborted: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
});
