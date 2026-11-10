import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { isDoorToken, normalizeNameplate } from '../src/lib/door-key.js';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
const DOOR_SQL = 'supabase/migrations/20261110103628_phase04_door_key_and_nameplate.sql';
const CARD_SQL = 'supabase/migrations/20261110105146_phase05_public_invite_card.sql';

test('nameplates are 1–12 letters, numbers, spaces or dashes, whitespace collapsed', () => {
  assert.equal(normalizeNameplate('B-204'), 'B-204');
  assert.equal(normalizeNameplate('  B   204 '), 'B 204');
  assert.equal(normalizeNameplate('Room 12 Wing'), 'Room 12 Wing');
  assert.equal(normalizeNameplate('ABCDEFGHIJKLM'), null);
  assert.equal(normalizeNameplate('   '), null);
  assert.equal(normalizeNameplate(''), null);
  assert.equal(normalizeNameplate('B<204>'), null);
  assert.equal(normalizeNameplate('B_204'), null);
  assert.equal(normalizeNameplate('कमरा'), null);
  assert.equal(normalizeNameplate(42), null);
  assert.equal(normalizeNameplate('x'.repeat(65)), null);
});

test('door tokens are 48 lowercase hex characters', () => {
  assert.equal(isDoorToken('a'.repeat(48)), true);
  assert.equal(isDoorToken('0123456789abcdef'.repeat(3)), true);
  assert.equal(isDoorToken('A'.repeat(48)), false);
  assert.equal(isDoorToken('a'.repeat(47)), false);
  assert.equal(isDoorToken(`${'a'.repeat(48)}?ref=x`), false);
  assert.equal(isDoorToken(null), false);
});

test('the door key migration keeps sharing to members and lock changes to manage_invites', () => {
  const sql = read(DOOR_SQL);
  assert.doesNotMatch(sql, /GRANT[^;]*\banon\b/);
  assert.equal(sql.match(/SET search_path TO ''/g)?.length, 4);
  for (const fn of ['get_room_door_link(uuid)', 'change_room_lock(uuid)', 'set_room_nameplate(uuid, text)']) {
    assert.ok(sql.includes(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon;`), fn);
    assert.ok(sql.includes(`GRANT EXECUTE ON FUNCTION public.${fn} TO authenticated;`), fn);
  }
  // D1: guests are refused unless they hold manage_invites.
  assert.match(sql, /v_role = 'guest' AND NOT public\.room_has_capability\(p_room_id, v_uid, 'manage_invites'\)/);
  assert.match(sql, /NOT public\.room_has_capability\(p_room_id, v_uid, 'manage_invites'\) THEN\n\s+RAISE EXCEPTION 'Not allowed to change/);
  assert.match(sql, /NOT public\.room_has_capability\(p_room_id, v_uid, 'manage_settings'\)/);
  assert.match(sql, /WHERE is_door_key AND revoked_at IS NULL;/);
  assert.match(sql, /jsonb_build_object\('from', 'door'\)/);
  // The backfill keeps the bigint cast so abs() can't overflow.
  assert.equal(sql.match(/abs\(hashtext\((NEW\.)?id::text\)::bigint\)/g)?.length, 4);
});

test('the public invite card returns no ids and logs only when asked', () => {
  const sql = read(CARD_SQL);
  const returns = sql.match(/RETURNS TABLE\(([\s\S]*?)\n \)/)?.[1] ?? '';
  assert.ok(returns.includes('room_name text'));
  assert.doesNotMatch(returns, /_id\b|\bid\b|user|avatar|subject|title|token/);
  assert.doesNotMatch(sql, /'subject'|->> 'subject'/);
  assert.match(sql, /IF p_log THEN\n\s+INSERT INTO public\.product_events \(event, room_id, ref\)\n\s+VALUES \(\n\s+'join_viewed'/);
  assert.match(sql, /IF v_hits > 60 THEN/);
  assert.match(sql, /date_bin\('10 minutes'/);
  assert.match(sql, /sha256\(convert_to\(v_token, 'UTF8'\)\)/);
  assert.match(sql, /bucket < now\(\) - interval '1 day'/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.invite_card_hits FROM PUBLIC, anon, authenticated;/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.get_public_invite_card\(text, text, boolean\) TO anon, authenticated;/);
  assert.doesNotMatch(sql, /CREATE POLICY/);
});
