import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { notificationHref, notificationPresentation } from '../src/lib/notification-center-model.js';
import { isAllowedPushEndpoint, isValidPushKeys, PUSH_AUTH_PATTERN, PUSH_ENDPOINT_PATTERN, PUSH_P256DH_PATTERN, toBase64Url } from '../src/lib/push-endpoint.js';
import { buildPushPayload, isSafeRelativeUrl, PUSH_BODY_MAX_CHARS, pushPayloadJson } from '../src/lib/push-payload.js';
import { handlePushWebhook, isAuthorizedPushRequest, parsePushRequest, type PushWebhookDeps } from '../src/lib/push-request.js';
import { deliverPush, PUSH_SEND_TIMEOUT_MS, pushTopic } from '../src/lib/push-send.js';

const root = process.cwd();
const migration = readFileSync(resolve(root, 'supabase/migrations/20261116100000_push_notifications.sql'), 'utf8');
const ID = 'a2f53de6-802b-499e-8369-cdf21b473222';
const OTHER = 'b7e1c0aa-1111-4222-8333-444455556666';
const P256DH = 'B'.repeat(87);
const AUTH = 'a'.repeat(22);

// ---- Endpoint allowlist (the SSRF guard), shared by the browser, the server and SQL ----
const ACCEPTED = [
  'https://fcm.googleapis.com/fcm/send/eJx3:APA91bH-abc_123',
  'https://fcm.googleapis.com/wp/dGVzdA',
  'https://android.googleapis.com/gcm/send/abc',
  'https://updates.push.services.mozilla.com/wpush/v2/gAAAAAB',
  'https://wns2-pn1p.notify.windows.com/w/?token=BQYAAAC%2f',
  'https://web.push.apple.com/QGuQyavXutnMH',
  'https://api.push.apple.com/3/device/abc',
];
const REJECTED = [
  'http://fcm.googleapis.com/fcm/send/abc',
  'https://localhost/push',
  'https://127.0.0.1/push',
  'https://169.254.169.254/latest/meta-data/',
  'https://10.0.0.5/push',
  'https://fcm.googleapis.com.evil.com/fcm/send/abc',
  'https://fcm.googleapis.com@evil.com/fcm/send/abc',
  'https://user:pass@fcm.googleapis.com/fcm/send/abc',
  'https://evil.com/fcm.googleapis.com/',
  'https://[::1]/push',
  'https://[2001:db8::1]/push',
  'https://fcm.googleapis.com:8443/fcm/send/abc',
  'https://FCM.GOOGLEAPIS.COM/fcm/send/abc',
  'https://fcm.googleapis.com',
  'https://fcm.googleapis.com\\@evil.com/x',
  'https://fcm.googleapis.com/fcm/send/a b',
  'https://a.b.googleapis.com/x',
  'https://xn--fcm-googleapis.evil/x',
  'ftp://fcm.googleapis.com/x',
  'javascript:alert(1)',
  `https://fcm.googleapis.com/${'a'.repeat(2000)}`,
  '',
];

test('push endpoints: known push services are accepted, everything else is refused', () => {
  for (const url of ACCEPTED) assert.equal(isAllowedPushEndpoint(url), true, url);
  for (const url of REJECTED) assert.equal(isAllowedPushEndpoint(url), false, url.slice(0, 80));
  for (const value of [null, undefined, 42, {}, ['https://fcm.googleapis.com/x']]) assert.equal(isAllowedPushEndpoint(value), false);
});

test('the SQL guard is the same pattern, and it decides the same way', () => {
  assert.ok(migration.includes(`p_endpoint !~ '${PUSH_ENDPOINT_PATTERN}'`), 'save_push_subscription embeds PUSH_ENDPOINT_PATTERN verbatim');
  assert.ok(migration.includes(`p_p256dh !~ '${PUSH_P256DH_PATTERN}'`) && migration.includes(`p_auth !~ '${PUSH_AUTH_PATTERN}'`), 'and the key patterns');
  assert.match(migration, /char_length\(p_endpoint\) > 1000/);
  // The pattern alone (as Postgres applies it, plus the length limit) agrees with the fixture.
  const pattern = new RegExp(PUSH_ENDPOINT_PATTERN);
  for (const url of ACCEPTED) assert.equal(pattern.test(url) && url.length <= 1000, true, url);
  for (const url of REJECTED) assert.equal(pattern.test(url) && url.length <= 1000, false, url.slice(0, 80));
});

