import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { APP_SHELL_COLOR, HOME_ROWS_BOOT_SCRIPT, HOME_ROWS_KEY, homeRowsHold } from '../src/lib/app-shell.js';
import { paletteColor } from '../src/lib/app-theme.js';

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

test('the app shell colour is the page colour the default theme paints', () => {
  assert.equal(APP_SHELL_COLOR, paletteColor('0e0b14', null), 'splash, system bars and first paint must be one colour');
});

test('manifest, viewport and offline page all use the app shell colour', () => {
  const manifest = read('src/app/manifest.ts');
  assert.match(manifest, /background_color: APP_SHELL_COLOR/);
  assert.match(manifest, /theme_color: APP_SHELL_COLOR/);
  assert.match(read('src/app/layout.tsx'), /themeColor: APP_SHELL_COLOR/);
  const offline = read('public/offline.html');
  assert.match(offline, new RegExp(`background: ${APP_SHELL_COLOR};`));
  assert.match(offline, new RegExp(`name="theme-color" content="${APP_SHELL_COLOR}"`));
});

test('manifest keeps existing installs, never locks rotation, and its files exist', () => {
  const manifest = read('src/app/manifest.ts');
  assert.match(manifest, /id: '\/home'/);
  assert.match(manifest, /start_url: '\/home'/);
  assert.doesNotMatch(manifest, /^\s*orientation:/m, 'full-screen video must be free to rotate');
  assert.match(manifest, /share_target:/);
  const icons = ['icon-192', 'icon-512', 'icon-maskable-512', 'badge-96', 'shortcut-home', 'shortcut-rooms', 'shortcut-messages', 'shortcut-music'];
  for (const name of icons) assert.ok(existsSync(resolve(root, `public/icons/${name}.png`)), `${name}.png`);
});

// The app is installed directly (no Play Store), so it is signed by one key: android/android.keystore,
// which never leaves the owner's machine. If it ever goes to Play, add the Play App Signing
// fingerprint as a second entry.
test('asset links name the Android package and its signing key', () => {
  const links = JSON.parse(read('public/.well-known/assetlinks.json')) as Array<{ relation: string[]; target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] } }>;
  assert.equal(links.length, 1);
  assert.deepEqual(links[0].relation, ['delegate_permission/common.handle_all_urls']);
  assert.equal(links[0].target.namespace, 'android_app');
  assert.equal(links[0].target.package_name, 'com.omnilume.app');
  const fingerprints = links[0].target.sha256_cert_fingerprints;
  assert.ok(fingerprints.length === 1 || fingerprints.length === 2, 'the signing key, plus the Play App Signing key if the app is ever on Play');
  for (const fingerprint of fingerprints) assert.match(fingerprint, /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/, 'a real SHA-256 fingerprint, not a placeholder');
});

test('Home placeholder heights come only from a real row count', () => {
  assert.equal(homeRowsHold(0), '21px');
  assert.equal(homeRowsHold(1), '50px');
  assert.equal(homeRowsHold(4), '206px');
  assert.equal(homeRowsHold(5), '258px');
  for (const bad of [-1, 6, 2.5, '4', null, undefined, Number.NaN, Infinity, {}, [3]]) assert.equal(homeRowsHold(bad), null, String(bad));
});

test('the head script sets the placeholder heights and survives bad storage', () => {
  const run = (stored: string | null | Error) => {
    const set: Record<string, string> = {};
    vm.runInNewContext(HOME_ROWS_BOOT_SCRIPT, {
      localStorage: { getItem: (key: string) => { assert.equal(key, HOME_ROWS_KEY); if (stored instanceof Error) throw stored; return stored; } },
      document: { documentElement: { style: { setProperty: (name: string, value: string) => { set[name] = value; } } } },
    });
    return set;
  };
  assert.deepEqual(run(JSON.stringify({ friends: 4, rooms: 3 })), { '--home-friends-hold': homeRowsHold(4), '--home-rooms-hold': homeRowsHold(3) });
  assert.deepEqual(run(JSON.stringify({ friends: 0 })), { '--home-friends-hold': '21px' });
  for (const bad of [null, '', 'not json', 'null', '5', '[]', JSON.stringify({ friends: '4', rooms: 99 }), JSON.stringify({ friends: -1, rooms: 1.5 }), new Error('storage blocked')]) {
    assert.deepEqual(run(bad), {}, String(bad));
  }
  assert.doesNotMatch(HOME_ROWS_BOOT_SCRIPT, /<\/script/i);
});

