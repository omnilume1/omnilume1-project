import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { notificationPresentation } from '../src/lib/notification-center-model.js';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
const sql = read('supabase/migrations/20261108110000_action14_room_group_conversion.sql');
const code = (text: string) => text.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
const fn = (name: string) => {
  const start = sql.indexOf(`FUNCTION public.${name}(`);
  assert.ok(start >= 0, name);
  const ends = ['\n$$;', '\n$function$;'].map((end) => sql.indexOf(end, start)).filter((index) => index > 0);
  return code(sql.slice(start, Math.min(...ends)));
};

test('group tables: RLS, select-only grants, no username or link, source room restricted', () => {
  for (const table of ['groups', 'group_members', 'room_group_conversions']) {
    assert.match(sql, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`), table);
  }
  assert.match(sql, /REVOKE ALL ON TABLE public\.groups, public\.group_members, public\.room_group_conversions FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT SELECT ON TABLE public\.groups, public\.group_members, public\.room_group_conversions TO authenticated/);
  assert.ok(!/GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*TO (anon|authenticated)/i.test(code(sql)), 'no direct write grants');
  const groups = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS public.groups'), sql.indexOf('CREATE TABLE IF NOT EXISTS public.group_members'));
  assert.ok(!/username|link|slug|invite/i.test(code(groups)), 'a group has no public username or link');
  assert.match(groups, /source_room_id uuid NOT NULL UNIQUE REFERENCES public\.rooms\(id\) ON DELETE RESTRICT/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS group_members_one_owner/);
  assert.match(sql, /room_id uuid NOT NULL UNIQUE REFERENCES public\.rooms\(id\) ON DELETE RESTRICT/);
});

test('policy helpers are executable by authenticated and answer only about the caller', () => {
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.is_group_member\(uuid, uuid\), public\.is_group_manager\(uuid, uuid\) TO authenticated/);
  assert.match(sql, /p_user_id = auth\.uid\(\)/);
});

test('convert_room_to_group is one definer transaction: locked, owner-only, idempotent, audited', () => {
  const body = fn('convert_room_to_group');
  assert.match(sql.slice(sql.indexOf('FUNCTION public.convert_room_to_group('), sql.indexOf('FUNCTION public.convert_room_to_group(') + 300), /SECURITY DEFINER\s+SET search_path = ''/);
  assert.match(body, /FROM public\.rooms r WHERE r\.id = p_room_id FOR UPDATE/, 'row lock serialises double clicks');
  assert.match(body, /room_user_role\(p_room_id, v_uid\) IS DISTINCT FROM 'owner'/);
  assert.match(body, /already_converted', true/);
  // Idempotent return happens before any write.
  assert.ok(body.indexOf("'already_converted', true") < body.indexOf('INSERT INTO public.groups'));
  // Eligibility is decided before the first write.
  for (const hint of ['not_active', 'irreversible', 'deletion_scheduled', 'owner_invalid', 'e2ee_keys_missing']) {
    assert.ok(body.includes(`HINT = '${hint}'`), hint);
    assert.ok(body.indexOf(`HINT = '${hint}'`) < body.indexOf('INSERT INTO public.groups'), hint);
  }
  assert.match(body, /v_room\.name, ?\s*p_room_id|VALUES \(v_room\.name, v_uid, p_room_id\)/, 'exact room name');
  assert.match(body, /guest_expires_at IS NULL/);
  assert.match(body, /NOT public\.room_user_is_restricted/);
  assert.match(body, /INSERT INTO public\.room_group_conversions/);
  assert.match(body, /record_room_control_event\(p_room_id, 'group_converted'/);
  assert.match(body, /enqueue_room_notification\(/);
  assert.match(body, /'group_conversion:' \|\| p_room_id::text/, 'one deduplicated notice per member');
  assert.ok(!/DELETE FROM public\.(rooms|messages|room_files|study_notes)\b/.test(body), 'never deletes the room or its content');
  assert.ok(!/UPDATE public\.messages|ciphertext\s*=/.test(body), 'never writes messages or ciphertext');
  assert.ok(!/username\s*=\s*[^N]/.test(body.replace(/username = NULL/g, '')), 'no username is claimed');
});

test('conversion settles lifecycle leftovers and closes the room', () => {
  const body = fn('convert_room_to_group');
  for (const fragment of ['UPDATE public.room_invites SET revoked_at', "SET join_status = 'rejected'", 'DELETE FROM public.recovery_requests', 'UPDATE public.room_permanent_requests', 'DELETE FROM public.room_cleanup_jobs', "expiration_type = 'permanent'", 'username = NULL', 'is_private = true', 'is_locked = true']) {
    assert.ok(body.includes(fragment), fragment);
  }
});

test('cleanup can never select, schedule or destroy a converted room', () => {
  const marker = 'SELECT 1 FROM public.groups g WHERE g.source_room_id';
  for (const name of ['destroy_expired_room', 'schedule_room_deletion']) assert.ok(fn(name).includes(marker), name);
  assert.match(fn('list_rooms_due_for_destruction'), /NOT EXISTS \(SELECT 1 FROM public\.groups g WHERE g\.source_room_id = r\.id\)/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.convert_active_room_to_permanent\(uuid, text\) FROM PUBLIC, anon, authenticated/);
  // The storage cleanup removes files before destroying, so the list must be the guard.
  const cleanup = read('src/lib/room-cleanup.ts');
  assert.ok(cleanup.indexOf("rpc('list_rooms_due_for_destruction'") < cleanup.indexOf('removeStorageFiles(supabase, storagePaths)'));
});

test('account deletion hands a group to the replacement owner and removes a sole owner\'s group first', () => {
  const body = fn('prepare_account_deletion');
  assert.ok(body.includes("UPDATE public.group_members SET role = 'admin'"));
  assert.ok(body.indexOf("SET role = 'admin'") < body.indexOf("VALUES (v_group, replacement_user, 'owner')"), 'old owner is demoted before the new one is promoted');
  assert.ok(body.indexOf('DELETE FROM public.groups WHERE id = v_group') < body.indexOf('DELETE FROM public.rooms WHERE id = room_row.id'));
});

test('server action: no username, errors as values, only known RPC sentences are shown', () => {
  const action = read('src/actions/rooms.ts');
  const impl = action.slice(action.indexOf('async function convertRoomToGroupImpl'), action.indexOf('export async function convertRoomToGroup'));
  assert.ok(!/username/i.test(impl.replace(/or custom link/gi, '')), 'no group username parameter');
  assert.match(impl, /supabase\.rpc\('convert_room_to_group'/);
  assert.ok(!impl.includes('convert_active_room_to_permanent'));
  assert.match(impl, /CONVERSION_ERRORS\.has\(error\.hint/);
  assert.match(action, /export async function convertRoomToGroup\(roomId: string\) \{\s+return actionResult\(/);
});

test('dialog: owner-facing copy, no username field, loading/error/retry/done states, accessible', () => {
  const dialog = read('src/components/room/RoomConversionDialog.tsx');
  assert.ok(!/username/i.test(dialog.replace(/no public username/gi, '')));
  for (const needle of ['role="dialog"', 'aria-modal="true"', 'aria-labelledby', "state === 'working'", 'role="alert"', 'Retry', 'Escape']) assert.ok(dialog.includes(needle), needle);
  const page = read('src/app/room/[id]/page.tsx');
  assert.ok(!page.includes('groupUsername') && !page.includes('Claim Group Username'));
  assert.match(page, /userRole === 'owner' && roomData && !roomData\.is_group && roomData\.expiration_type !== 'irreversible'/);
  // Regression (browser walkthrough): hooks added below the early returns
  // changed the hook order between renders and crashed the room page.
  const firstEarlyReturn = page.indexOf("if (accessStatus === 'loading')");
  assert.ok(firstEarlyReturn > 0);
  for (const hook of ['const applyConversion = useCallback', 'getRoomGroup(roomIdForGroup)']) {
    assert.ok(page.indexOf(hook) > 0 && page.indexOf(hook) < firstEarlyReturn, `${hook} must be above the early returns`);
  }
});

test('members are notified through the notification system with a presentation', () => {
  assert.equal(notificationPresentation('group_conversion').label, 'Group');
  assert.match(sql, /'task', 'room_event', 'group_conversion'/);
  assert.match(sql, /'guest_changed', 'feature_changed', 'group_converted'/);
});
