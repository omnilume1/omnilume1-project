// Push notification probe (migration 20261116100000_push_notifications).
//
//   node scripts/security/push-probe.mjs [base URL, default http://localhost:3000]
//
// Needs one disposable QA account (OMNILUME_QA_A_{EMAIL,PASSWORD} or *_FILE) and, in
// .env.local, PUSH_WEBHOOK_SECRET (the same value the server under test uses).
// Nothing is sent to a push service and nothing is left behind.
// Output: status codes and pass/fail only.

import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..', '..');
const env = Object.fromEntries(readFileSync(resolve(projectRoot, '.env.local'), 'utf8')
  .split(/\r?\n/).map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean)
  .map((match) => [match[1], match[2].replace(/^(['"])(.*)\1$/, '$2')]));
const secret = (name) => process.env[name] ?? (process.env[`${name}_FILE`] ? readFileSync(process.env[`${name}_FILE`], 'utf8').trim() : undefined);
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const base = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const webhook = `${base}/api/internal/push`;

const results = [];
const record = (test, check, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${test}  ${check}${detail ? `  [${detail}]` : ''}`);
};
const codeOf = (res) => (res?.error ? String(res.error.code ?? res.error.statusCode ?? 'error') : 'ok');
const post = (headers, body) => fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body }).then((res) => res.status).catch(() => 0);
const KEYS = { p_p256dh: 'B'.repeat(87), p_auth: 'a'.repeat(22) };

async function main() {
  const webhookSecret = env.PUSH_WEBHOOK_SECRET;
  if (!webhookSecret) throw new Error('PUSH_WEBHOOK_SECRET is missing from .env.local.');
  const good = { Authorization: `Bearer ${webhookSecret}` };
  const event = JSON.stringify({ kind: 'dm', id: randomUUID() });

  // P1: the webhook accepts only POST with the secret and a well-formed body.
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const status = await fetch(webhook, { method, headers: good }).then((res) => res.status).catch(() => 0);
    record('P1', `${method} is refused`, status === 405, String(status));
  }
  record('P1', 'no Authorization header', (await post({}, event)) === 401);
  record('P1', 'wrong secret', (await post({ Authorization: 'Bearer wrong-secret-wrong-secret-wrong' }, event)) === 401);
  record('P1', 'right secret without Bearer', (await post({ Authorization: webhookSecret }, event)) === 401);
  record('P1', 'the service-role key is not the webhook secret', (await post({ Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` }, event)) === 401);
  for (const [label, body] of [['not JSON', 'nope'], ['unknown kind', JSON.stringify({ kind: 'sms', id: randomUUID() })], ['id is not a UUID', JSON.stringify({ kind: 'dm', id: '1 OR 1=1' })], ['extra field', JSON.stringify({ kind: 'dm', id: randomUUID(), text: 'hello' })], ['oversized body', JSON.stringify({ kind: 'dm', id: randomUUID(), padding: 'x'.repeat(50_000) })]]) {
    const status = await post(good, body);
    record('P1', `right secret, ${label}`, status === 400, String(status));
  }
  const accepted = await post(good, event);
  record('P1', 'right secret, random UUID is accepted (and matches nobody)', accepted === 202, String(accepted));

  // P2: the database functions, as each role.
  const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, options);
  const endpoint = `https://fcm.googleapis.com/fcm/send/probe-${randomUUID()}`;
  const anonCalls = {
    save_push_subscription: { p_endpoint: endpoint, ...KEYS },
    remove_push_subscription: { p_endpoint: endpoint },
    push_deliveries: { p_kind: 'dm', p_id: randomUUID() },
    prune_push_subscription: { p_endpoint: endpoint },
    prune_stale_push_subscriptions: { p_days: 60 },
  };
  for (const [name, args] of Object.entries(anonCalls)) {
    const res = await anon.rpc(name, args);
    record('P2', `anon cannot call ${name}`, Boolean(res.error), codeOf(res));
  }
  const anonRead = await anon.from('push_subscriptions').select('id').limit(1);
  record('P2', 'anon cannot read push_subscriptions', Boolean(anonRead.error) || (anonRead.data ?? []).length === 0, codeOf(anonRead));

  const member = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, options);
  const signedIn = await member.auth.signInWithPassword({ email: secret('OMNILUME_QA_A_EMAIL'), password: secret('OMNILUME_QA_A_PASSWORD') });
  if (signedIn.error || !signedIn.data.session) throw new Error('Sign-in failed for account A.');
  for (const name of ['push_deliveries', 'prune_push_subscription', 'prune_stale_push_subscriptions']) {
    const res = await member.rpc(name, anonCalls[name]);
    record('P2', `a member cannot call ${name}`, Boolean(res.error), codeOf(res));
  }
  for (const [label, bad] of [['an internal IP', 'https://169.254.169.254/latest/meta-data/'], ['localhost', 'https://localhost/push'], ['plain http', 'http://fcm.googleapis.com/fcm/send/x'], ['a lookalike host', 'https://fcm.googleapis.com.evil.example/x'], ['a userinfo trick', 'https://fcm.googleapis.com@evil.example/x']]) {
    const res = await member.rpc('save_push_subscription', { p_endpoint: bad, ...KEYS });
    record('P2', `save refuses ${label}`, codeOf(res) === '22023', codeOf(res));
  }
  const direct = await member.from('push_subscriptions').insert({ user_id: signedIn.data.user.id, endpoint, p256dh: KEYS.p_p256dh, auth: KEYS.p_auth });
  record('P2', 'a member cannot insert a row directly', Boolean(direct.error), codeOf(direct));

  // P3: the allowed path works and cleans up after itself.
  const saved = await member.rpc('save_push_subscription', { p_endpoint: endpoint, ...KEYS });
  record('P3', 'a member saves a valid subscription', !saved.error, codeOf(saved));
  const mine = await member.from('push_subscriptions').select('endpoint').eq('endpoint', endpoint);
  record('P3', 'and can read it back', !mine.error && (mine.data ?? []).length === 1, codeOf(mine));
  const removed = await member.rpc('remove_push_subscription', { p_endpoint: endpoint });
  const after = await member.from('push_subscriptions').select('endpoint').eq('endpoint', endpoint);
  record('P3', 'and removes it', !removed.error && (after.data ?? []).length === 0, codeOf(removed));
  await member.auth.signOut().catch(() => undefined);
}

main().catch((error) => { console.error(`ABORTED  ${error instanceof Error ? error.message : 'unknown error'}`); results.push(false); }).finally(() => {
  const failed = results.filter((pass) => !pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed.`);
  process.exit(failed === 0 ? 0 : 1);
});
