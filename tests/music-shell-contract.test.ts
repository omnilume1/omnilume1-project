import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { isAuthRequiredPath } from '../src/lib/auth.js';
import { musicShortcutFor, type ShortcutEvent } from '../src/lib/music-shortcuts.js';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

test('/music and everything under it requires sign-in', () => {
  assert.equal(isAuthRequiredPath('/music'), true);
  assert.equal(isAuthRequiredPath('/music/album/glass-harbour'), true);
  assert.equal(isAuthRequiredPath('/musical'), false);
});

test('music CSS is scoped to .music-app and globals.css is untouched', () => {
  const css = read('src/app/music/music.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = [...css.matchAll(/(^|})\s*([^{}@]+)\{/g)].map((match) => match[2].trim()).filter((selector) => !/^(from|to|\d+%)$/.test(selector));
  assert.ok(selectors.length > 50);
  for (const selector of selectors) {
    for (const part of selector.split(',')) {
      assert.match(part.trim(), /^\.music-app\b/, `unscoped selector: ${part.trim()}`);
    }
  }
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /saturate\(2\.2\) blur\(16px\)/);
  // Lightning CSS merges a hand-written -webkit- copy with the standard one and keeps only the prefix (Chrome then shows no blur).
  assert.doesNotMatch(css, /-webkit-backdrop-filter/);
  assert.match(css, /--mu-key: #b9a8ff/);
  const globals = read('src/app/globals.css');
  assert.doesNotMatch(globals, /music-app|--mu-/);
});

test('DM Sans loads only in the music layout; the player provider lives in the root layout', () => {
  assert.match(read('src/app/music/layout.tsx'), /DM_Sans\(/);
  const root = read('src/app/layout.tsx');
  assert.doesNotMatch(root, /DM_Sans/);
  assert.match(root, /<MusicPlayerProvider>/);
  assert.match(root, /<GlobalMiniPlayer \/>/);
});

const key = (overrides: Partial<ShortcutEvent>): ShortcutEvent => ({ key: ' ', metaKey: false, ctrlKey: false, altKey: false, target: { tagName: 'BODY' }, ...overrides });

test('shortcuts map keys and never fire while typing', () => {
  assert.equal(musicShortcutFor(key({})), 'toggle');
  assert.equal(musicShortcutFor(key({ key: 'ArrowRight', ctrlKey: true })), 'next');
  assert.equal(musicShortcutFor(key({ key: 'ArrowLeft', metaKey: true })), 'previous');
  assert.equal(musicShortcutFor(key({ key: 'ArrowUp', ctrlKey: true })), 'volumeUp');
  assert.equal(musicShortcutFor(key({ key: 'F', ctrlKey: true })), 'search');
  assert.equal(musicShortcutFor(key({ key: '/' })), 'search');
  assert.equal(musicShortcutFor(key({ key: 'Escape' })), 'escape');
  assert.equal(musicShortcutFor(key({ key: 'ArrowRight' })), null, 'arrows need the modifier');
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
    assert.equal(musicShortcutFor(key({ target: { tagName } })), null);
    assert.equal(musicShortcutFor(key({ key: 'Escape', target: { tagName } })), null);
  }
  assert.equal(musicShortcutFor(key({ target: { tagName: 'DIV', isContentEditable: true } })), null);
  assert.equal(musicShortcutFor(key({ target: { tagName: 'BUTTON' } })), null, 'Space activates a focused button');
  assert.equal(musicShortcutFor(key({ target: { tagName: 'DIV', getAttribute: () => 'slider' } })), null);
  assert.equal(musicShortcutFor(key({ key: 'ArrowRight', ctrlKey: true, target: { tagName: 'BUTTON' } })), 'next');
});
