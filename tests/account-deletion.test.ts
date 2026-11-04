import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  ACCOUNT_DELETION_REAUTH_WINDOW_SECONDS,
  isRecentAuthentication,
  sessionAuthenticatedAt,
} from '../src/lib/account-deletion.js';

const now = Date.UTC(2026, 10, 5, 12, 0, 0);
const secondsAgo = (seconds: number) => Math.floor(now / 1000) - seconds;

test('the sign-in time comes from the latest detailed amr entry', () => {
  assert.equal(sessionAuthenticatedAt([{ method: 'password', timestamp: 100 }, { method: 'totp', timestamp: 250 }]), 250);
  assert.equal(sessionAuthenticatedAt([{ method: 'oauth', timestamp: 42 }]), 42);
});

test('a missing or string-only amr never counts as a recent sign-in (fails closed)', () => {
  for (const amr of [undefined, null, [], ['password'], [{ method: 'password' }], [{ method: 'password', timestamp: Number.NaN }], 'password']) {
    assert.equal(sessionAuthenticatedAt(amr), null);
    assert.equal(isRecentAuthentication(sessionAuthenticatedAt(amr), now), false);
  }
});

test('deletion is allowed only within the re-authentication window', () => {
  assert.equal(ACCOUNT_DELETION_REAUTH_WINDOW_SECONDS, 600);
  assert.equal(isRecentAuthentication(secondsAgo(0), now), true);
  assert.equal(isRecentAuthentication(secondsAgo(599), now), true);
  assert.equal(isRecentAuthentication(secondsAgo(600), now), true);
  assert.equal(isRecentAuthentication(secondsAgo(601), now), false);
  assert.equal(isRecentAuthentication(secondsAgo(3 * 3600), now), false);
});

test('small clock skew is tolerated, an implausible future sign-in is not', () => {
  assert.equal(isRecentAuthentication(secondsAgo(-30), now), true);
  assert.equal(isRecentAuthentication(secondsAgo(-3600), now), false);
});

test('deleteMyAccount checks the verified sign-in time before any deletion work', () => {
  const source = readFileSync(resolve(process.cwd(), 'src', 'actions', 'account.ts'), 'utf8');
  const body = source.slice(source.indexOf('export async function deleteMyAccount'));
  const claims = body.indexOf('supabase.auth.getClaims()');
  const recency = body.indexOf('isRecentAuthentication(sessionAuthenticatedAt(claimsData.claims.amr)');
  const firstDestructive = Math.min(
    ...['prepare_account_deletion', 'createAdminClient()', 'removePersonalStorage(', 'deleteUser('].map((marker) => {
      const index = body.indexOf(marker);
      return index === -1 ? Number.POSITIVE_INFINITY : index;
    }),
  );
  assert.ok(claims > 0 && recency > claims, 'deleteMyAccount must read verified claims, then check recency');
  assert.ok(recency < firstDestructive, 'the recency check must run before any deletion work');
});
