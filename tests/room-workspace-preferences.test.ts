import assert from 'node:assert/strict';
import test from 'node:test';
import { roomWorkspacePreferenceKey } from '../src/lib/room-workspace-preferences.js';

test('scopes room workspace preferences to the signed-in user', () => {
  const ownerKey = roomWorkspacePreferenceKey('room-a', 'user-owner', 'sidebar-width');
  const memberKey = roomWorkspacePreferenceKey('room-a', 'user-member', 'sidebar-width');

  assert.notEqual(ownerKey, memberKey);
  assert.equal(ownerKey, 'omnilume:room:room-a:user-owner:sidebar-width');
});

test('does not produce a persisted preference key before identity is known', () => {
  assert.equal(roomWorkspacePreferenceKey('room-a', null, 'sidebar-width'), null);
});
