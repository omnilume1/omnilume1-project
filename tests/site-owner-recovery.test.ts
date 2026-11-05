import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { isAuthRequiredPath } from '../src/lib/auth.js';
import { roomDeletionPolicy } from '../src/lib/room-deletion-policy.js';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
const MIGRATION = read('supabase/migrations/20261105130000_action06_site_owner_recovery_and_notifications_core.sql');
const fn = (name: string) => {
  const start = MIGRATION.indexOf(`FUNCTION public.${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  return MIGRATION.slice(start, MIGRATION.indexOf('$$;', MIGRATION.indexOf('AS $$', start)));
};

test('site owners: seeded from existing accounts only, no client writes, own row only', () => {
  assert.match(MIGRATION, /CREATE TABLE public\.site_owners \(\n  user_id uuid PRIMARY KEY REFERENCES auth\.users \(id\) ON DELETE CASCADE/);
  assert.match(MIGRATION, /ALTER TABLE public\.site_owners ENABLE ROW LEVEL SECURITY;/);
  assert.match(MIGRATION, /REVOKE ALL ON public\.site_owners FROM PUBLIC, anon, authenticated;\nGRANT SELECT ON public\.site_owners TO authenticated;/);
  assert.match(MIGRATION, /USING \(user_id = auth\.uid\(\)\);/);
  assert.match(MIGRATION, /FROM auth\.users u\n  WHERE u\.id IN \(\n    '09e1232f-e1c5-4e4d-bb12-e9a9f95a3c1f'::uuid,\n    'ca4a2221-e712-4962-9d11-5776c4f3e021'::uuid/);
  assert.match(MIGRATION, /IF seeded = 0 THEN\n    RAISE EXCEPTION/);
  // is_site_owner never answers for somebody else's id.
  assert.match(fn('is_site_owner'), /p_user_id = auth\.uid\(\)/);
});

test('only site owners review; pending only; inside the window; irreversible rooms never', () => {
  const review = fn('review_recovery_request');
  const order = ['IF NOT public.is_site_owner(auth.uid())', "request_row.status <> 'pending'", "room_row.expiration_type <> 'recoverable'", 'NOT public.room_in_recovery_window', 'UPDATE public.recovery_requests'];
  order.reduce((previous, marker) => {
    const index = review.indexOf(marker);
    assert.ok(index > previous, `${marker} must come after the previous check`);
    return index;
  }, -1);
  assert.doesNotMatch(review, /is_room_admin_or_owner/);
  assert.match(review, /reopened_until = now\(\) \+ interval '7 days'/);
  assert.match(review, /reviewed_by = auth\.uid\(\)/);
});

test('any approved non-guest member requests, strictly inside the 7-day window', () => {
  const canRequest = fn('can_request_room_recovery');
  assert.match(canRequest, /r\.expiration_type = 'recoverable'/);
  assert.match(canRequest, /now\(\) <= r\.expires_at \+ interval '7 days'/);
  assert.match(canRequest, /room_user_role\(p_room_id, auth\.uid\(\)\) IN \('owner', 'admin', 'member'\)/);
  assert.match(MIGRATION, /CREATE POLICY "Approved members can request recovery"[\s\S]*?public\.can_request_room_recovery\(room_id\)/);
  assert.match(MIGRATION, /CREATE POLICY "Requesters and site owners can view recovery requests"[\s\S]*?USING \(requester_id = auth\.uid\(\) OR public\.is_site_owner\(auth\.uid\(\)\)\);/);
  assert.match(MIGRATION, /DROP POLICY IF EXISTS "Owners and admins can request recovery"/);
});

test('notices: site owners on new requests, requester on decisions, one writer, no client access', () => {
  assert.match(fn('notify_site_owners_of_recovery_request'), /FROM public\.site_owners so/);
  assert.match(fn('notify_room_recovery_decision'), /NEW\.requester_id, NEW\.room_id, 'recovery_decision'/);
  assert.match(MIGRATION, /REVOKE ALL ON FUNCTION public\.enqueue_room_notification\(uuid, uuid, text, text, jsonb, uuid, uuid, text\) FROM PUBLIC, anon, authenticated;/);
  assert.match(MIGRATION, /DROP INDEX IF EXISTS public\.room_notifications_unique_conversion;/);
  assert.match(MIGRATION, /ON CONFLICT \(recipient_id, dedupe_key\) WHERE dedupe_key IS NOT NULL DO NOTHING/);
});

test('permanent rooms: owner-only scheduled deletion with a 7–14 day grace period', () => {
  const schedule = fn('schedule_room_deletion');
  assert.match(schedule, /room_user_role\(p_room_id, auth\.uid\(\)\) IS DISTINCT FROM 'owner'/);
  assert.match(schedule, /p_grace_days < 7 OR p_grace_days > 14/);
  assert.match(schedule, /room_row\.expiration_type <> 'permanent'/);
  assert.match(fn('prevent_unauthorized_deletion_schedule'), /'deletion_schedule'/);
  assert.match(fn('room_lifecycle_state'), /room_row\.deletion_scheduled_at <= now\(\) THEN\n      RETURN 'destroyed';/);
  assert.match(fn('list_rooms_due_for_destruction'), /r\.expiration_type = 'permanent' AND r\.deletion_scheduled_at IS NOT NULL AND r\.deletion_scheduled_at <= now\(\)/);
});

test('/admin is behind sign-in and the recovery page 404s for non site owners', () => {
  assert.equal(isAuthRequiredPath('/admin'), true);
  assert.equal(isAuthRequiredPath('/admin/recovery'), true);
  const page = read('src/app/admin/recovery/page.tsx');
  assert.match(page, /rpc\('is_site_owner', \{ p_user_id: user\.id \}\)/);
  assert.match(page, /if \(ownerError \|\| isSiteOwner !== true\) notFound\(\);/);
  const roomPage = read('src/app/room/[id]/page.tsx');
  assert.doesNotMatch(roomPage, /reviewRoomRecovery|Approve and reopen/);
});

test('the deletion policy is described before joining', () => {
  assert.equal(roomDeletionPolicy({ expiration_type: 'permanent' }).label, 'Permanent');
  assert.match(roomDeletionPolicy({ expiration_type: 'permanent', deletion_scheduled_at: '2026-12-01T00:00:00Z' }).label, /deletion scheduled/);
  assert.match(roomDeletionPolicy({ expiration_type: 'recoverable' }).label, /7-day recovery/);
  assert.match(roomDeletionPolicy({ expiration_type: 'irreversible' }).description, /never be recovered/);
  assert.equal(roomDeletionPolicy({ expiration_type: null }).kind, 'unknown');
  const explore = read('src/app/explore/page.tsx');
  assert.match(explore, /previewRoomInvite\(token\)/);
  assert.match(explore, /roomDeletionPolicy\(room\)/);
});
