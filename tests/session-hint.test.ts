import assert from 'node:assert/strict';
import test from 'node:test';
import { ACCOUNT_HINT_SCRIPT, SESSION_COOKIE } from '../src/lib/session-hint.js';

test('the landing spots a Supabase session cookie, whole or chunked, and nothing else', () => {
  assert.match('sb-abcd1234-auth-token=base64-xyz', SESSION_COOKIE);
  assert.match('theme=dark; sb-abcd1234-auth-token.0=base64-xyz; sb-abcd1234-auth-token.1=rest', SESSION_COOKIE);
  // The sign-in flow's PKCE verifier is not a session.
  assert.doesNotMatch('sb-abcd1234-auth-token-code-verifier=abc', SESSION_COOKIE);
  assert.doesNotMatch('mysb-x-auth-token=1', SESSION_COOKIE);
  assert.doesNotMatch('', SESSION_COOKIE);
});

test('the inline hint is valid script that flags html[data-account] only with a session', () => {
  for (const [cookie, flagged] of [['sb-abcd-auth-token=v', true], ['theme=dark', false]] as const) {
    const dataset: Record<string, string> = {};
    new Function('document', ACCOUNT_HINT_SCRIPT)({ cookie, documentElement: { dataset } });
    assert.equal('account' in dataset, flagged, cookie);
  }
});
