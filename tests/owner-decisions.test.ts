import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { MINIMUM_AGE_YEARS, latestAllowedDateOfBirth, validateProfileInput } from '../src/lib/profile-validation.js';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const MIGRATION = 'supabase/migrations/20261105120000_action04_06_recovery_week_cleanup_minimum_age.sql';

const profile = (dateOfBirth: string) => validateProfileInput({
  displayName: 'Test',
  username: 'tester',
  dateOfBirth,
  gender: 'prefer_not_to_say',
  isPrivate: false,
});

test('minimum age is 13, inclusive of the 13th birthday', () => {
  assert.equal(MINIMUM_AGE_YEARS, 13);
  const now = new Date(Date.UTC(2026, 10, 5, 12));
  assert.equal(latestAllowedDateOfBirth(now), '2013-11-05');
  // Leap day: Postgres clamps 2028-02-29 minus 13 years to 2015-02-28.
  assert.equal(latestAllowedDateOfBirth(new Date(Date.UTC(2028, 1, 29))), '2015-02-28');

  const latest = latestAllowedDateOfBirth();
  const dayAfter = new Date(`${latest}T00:00:00.000Z`);
  dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
  assert.equal(profile(latest).success, true);
  const tooYoung = profile(dayAfter.toISOString().slice(0, 10));
  assert.equal(tooYoung.success, false);
  assert.match(tooYoung.success ? '' : tooYoung.error, /at least 13/);
});

test('the database enforces the same minimum age on insert and on date-of-birth change', () => {
  const sql = read(MIGRATION);
  assert.match(sql, /CREATE TRIGGER profiles_enforce_minimum_age\s+BEFORE INSERT OR UPDATE OF date_of_birth ON public\.profiles/);
  assert.match(sql, /NEW\.date_of_birth > \(current_date - interval '13 years'\)::date/);
  assert.match(sql, /at least 13 years old/);
  assert.match(read('src/actions/profiles.ts'), /at least 13 years old/);
});

test('recoverable rooms have a 7-day recovery window held open by a pending request', () => {
  const sql = read(MIGRATION);
  const lifecycle = sql.slice(sql.indexOf('FUNCTION public.room_lifecycle_state'), sql.indexOf('FUNCTION public.list_rooms_due_for_destruction'));
  assert.match(lifecycle, /now\(\) <= room_row\.expires_at \+ interval '7 days'/);
  assert.match(lifecycle, /rr\.status = 'pending'/);
  assert.doesNotMatch(lifecycle, /24 hours/);
  assert.doesNotMatch(read('src/app/room/[id]/page.tsx'), /24-hour window/);
});

test('cleanup destroys only rooms the database re-confirms, and only via service role', () => {
  const sql = read(MIGRATION);
  const destroy = sql.slice(sql.indexOf('FUNCTION public.destroy_expired_room'), sql.indexOf('REVOKE ALL ON FUNCTION public.list_rooms_due_for_destruction'));
  // Lock, re-check, then delete.
  assert.ok(destroy.indexOf('FOR UPDATE') < destroy.indexOf("room_lifecycle_state(p_room_id) <> 'destroyed'"));
  assert.ok(destroy.indexOf("<> 'destroyed'") < destroy.indexOf('DELETE FROM public.rooms'));
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.destroy_expired_room\(uuid\) FROM PUBLIC, anon, authenticated;/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.destroy_expired_room\(uuid\) TO service_role;/);

  assert.match(read('src/app/api/internal/cleanup-expired-rooms/route.ts'), /cleanupDestroyedRooms\(supabase, now\)/);
  const route = read('src/lib/room-cleanup.ts');
  assert.match(route, /rpc\('list_rooms_due_for_destruction'/);
  // Storage first, then the locked, re-checked delete.
  assert.ok(route.indexOf('removeStorageFiles(supabase, storagePaths)') < route.indexOf("rpc('destroy_expired_room'"));
  assert.doesNotMatch(route, /from\('rooms'\)\s*\.delete\(\)/);
});