test('subscription keys must be base64url of the right length', () => {
  assert.equal(isValidPushKeys(P256DH, AUTH), true);
  assert.equal(isValidPushKeys(`${P256DH}=`, AUTH), false);
  assert.equal(isValidPushKeys(P256DH.slice(1), AUTH), false);
  assert.equal(isValidPushKeys(P256DH, `${AUTH}a`), false);
  assert.equal(isValidPushKeys(P256DH.replace('B', '+'), AUTH), false);
  assert.equal(isValidPushKeys(null, AUTH), false);
  assert.equal(toBase64Url('ab+/cd=='), 'ab-_cd');
});

// ---- Payload: what a lock screen may show ----
const TYPES = ['mention', 'reply', 'announcement', 'pdf_shared', 'timer', 'recovery_request', 'recovery_decision', 'access', 'security', 'permanent_conversion', 'room_deletion', 'task', 'room_event', 'group_conversion'];
const roomRow = (type: string, extra: Record<string, unknown> = {}) => ({ endpoint: ACCEPTED[0], p256dh: P256DH, auth: AUTH, kind: 'room_notification', notification_type: type, room_id: ID, room_name: 'Hostel 4', message: 'Aman replied to your message.', entity_id: null, metadata: { room_name: 'Hostel 4', message_id: OTHER }, ...extra });

test('every notification type gets a title, a short body, the bell\'s link, a tag, a TTL and an urgency', () => {
  for (const type of TYPES) {
    assert.notEqual(notificationPresentation(type).label, 'Notification', `${type} is a type the notification model knows`);
    const payload = buildPushPayload(roomRow(type, { message: 'x'.repeat(400) }));
    assert.ok(payload, type);
    assert.equal(payload.title, 'Hostel 4');
    assert.ok(Array.from(payload.body).length <= PUSH_BODY_MAX_CHARS + 1 && payload.body.endsWith('…'), `${type}: body is trimmed`);
    assert.equal(payload.url, notificationHref({ notification_type: type, room_id: ID, entity_id: null, metadata: { message_id: OTHER } }), `${type}: same link as the bell`);
    assert.equal(payload.tag, `room:${ID}:${type}`);
    assert.equal(payload.ttl, type === 'timer' ? 600 : type === 'room_event' ? 3600 : 86400, `${type}: ttl`);
    assert.equal(payload.urgency, ['mention', 'reply', 'access', 'security', 'recovery_request', 'recovery_decision'].includes(type) ? 'high' : 'normal', `${type}: urgency`);
    assert.ok(isSafeRelativeUrl(payload.url));
  }
  assert.equal(buildPushPayload(roomRow('recovery_request'))?.url, '/admin/recovery');
});

test('a direct message never shows text, even when the row is poisoned with it', () => {
  const poisoned = { kind: 'dm', chat_id: ID, sender_label: 'Aman', ciphertext: 'c2VjcmV0LWNpcGhlcnRleHQ=', iv: 'QUJDREVGR0hJSktM', content: 'my secret', message: 'my secret', body: 'my secret', metadata: { text: 'my secret' }, title: 'my secret' };
  const payload = buildPushPayload(poisoned);
  assert.deepEqual(payload, { title: 'Aman', body: 'New message', url: `/messages?chat=${ID}`, tag: `dm:${ID}`, ttl: 86400, urgency: 'high' });
  const wire = pushPayloadJson(payload!);
  for (const leak of ['secret', 'c2VjcmV0', 'QUJDREVG', 'ciphertext', 'iv']) assert.equal(wire.includes(leak), false, leak);
  assert.deepEqual(Object.keys(JSON.parse(wire)).sort(), ['body', 'tag', 'title', 'url']);
});

