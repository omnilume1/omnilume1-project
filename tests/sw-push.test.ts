import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { swPushPlan } from '../src/lib/sw-push.js';

const ORIGIN = 'https://omnilume.vercel.app';
const ID = 'a2f53de6-802b-499e-8369-cdf21b473222';
const dm = { title: 'Aman', body: 'New message', url: `/messages?chat=${ID}`, tag: `dm:${ID}` };
const mention = { title: 'Hostel 4', body: 'Aman mentioned you.', url: `/room/${ID}#message-${ID}`, tag: `room:${ID}:mention` };

test('a push becomes one notification that opens the right page', () => {
  assert.deepEqual(swPushPlan(dm, ORIGIN, [], 0), {
    title: 'Aman',
    options: { body: 'New message', tag: `dm:${ID}`, badge: '/icons/badge-96.png', icon: '/icons/icon-192.png', renotify: true, data: { url: `/messages?chat=${ID}`, count: 1 } },
  });
  assert.equal(swPushPlan(mention, ORIGIN, [], 0)?.options.data.url, `/room/${ID}#message-${ID}`);
});

test('a second message under the same tag updates the notification instead of buzzing again', () => {
  const second = swPushPlan(dm, ORIGIN, [], 1);
  assert.equal(second?.options.body, '2 new messages');
  assert.equal(second?.options.renotify, false);
  assert.equal(second?.options.data.count, 2);
  assert.equal(swPushPlan(dm, ORIGIN, [], 29)?.options.body, '30 new messages');
  assert.equal(swPushPlan(mention, ORIGIN, [], 2)?.options.body, '3 new notifications');
});

test('someone looking at that page gets no notification; any other page does', () => {
  assert.equal(swPushPlan(dm, ORIGIN, [`${ORIGIN}/messages`], 0), null);
  assert.equal(swPushPlan(dm, ORIGIN, [`${ORIGIN}/home`, `${ORIGIN}/messages?chat=${ID}`], 0), null);
  assert.equal(swPushPlan(mention, ORIGIN, [`${ORIGIN}/room/${ID}`], 0), null);
  assert.ok(swPushPlan(dm, ORIGIN, [`${ORIGIN}/home`], 0));
  assert.ok(swPushPlan(mention, ORIGIN, [`${ORIGIN}/room/b7e1c0aa-1111-4222-8333-444455556666`, `${ORIGIN}/messages`], 0));
  assert.ok(swPushPlan(dm, ORIGIN, ['https://evil.example/messages', 'not a url'], 0), 'another site\'s window does not count');
});

test('a bad payload shows nothing', () => {
  const bad = [
    null, undefined, 'text', 42, [], {},
    { ...dm, title: '' }, { ...dm, body: '   ' }, { ...dm, tag: undefined }, { ...dm, title: 7 },
    { ...dm, url: 'https://evil.example/x' }, { ...dm, url: '//evil.example/x' }, { ...dm, url: 'javascript:alert(1)' }, { ...dm, url: '/\\evil.example' }, { ...dm, url: 'messages' }, { ...dm, url: undefined },
  ];
  for (const payload of bad) assert.equal(swPushPlan(payload, ORIGIN, [], 0), null, JSON.stringify(payload));
});

// The real public/sw.js, with the browser's notification APIs replaced.
const workerSource = readFileSync(resolve(process.cwd(), 'public/sw.js'), 'utf8').replace(/\r\n/g, '\n');
interface Shown { title: string; tag: string; body: string; data: { url: string; count: number }; renotify: boolean }

