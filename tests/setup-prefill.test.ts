import assert from 'node:assert/strict';
import test from 'node:test';
import { saveWithUsernameRetry, setupPrefill, suggestUsername, type ProfileInput } from '../src/lib/profile-validation.js';

const USERNAME_RE = /^[a-z0-9][a-z0-9_.]{2,29}$/;
const fixed = (value: number) => () => value;

test('suggestUsername folds accents and lowercases', () => {
  const name = suggestUsername('Zoë Ángel', fixed(0));
  assert.equal(name, 'zoeangel1000');
  assert.match(name, USERNAME_RE);
});

test('suggestUsername falls back to friend for emoji-only names', () => {
  const name = suggestUsername('😀😀', fixed(0.5));
  assert.match(name, /^friend\d{4}$/);
  assert.match(name, USERNAME_RE);
});

test('suggestUsername trims a 60-character name to fit', () => {
  const name = suggestUsername('a'.repeat(60), fixed(0.9999));
  assert.ok(name.length <= 30);
  assert.match(name, USERNAME_RE);
});

test('suggestUsername handles digits-only and leading punctuation', () => {
  assert.match(suggestUsername('12345', fixed(0.1)), USERNAME_RE);
  assert.match(suggestUsername('..__x', fixed(0.1)), USERNAME_RE);
  assert.match(suggestUsername('', fixed(0.1)), USERNAME_RE);
});

test('suggestUsername is deterministic with an injected random', () => {
  assert.equal(suggestUsername('Rohan Yadav', fixed(0.25)), suggestUsername('Rohan Yadav', fixed(0.25)));
  assert.equal(suggestUsername('Rohan Yadav', fixed(0.25)), 'rohanyadav3250');
});

test('setupPrefill never overwrites existing values', () => {
  const result = setupPrefill(
    { display_name: 'Mine', avatar_url: '/a.png', username: 'mine_1' },
    { full_name: 'Google Name', picture: 'https://x/y.png' },
    fixed(0),
  );
  assert.deepEqual(result, { displayName: 'Mine', avatarUrl: '/a.png', username: 'mine_1' });
});

test('setupPrefill fills empty values from metadata and rejects an http picture', () => {
  const ok = setupPrefill(null, { name: 'Asha Rao', avatar_url: 'https://x/y.png' }, fixed(0));
  assert.equal(ok.displayName, 'Asha Rao');
  assert.equal(ok.avatarUrl, 'https://x/y.png');
  assert.equal(ok.username, 'asharao1000');
  const bad = setupPrefill({ display_name: '', avatar_url: null, username: null }, { full_name: 'A B', picture: 'http://x/y.png' }, fixed(0));
  assert.equal(bad.avatarUrl, '');
});

const base: ProfileInput = { displayName: 'A', username: 'asha1000', dateOfBirth: '2000-01-01', gender: 'prefer_not_to_say', isPrivate: true };
const TAKEN = 'That username is already in use.';

test('saveWithUsernameRetry retries an untouched suggestion with new digits', async () => {
  const tried: string[] = [];
  const { result, input } = await saveWithUsernameRetry(
    async (i) => { tried.push(i.username); return tried.length < 2 ? { success: false, error: TAKEN } : { success: true }; },
    base, { suggested: 'asha1000', random: fixed(0.5) },
  );
  assert.equal(result.success, true);
  assert.deepEqual(tried, ['asha1000', 'asha5500']);
  assert.equal(input.username, 'asha5500');
});

test('saveWithUsernameRetry does not retry an edited username', async () => {
  let calls = 0;
  const { result } = await saveWithUsernameRetry(
    async () => { calls += 1; return { success: false, error: TAKEN }; },
    { ...base, username: 'mine' }, { suggested: 'asha1000' },
  );
  assert.equal(calls, 1);
  assert.equal(result.error, TAKEN);
});

test('saveWithUsernameRetry stops after 2 retries', async () => {
  let calls = 0;
  const { result } = await saveWithUsernameRetry(
    async () => { calls += 1; return { success: false, error: TAKEN }; },
    base, { suggested: 'asha1000', random: fixed(0.3) },
  );
  assert.equal(calls, 3);
  assert.equal(result.success, false);
});

test('saveWithUsernameRetry passes other errors through without retrying', async () => {
  let calls = 0;
  const { result } = await saveWithUsernameRetry(
    async () => { calls += 1; return { success: false, error: 'You must be at least 13 years old to use OmniLume.' }; },
    base, { suggested: 'asha1000' },
  );
  assert.equal(calls, 1);
  assert.equal(result.error, 'You must be at least 13 years old to use OmniLume.');
});