test('a group message shows the group and the sender, never the text', () => {
  const payload = buildPushPayload({ kind: 'group_message', group_id: ID, group_name: 'Hostel 4', sender_label: 'Aman', content: 'the plan is secret', message: 'the plan is secret' });
  assert.deepEqual(payload, { title: 'Hostel 4', body: 'Aman: New message', url: `/messages?group=${ID}`, tag: `group:${ID}`, ttl: 86400, urgency: 'normal' });
  assert.equal(pushPayloadJson(payload!).includes('secret'), false);
});

test('payloads stay small, single-line and on this site', () => {
  const long = '😀'.repeat(80);
  for (const row of [{ kind: 'dm', chat_id: ID, sender_label: long }, { kind: 'group_message', group_id: ID, group_name: long, sender_label: long }, roomRow('mention', { room_name: long, message: long.repeat(3) })]) {
    const payload = buildPushPayload(row);
    assert.ok(payload);
    assert.ok(Buffer.byteLength(pushPayloadJson(payload), 'utf8') < 1024, `${row.kind}: under 1 KB`);
  }
  assert.equal(buildPushPayload({ kind: 'dm', chat_id: ID, sender_label: 'A\nB\u0007C' })?.title, 'A B C');
  assert.equal(buildPushPayload({ kind: 'dm', chat_id: ID, sender_label: '   ' })?.title, 'OmniLume');
  for (const bad of [null, 'dm', {}, { kind: 'dm' }, { kind: 'dm', chat_id: 'nope' }, { kind: 'group_message', group_id: '../x' }, { kind: 'room_notification', room_id: ID, notification_type: 'DROP TABLE' }, { kind: 'room_notification', room_id: 'x', notification_type: 'mention' }, { kind: 'sms', chat_id: ID }]) {
    assert.equal(buildPushPayload(bad), null, JSON.stringify(bad));
  }
  for (const url of ['//evil.com', 'https://evil.com', 'javascript:alert(1)', '/\\evil.com', '/a b', 'home', '', '/\tx', `/${'a'.repeat(400)}`]) assert.equal(isSafeRelativeUrl(url), false, url.slice(0, 30));
  for (const url of ['/home', `/messages?chat=${ID}`, `/room/${ID}#message-${OTHER}`, '/admin/recovery']) assert.equal(isSafeRelativeUrl(url), true, url);
});

// ---- The webhook: who may call it, and with what ----
const SECRET = 'a-long-random-webhook-secret-0123456789';

test('the webhook secret is checked in constant time and never matches by accident', () => {
  assert.equal(isAuthorizedPushRequest(`Bearer ${SECRET}`, SECRET), true);
  for (const header of [null, undefined, '', SECRET, `bearer ${SECRET}`, `Bearer ${SECRET} `, `Bearer ${SECRET}x`, `Bearer ${SECRET.slice(0, -1)}`, 'Bearer ', `Basic ${SECRET}`, `Bearer ${'x'.repeat(5000)}`]) {
    assert.equal(isAuthorizedPushRequest(header, SECRET), false, String(header).slice(0, 40));
  }
  for (const secret of [undefined, null, '', 'short']) assert.equal(isAuthorizedPushRequest('Bearer ', secret), false, 'a missing or short secret authorises nobody');
  assert.equal(isAuthorizedPushRequest('Bearer undefined', undefined), false);
});

test('the webhook body is exactly a known kind and a UUID', () => {
  assert.deepEqual(parsePushRequest(JSON.stringify({ kind: 'dm', id: ID })), { kind: 'dm', id: ID });
  assert.deepEqual(parsePushRequest(JSON.stringify({ id: ID.toUpperCase(), kind: 'group_message' })), { kind: 'group_message', id: ID });
  assert.deepEqual(parsePushRequest(JSON.stringify({ kind: 'room_notification', id: ID })), { kind: 'room_notification', id: ID });
  const bad = [
    '', 'not json', 'null', '[]', '"dm"', JSON.stringify({ kind: 'dm' }), JSON.stringify({ id: ID }),
    JSON.stringify({ kind: 'sms', id: ID }), JSON.stringify({ kind: 'dm', id: 'not-a-uuid' }), JSON.stringify({ kind: 'dm', id: 1 }),
    JSON.stringify({ kind: 'dm', id: ID, text: 'hello' }), JSON.stringify({ kind: 'dm', id: ID, padding: 'x'.repeat(100_000) }),
    JSON.stringify([{ kind: 'dm', id: ID }]), JSON.stringify({ kind: ['dm'], id: ID }),
  ];
  for (const raw of bad) assert.equal(parsePushRequest(raw), null, raw.slice(0, 50));
  for (const raw of [null, undefined, 5, { kind: 'dm', id: ID }]) assert.equal(parsePushRequest(raw), null);
});