function startWorker(windows: Array<{ url: string; focused: boolean; visibilityState: string; navigable?: boolean }>) {
  const listeners = new Map<string, (event: unknown) => void>();
  const shown: Shown[] = [];
  const opened: string[] = [];
  const navigated: string[] = [];
  const context = {
    URL, Promise, Math, Number,
    Request: class { url: string; constructor(url: string) { this.url = url; } },
    Response: { error: () => ({}) },
    fetch: async () => ({}),
    caches: { open: async () => ({}), keys: async () => [], delete: async () => true, match: async () => undefined },
    self: {
      addEventListener: (type: string, listener: (event: unknown) => void) => { listeners.set(type, listener); },
      skipWaiting: async () => undefined,
      location: { origin: ORIGIN },
      clients: {
        claim: async () => undefined,
        matchAll: async () => windows.map((window) => ({
          ...window,
          focus: async () => undefined,
          navigate: async (url: string) => { if (window.navigable === false) throw new Error('cannot navigate'); navigated.push(url); },
        })),
        openWindow: async (url: string) => { opened.push(url); },
      },
      registration: {
        getNotifications: async ({ tag }: { tag: string }) => shown.filter((item) => item.tag === tag).slice(-1),
        showNotification: async (title: string, options: Omit<Shown, 'title'>) => { shown.push({ title, ...options }); },
      },
    },
  };
  vm.runInNewContext(workerSource, context);
  const dispatch = async (type: string, event: Record<string, unknown>) => {
    const waits: Array<Promise<unknown>> = [];
    listeners.get(type)!({ ...event, waitUntil: (work: Promise<unknown>) => { waits.push(work); } });
    await Promise.all(waits);
  };
  const push = (payload: unknown) => dispatch('push', { data: payload === undefined ? null : { json: () => { if (payload === 'broken') throw new SyntaxError('bad json'); return payload; } } });
  const click = (url: unknown) => dispatch('notificationclick', { notification: { close: () => undefined, data: { url } } });
  return { push, click, shown, opened, navigated };
}

test('worker: thirty group messages in a row leave one notification that buzzed once', async () => {
  const worker = startWorker([]);
  const group = { title: 'Hostel 4', body: 'Aman: New message', url: `/messages?group=${ID}`, tag: `group:${ID}` };
  for (let index = 0; index < 30; index += 1) await worker.push(group);
  assert.equal(worker.shown.length, 30, 'each push replaces the same tag');
  assert.equal(worker.shown.filter((item) => item.renotify).length, 1, 'only the first one alerts');
  assert.equal(worker.shown.at(-1)?.body, '30 new messages');
  assert.equal(new Set(worker.shown.map((item) => item.tag)).size, 1);
});

test('worker: nothing is shown for a bad payload or while that page is in front', async () => {
  const idle = startWorker([]);
  for (const payload of [undefined, 'broken', { nonsense: true }, { ...dm, url: 'https://evil.example/' }]) await idle.push(payload);
  assert.equal(idle.shown.length, 0);

  const watching = startWorker([{ url: `${ORIGIN}/messages`, focused: true, visibilityState: 'visible' }]);
  await watching.push(dm);
  assert.equal(watching.shown.length, 0, 'the Messages page is in front');
  await watching.push(mention);
  assert.equal(watching.shown.length, 1, 'a room mention still arrives');

  const background = startWorker([{ url: `${ORIGIN}/messages`, focused: false, visibilityState: 'hidden' }]);
  await background.push(dm);
  assert.equal(background.shown.length, 1, 'a tab in the background does not count');
});

test('worker: a tap opens this site only, reusing an open window when it can', async () => {
  const reuse = startWorker([{ url: `${ORIGIN}/home`, focused: false, visibilityState: 'hidden' }]);
  await reuse.click(dm.url);
  assert.deepEqual(reuse.navigated, [`${ORIGIN}${dm.url}`]);
  assert.deepEqual(reuse.opened, []);

  const fresh = startWorker([]);
  await fresh.click(mention.url);
  assert.deepEqual(fresh.opened, [`${ORIGIN}${mention.url}`]);
  const stuck = startWorker([{ url: `${ORIGIN}/home`, focused: false, visibilityState: 'hidden', navigable: false }]);
  await stuck.click(dm.url);
  assert.deepEqual(stuck.opened, [`${ORIGIN}${dm.url}`], 'a window that cannot be reused falls back to a new one');

  const hostile = startWorker([]);
  for (const url of ['https://evil.example/phish', '//evil.example/phish']) await hostile.click(url);
  assert.deepEqual(hostile.opened, [], 'another site is never opened');
  await hostile.click(undefined);
  assert.deepEqual(hostile.opened, [`${ORIGIN}/home`], 'a notification without a link opens Home');
});
