import assert from 'node:assert/strict';
import test from 'node:test';
import { isProfileComplete } from '../src/lib/auth.js';

test('requires both identity and profile-detail completion flags', () => {
  assert.equal(isProfileComplete(null), false);
  assert.equal(isProfileComplete({ profile_completed: true, profile_details_completed: false }), false);
  assert.equal(isProfileComplete({ profile_completed: false, profile_details_completed: true }), false);
  assert.equal(isProfileComplete({ profile_completed: true, profile_details_completed: true }), true);
});
