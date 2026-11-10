import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {
  renderServiceWorker,
  swCachePolicy,
  swDecisionStores,
  SW_OFFLINE_CACHE,
  SW_OFFLINE_URL,
  SW_PRECACHE_URLS,
  SW_STATIC_CACHE,
  SW_STATIC_MAX_ENTRIES,
  type SwCacheDecision,
  type SwRequestFacts,
} from '../src/lib/sw-cache-policy.js';

const ORIGIN = 'https://omnilume.vercel.app';
const get = (url: string, extra: Partial<SwRequestFacts> = {}): SwRequestFacts => ({
  method: 'GET', url: url.startsWith('http') ? url : `${ORIGIN}${url}`, mode: 'cors', hasAuthorization: false, hasRange: false, ...extra,
});
const page = (url: string) => get(url, { mode: 'navigate' });

const TABLE: Array<[label: string, request: SwRequestFacts, expected: SwCacheDecision]> = [
  ['hashed script', get('/_next/static/chunks/4f1c9a7e2b.js', { mode: 'no-cors' }), 'static'],
  ['hashed stylesheet', get('/_next/static/css/9d2e1b.css', { mode: 'no-cors' }), 'static'],
  ['self-hosted font', get('/_next/static/media/geist-latin.woff2'), 'static'],
  ['page load: home', page('/home'), 'navigate'],
  ['page load: landing', page('/'), 'navigate'],
  ['page load: room', page('/room/a2f53de6-802b-499e-8369-cdf21b473222'), 'navigate'],
  ['page load: message deep link', page('/messages?chat=a2f53de6-802b-499e-8369-cdf21b473222'), 'navigate'],
  ['page load: the offline page itself', page(SW_OFFLINE_URL), 'navigate'],
  ['page load: auth callback', page('/auth/callback?code=one-time-code'), 'navigate'],
  ['auth request from a page', get('/auth/callback?code=one-time-code'), 'bypass'],
  ['API read', get('/api/ice-servers'), 'bypass'],
  ['API search', get('/api/media/search?q=lofi'), 'bypass'],
  ['API page load', page('/api/recordings/a2f53de6-802b-499e-8369-cdf21b473222'), 'navigate'],
  ['internal API write', get('/api/internal/push', { method: 'POST' }), 'bypass'],
  ['Supabase REST', get('https://abcdefgh.supabase.co/rest/v1/messages?select=*'), 'bypass'],
  ['Supabase storage', get('https://abcdefgh.supabase.co/storage/v1/object/sign/avatars/a.png'), 'bypass'],
  ['R2 media', get('https://account.r2.cloudflarestorage.com/bucket/song.flac'), 'bypass'],
  ['request with Authorization', get('/_next/static/chunks/4f1c9a7e2b.js', { hasAuthorization: true }), 'bypass'],
  ['media Range request', get('/_next/static/media/intro.mp4', { hasRange: true }), 'bypass'],
  ['server action POST', get('/home', { method: 'POST' }), 'bypass'],
  ['PUT', get('/_next/static/chunks/4f1c9a7e2b.js', { method: 'PUT' }), 'bypass'],
  ['HEAD', get('/_next/static/chunks/4f1c9a7e2b.js', { method: 'HEAD' }), 'bypass'],
  ['HTML page fetched as data (RSC)', get('/home?_rsc=1a2b3'), 'bypass'],
  ['HTML page prefetch', get('/explore'), 'bypass'],
  ['cross-origin font', get('https://fonts.gstatic.com/s/geist/v1/latin.woff2'), 'bypass'],
  ['image optimizer', get('/_next/image?url=%2Flanding%2Fhome.jpg&w=640&q=75'), 'bypass'],
  ['public icon', get('/icons/icon-192.png', { mode: 'no-cors' }), 'bypass'],
  ['manifest', get('/manifest.webmanifest'), 'bypass'],
  ['the worker script', get('/sw.js'), 'bypass'],
  ['lookalike origin', get('https://omnilume.vercel.app.evil.com/_next/static/chunks/x.js'), 'bypass'],
  ['lookalike path', get('/files/_next/static/chunks/x.js'), 'bypass'],
  ['cross-origin page load', page('https://evil.example/home'), 'bypass'],
  ['unparseable URL', { method: 'GET', url: 'not a url', mode: 'cors', hasAuthorization: false, hasRange: false }, 'bypass'],
];

