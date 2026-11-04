import assert from 'node:assert/strict';
import test from 'node:test';
import { getSafeRedirectPath } from '../src/lib/auth.js';

test('accepts same-origin post-auth paths', () => {
  assert.equal(getSafeRedirectPath('/room/study?tab=chat'), '/room/study?tab=chat');
  assert.equal(getSafeRedirectPath('/profile/setup'), '/profile/setup');
});

test('rejects external and browser-reinterpretable post-auth paths', () => {
  assert.equal(getSafeRedirectPath('https://attacker.example'), '/home');
  assert.equal(getSafeRedirectPath('//attacker.example'), '/home');
  assert.equal(getSafeRedirectPath('\\\\attacker.example'), '/home');
  assert.equal(getSafeRedirectPath('room/study'), '/home');
});