// ---- Delivery, with the network and the database replaced ----
const target = (name: string) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, p256dh: P256DH, auth: AUTH, kind: 'dm', chat_id: ID, sender_label: 'Aman Verma' });
function fakeDeps(statuses: Record<string, number | 'hang' | 'throw'>, rows: unknown[]) {
  const sent: Array<{ endpoint: string; payload: string; options: { TTL: number; urgency: string; topic: string } }> = [];
  const pruned: string[] = [];
  const logs: string[] = [];
  const deps: PushWebhookDeps = {
    secret: SECRET,
    timeoutMs: 60,
    loadDeliveries: async () => rows,
    send: (subscription, payload, options) => {
      sent.push({ endpoint: subscription.endpoint, payload, options });
      const status = statuses[subscription.endpoint.split('/').pop()!] ?? 201;
      if (status === 'hang') return new Promise(() => undefined);
      if (status === 'throw') return Promise.reject(new Error(`socket hang up for ${subscription.endpoint}`));
      return status >= 200 && status < 300 ? Promise.resolve({ statusCode: status }) : Promise.reject(Object.assign(new Error(`Received unexpected response code for ${subscription.endpoint}`), { statusCode: status }));
    },
    prune: async (endpoint) => { pruned.push(endpoint); },
    log: (line) => { logs.push(line); },
  };
  return { deps, sent, pruned, logs };
}

test('a gone subscription is pruned, the others are sent, and busy or broken push services keep theirs', async () => {
  const rows = [target('one'), target('gone'), target('three'), target('missing'), target('busy'), target('broken'), target('dropped')];
  const { deps, sent, pruned } = fakeDeps({ gone: 410, missing: 404, busy: 429, broken: 500, dropped: 'throw' }, rows);
  const counts = await deliverPush(rows, deps);
  assert.deepEqual(counts, { targets: 7, sent: 2, pruned: 2, failed: 3, skipped: 0 });
  assert.deepEqual(pruned.sort(), [rows[1].endpoint, rows[3].endpoint].sort(), 'only 404 and 410 are pruned');
  assert.equal(sent.length, 7);
  assert.deepEqual(JSON.parse(sent[0].payload), { title: 'Aman Verma', body: 'New message', url: `/messages?chat=${ID}`, tag: `dm:${ID}` });
  assert.deepEqual(sent[0].options, { TTL: 86400, urgency: 'high', topic: pushTopic(`dm:${ID}`), timeout: 60 });
  assert.match(pushTopic(`dm:${ID}`), /^[A-Za-z0-9_-]{32}$/, 'a valid Topic header');
});

test('one hanging push service times out and the others still send', async () => {
  assert.equal(PUSH_SEND_TIMEOUT_MS, 5000, 'the real timeout is 5 seconds');
  const rows = [target('one'), target('stuck'), target('three')];
  const { deps } = fakeDeps({ stuck: 'hang' }, rows);
  const started = Date.now();
  assert.deepEqual(await deliverPush(rows, deps), { targets: 3, sent: 2, pruned: 0, failed: 1, skipped: 0 });
  assert.ok(Date.now() - started < 1500, 'the hang did not hold the others up');
});