test('cache policy table: only hashed build files are ever stored', () => {
  assert.ok(TABLE.length >= 20);
  for (const [label, request, expected] of TABLE) {
    const decision = swCachePolicy(request, ORIGIN);
    assert.equal(decision, expected, label);
    const stores = swDecisionStores(decision);
    assert.equal(stores, expected === 'static', `${label}: stores`);
    if (stores) assert.ok(new URL(request.url).pathname.startsWith('/_next/static/'), `${label}: only build files are stored`);
  }
});

test('only the offline page is precached', () => {
  assert.deepEqual(SW_PRECACHE_URLS, ['/offline.html']);
});

const root = process.cwd();
const workerSource = readFileSync(resolve(root, 'public/sw.js'), 'utf8').replace(/\r\n/g, '\n');

test('public/sw.js is generated from sw-cache-policy.ts and up to date', () => {
  assert.equal(workerSource, renderServiceWorker(), 'Run `npm run test:unit` (compiles the module), then `node scripts/write-sw.mjs`.');
});

test('the offline page is self-contained and says what to do', () => {
  const html = readFileSync(resolve(root, 'public/offline.html'), 'utf8');
  assert.match(html, /You're offline\./);
  assert.match(html, /Reconnect to get back to your room\./);
  assert.doesNotMatch(html, /(?:src|href)=["'](?!#)/, 'no external script, stylesheet, font or image');
});

// The real public/sw.js, run against a fake Cache Storage and network.
interface FakeResponse { status: number; type: string; body: string; clone(): FakeResponse }
interface FakeRequest { url: string; method: string; mode: string; headers: { has(name: string): boolean } }
const response = (body: string, status = 200, type = 'basic'): FakeResponse => ({ status, type, body, clone() { return { ...this }; } });
const request = (url: string, init: { method?: string; mode?: string; headers?: string[] } = {}): FakeRequest => ({
  url: url.startsWith('http') ? url : `${ORIGIN}${url}`,
  method: init.method ?? 'GET',
  mode: init.mode ?? 'cors',
  headers: { has: (name) => (init.headers ?? []).includes(name.toLowerCase()) },
});
const urlOf = (value: string | { url: string }) => (typeof value === 'string' ? value : value.url);

function startWorker(network: (url: string) => Promise<FakeResponse>) {
  const listeners = new Map<string, (event: unknown) => void>();
  const stores = new Map<string, Map<string, FakeResponse>>();
  const flags = { skipWaiting: 0, claimed: 0, preload: 0 };
  const fetched: string[] = [];
  const fetchFake = (target: string | { url: string }) => { fetched.push(urlOf(target)); return network(urlOf(target)); };
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    return {
      add: async (target: { url: string }) => { store.set(target.url, await fetchFake(target)); },
      put: async (target: { url: string }, value: FakeResponse) => { store.set(target.url, value); },
      match: async (target: string | { url: string }) => store.get(urlOf(target)),
      keys: async () => [...store.keys()].map((url) => ({ url })),
      delete: async (target: { url: string }) => store.delete(target.url),
    };
  };
  const context = {
    URL,
    Promise,
    Math,
    Request: class { url: string; constructor(url: string) { this.url = url; } },
    Response: { error: () => response('', 0, 'error') },
    fetch: fetchFake,
    caches: {
      open,
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
      match: async (target: string | { url: string }) => { for (const store of stores.values()) { const hit = store.get(urlOf(target)); if (hit) return hit; } return undefined; },
    },
    self: {
      addEventListener: (type: string, listener: (event: unknown) => void) => { listeners.set(type, listener); },
      skipWaiting: async () => { flags.skipWaiting += 1; },
      clients: { claim: async () => { flags.claimed += 1; } },
      registration: { navigationPreload: { enable: async () => { flags.preload += 1; } } },
      location: { origin: ORIGIN },
    },
  };
  vm.runInNewContext(workerSource, context);
  const lifecycle = async (type: 'install' | 'activate') => {
    const waits: Array<Promise<unknown>> = [];
    listeners.get(type)!({ waitUntil: (work: Promise<unknown>) => { waits.push(work); } });
    await Promise.all(waits);
  };
  const dispatch = async (target: FakeRequest, preloadResponse?: FakeResponse) => {
    const waits: Array<Promise<unknown>> = [];
    let answer: Promise<FakeResponse> | null = null;
    listeners.get('fetch')!({
      request: target,
      preloadResponse: Promise.resolve(preloadResponse),
      respondWith: (work: Promise<FakeResponse>) => { answer = work; },
      waitUntil: (work: Promise<unknown>) => { waits.push(work); },
    });
    const result = answer ? await (answer as Promise<FakeResponse>) : null;
    await Promise.all(waits);
    return result;
  };
  const stored = (name: string) => [...(stores.get(name)?.keys() ?? [])];
  return { lifecycle, dispatch, stores, stored, flags, fetched };
}

const online = async (url: string) => response(`network:${url}`);
const offline = async (url: string): Promise<FakeResponse> => { throw new TypeError(`Failed to fetch ${url}`); };

test('worker install precaches only the offline page and takes over at once', async () => {
  const worker = startWorker(online);
  worker.stores.set('omnilume-static-v0', new Map([['old', response('old')]]));
  await worker.lifecycle('install');
  await worker.lifecycle('activate');
  assert.deepEqual(worker.stored(SW_OFFLINE_CACHE), [SW_OFFLINE_URL]);
  assert.deepEqual([...worker.stores.keys()], [SW_OFFLINE_CACHE], 'old caches are deleted on activate');
  assert.deepEqual(worker.flags, { skipWaiting: 1, claimed: 1, preload: 1 });
});

test('worker serves build files cache-first and stores only complete same-origin copies', async () => {
  const worker = startWorker(online);
  const chunk = request('/_next/static/chunks/4f1c9a7e2b.js', { mode: 'no-cors' });
  assert.equal((await worker.dispatch(chunk))?.body, `network:${chunk.url}`);
  assert.equal((await worker.dispatch(chunk))?.body, `network:${chunk.url}`);
  assert.equal(worker.fetched.length, 1, 'the second request never reaches the network');
  assert.deepEqual(worker.stored(SW_STATIC_CACHE), [chunk.url]);

  for (const [status, type] of [[404, 'basic'], [206, 'basic'], [200, 'opaque']] as const) {
    const odd = startWorker(async () => response('x', status, type));
    await odd.dispatch(chunk);
    assert.deepEqual(odd.stored(SW_STATIC_CACHE), [], `status ${status} / ${type} is not stored`);
  }
});

test('worker drops the oldest build files past the limit', async () => {
  const worker = startWorker(online);
  for (let index = 0; index < SW_STATIC_MAX_ENTRIES + 5; index += 1) await worker.dispatch(request(`/_next/static/chunks/${index}.js`));
  const kept = worker.stored(SW_STATIC_CACHE);
  assert.equal(kept.length, SW_STATIC_MAX_ENTRIES);
  assert.equal(kept[0], `${ORIGIN}/_next/static/chunks/5.js`);
});

test('worker page loads are network-first, never stored, and fall back to the offline page', async () => {
  const worker = startWorker(online);
  await worker.lifecycle('install');
  const home = request('/home', { mode: 'navigate' });
  assert.equal((await worker.dispatch(home))?.body, `network:${home.url}`);
  assert.equal((await worker.dispatch(home, response('preloaded')))?.body, 'preloaded', 'the preloaded page is used, so the page is requested once');
  assert.deepEqual(worker.stored(SW_STATIC_CACHE), []);
  assert.deepEqual(worker.stored(SW_OFFLINE_CACHE), [SW_OFFLINE_URL], 'no page was stored');

  const down = startWorker(offline);
  down.stores.set(SW_OFFLINE_CACHE, new Map([[SW_OFFLINE_URL, response('offline page')]]));
  assert.equal((await down.dispatch(home))?.body, 'offline page');
  const cold = startWorker(offline);
  assert.equal((await cold.dispatch(home))?.type, 'error', 'without the precache the browser shows its own error');
});

test('worker leaves private and uncacheable requests alone', async () => {
  const worker = startWorker(online);
  const untouched = [
    request('/api/ice-servers'),
    request('/api/internal/push', { method: 'POST' }),
    request('/auth/callback?code=one-time-code'),
    request('/home?_rsc=1a2b3'),
    request('/home', { method: 'POST' }),
    request('https://abcdefgh.supabase.co/rest/v1/messages'),
    request('https://account.r2.cloudflarestorage.com/bucket/song.flac'),
    request('/_next/static/media/intro.mp4', { headers: ['range'] }),
    request('/_next/static/chunks/4f1c9a7e2b.js', { headers: ['authorization'] }),
  ];
  for (const target of untouched) assert.equal(await worker.dispatch(target), null, target.url);
  assert.deepEqual(worker.fetched, []);
  assert.equal(worker.stores.size, 0);
});