test('the Android shell matches the web app and can show notifications', () => {
  const twa = JSON.parse(read('android/twa-manifest.json')) as Record<string, unknown> & { signingKey: { path: string }; features: Record<string, unknown> };
  assert.equal(twa.packageId, 'com.omnilume.app');
  assert.equal(twa.host, 'omnilume.vercel.app');
  assert.equal(twa.startUrl, '/home');
  assert.equal(twa.name, 'OmniLume');
  assert.equal(twa.launcherName, 'OmniLume');
  for (const key of ['themeColor', 'themeColorDark', 'navigationColor', 'navigationColorDark', 'backgroundColor']) {
    assert.equal(String(twa[key]).toLowerCase(), APP_SHELL_COLOR, `${key}: splash and system bars are the page colour`);
  }
  assert.equal(twa.enableNotifications, true, 'notification delegation on');
  assert.equal(twa.features.locationDelegation, undefined, 'location delegation off');
  assert.equal(twa.fallbackType, 'customtabs');
  assert.equal(twa.orientation, 'default', 'full-screen video must be free to rotate');
  assert.equal(twa.signingKey.path, './android.keystore', 'a relative path, so no machine path is committed');

  const androidManifest = read('android/app/src/main/AndroidManifest.xml');
  assert.match(androidManifest, /android\.permission\.POST_NOTIFICATIONS/, 'Android 13+ notification permission');
  assert.match(androidManifest, /<intent-filter android:autoVerify="true">/, 'room and invite links open in the app');
  assert.doesNotMatch(androidManifest, /ACCESS_(?:FINE|COARSE)_LOCATION/);
  const links = JSON.parse(read('public/.well-known/assetlinks.json')) as Array<{ target: { package_name: string } }>;
  assert.equal(links[0].target.package_name, twa.packageId);
  // `bubblewrap build` asks to regenerate the project when this checksum is stale.
  const checksum = createHash('sha1').update(readFileSync(resolve(root, 'android/twa-manifest.json'))).digest('hex');
  assert.equal(read('android/manifest-checksum.txt'), checksum, 'android/ must stay byte-exact (see .gitattributes)');
});

test('signing keys and Android build output can never be committed', () => {
  const ignored = read('.gitignore').split(/\r?\n/);
  for (const pattern of ['*.keystore', '*.jks', 'android/app/build/', 'android/.gradle/', 'android/local.properties']) assert.ok(ignored.includes(pattern), pattern);
  assert.match(read('.gitattributes'), /^android\/\*\* -text$/m);
});

test('the proxy skips the files that must never redirect to /login', () => {
  const source = read('src/proxy.ts');
  const pattern = /matcher: \[\s*(?:\/\/[^\n]*\n\s*)*'([^']+)'/.exec(source)?.[1];
  assert.ok(pattern, 'matcher found');
  const matcher = new RegExp(`^${pattern!.replace(/\\\\/g, '\\')}$`);
  const skipped = ['/.well-known/assetlinks.json', '/sw.js', '/offline.html', '/manifest.webmanifest', '/api/internal/push', '/api/internal/cleanup-expired-rooms', '/_next/static/chunks/a.js', '/icons/icon-192.png'];
  const handled = ['/', '/home', '/messages', '/room/abc', '/login', '/auth/callback', '/api/ice-servers', '/share', '/sw.json', '/offline.html/x', '/api/internalx'];
  for (const path of skipped) assert.equal(matcher.test(path), false, `${path} skips the proxy`);
  for (const path of handled) assert.equal(matcher.test(path), true, `${path} still goes through the proxy`);
});

test('touch-only styles never reach a desktop pointer', () => {
  const css = read('src/app/app.css');
  const touchBlock = css.slice(css.indexOf('/* Touch devices: phones, tablets and the Android app.'));
  assert.ok(touchBlock.length > 0 && touchBlock.length < css.length, 'touch block found at the end of app.css');
  const outside = touchBlock.replace(/@media [^{]*\(hover: none\) and \(pointer: coarse\)[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
  assert.equal(outside, '', 'every rule in the touch block sits inside a (hover: none) and (pointer: coarse) query');
});