test('an endpoint that is not a push service is never called, even if the database returned it', async () => {
  const rows = [target('one'), { ...target('x'), endpoint: 'https://169.254.169.254/latest/meta-data/' }, { ...target('y'), endpoint: 'http://localhost:5432/' }, { ...target('z'), p256dh: 'short' }, { ...target('w'), chat_id: 'nope' }, null, 'junk'];
  const { deps, sent } = fakeDeps({}, rows);
  assert.deepEqual(await deliverPush(rows, deps), { targets: 7, sent: 1, pruned: 0, failed: 0, skipped: 6 });
  assert.deepEqual(sent.map((item) => item.endpoint), [rows[0] && (rows[0] as { endpoint: string }).endpoint]);
  assert.deepEqual(await deliverPush('not rows', deps), { targets: 0, sent: 0, pruned: 0, failed: 0, skipped: 0 });
});

test('the webhook answers before it sends, and logs counts only', async () => {
  const rows = [target('one'), target('gone'), target('three')];
  const { deps, sent, logs } = fakeDeps({ gone: 410 }, rows);
  assert.deepEqual(handlePushWebhook({ authorization: null, body: JSON.stringify({ kind: 'dm', id: ID }) }, deps), { status: 401 });
  assert.deepEqual(handlePushWebhook({ authorization: 'Bearer wrong', body: JSON.stringify({ kind: 'dm', id: ID }) }, deps), { status: 401 });
  assert.deepEqual(handlePushWebhook({ authorization: `Bearer ${SECRET}`, body: '{"kind":"dm"}' }, deps), { status: 400 });
  assert.deepEqual(handlePushWebhook({ authorization: `Bearer ${SECRET}`, body: '' }, deps), { status: 400 });

  const accepted = handlePushWebhook({ authorization: `Bearer ${SECRET}`, body: JSON.stringify({ kind: 'dm', id: ID }) }, deps);
  assert.equal(accepted.status, 202);
  assert.equal(sent.length, 0, '202 is decided before anything is sent');
  assert.deepEqual(await accepted.work!(), { targets: 3, sent: 2, pruned: 1, failed: 0, skipped: 0 });
  assert.deepEqual(logs, ['push dm: targets=3 sent=2 pruned=1 failed=0 skipped=0']);

  // A random UUID that matches nothing: 202 and zero sends.
  const empty = fakeDeps({}, []);
  assert.deepEqual(await handlePushWebhook({ authorization: `Bearer ${SECRET}`, body: JSON.stringify({ kind: 'dm', id: OTHER }) }, empty.deps).work!(), { targets: 0, sent: 0, pruned: 0, failed: 0, skipped: 0 });
  assert.equal(empty.sent.length, 0);

  // A failure to load deliveries is logged without the error, which could carry personal data.
  const failing = fakeDeps({}, []);
  failing.deps.loadDeliveries = async () => { throw new Error(`connection lost for user ${ID} at ${rows[0].endpoint} (Aman Verma)`); };
  assert.equal(await handlePushWebhook({ authorization: `Bearer ${SECRET}`, body: JSON.stringify({ kind: 'dm', id: ID }) }, failing.deps).work!(), null);
  for (const line of [...logs, ...failing.logs]) {
    for (const personal of ['fcm.googleapis.com', 'https://', 'Aman', ID, OTHER, P256DH, AUTH, SECRET]) assert.equal(line.includes(personal), false, `log line leaks ${personal}: ${line}`);
  }
});

test('the migration keeps secrets, names and text out of the webhook and off the wrong roles', () => {
  assert.match(migration, /body := jsonb_build_object\('kind', TG_ARGV\[0\], 'id', NEW\.id\)/, 'the webhook body is only kind and id');
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.push_deliveries\(text, uuid\) FROM PUBLIC, anon, authenticated;/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.queue_push\(\) FROM PUBLIC, anon, authenticated;/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.save_push_subscription\(text, text, text\) FROM PUBLIC, anon;/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.push_subscriptions FROM PUBLIC, anon, authenticated;/);
  assert.equal((migration.match(/SECURITY DEFINER/g) ?? []).length, (migration.match(/SET search_path = ''/g) ?? []).length, 'every SECURITY DEFINER function pins an empty search_path');
  assert.doesNotMatch(migration, /vault\.create_secret|Bearer [A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{10,}/, 'no secret value in the migration');
  assert.match(migration, /EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING/, 'the trigger can never fail the insert');
});
