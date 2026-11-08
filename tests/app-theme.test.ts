import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {
  APP_THEMES,
  PALETTES,
  PALETTE_COLORS,
  PROFILE_COLORS,
  ROOM_THEME_PALETTE,
  SECTION_PALETTE,
  THEME_BOOT_SCRIPT,
  contrastRatio,
  coverAccent,
  coverThemeCss,
  hexToRgb,
  paletteColor,
  parseAppTheme,
  parseProfileColor,
  renderThemeCss,
  rgbToLch,
  sectionAccents,
  sectionOf,
  themeAttributes,
  type Palette,
} from '../src/lib/app-theme.js';
import { ROOM_THEMES } from '../src/lib/room-layout.js';

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
// Everything that draws the app's purple: every app stylesheet (shared ones and each
// section's CSS module), and the room card art (SVG). The landing keeps its own brand colours,
// and app-themes.css is the generated theme file itself.
const NOT_THEMED = new Set(['src/app/landing.module.css', 'src/components/landing/hero-app.css', 'src/components/landing/use-case.module.css', 'src/app/app-themes.css']);
function cssFiles(directory: string): string[] {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith('.css') && !NOT_THEMED.has(path) ? [path] : [];
  });
}
const STYLESHEETS = [...cssFiles('src/app'), ...cssFiles('src/components'), 'src/components/ui/RoomArt.tsx'];

test('each app path maps to its section, and nothing else does', () => {
  const cases: [string, string | null][] = [
    ['/home', 'home'], ['/search', 'search'], ['/explore', 'rooms'], ['/room/8f0c', 'room'], ['/room-settings', 'room'],
    ['/create-room', 'create'], ['/messages', 'messages'], ['/music', 'music'], ['/music/album/1', 'music'],
    ['/profile', 'profile'], ['/profile/abc', 'profile'], ['/settings', 'settings'],
    ['/', null], ['', null], ['/login', null], ['/watch-together', null], ['/share', null], ['/homework', null],
    // Inherited object keys are not sections.
    ['/constructor', null], ['/__proto__', null], ['/toString', null], ['/hasOwnProperty', null],
  ];
  for (const [path, section] of cases) assert.equal(sectionOf(path), section, path);
});

test('only known themes are accepted; anything else is the default purple', () => {
  for (const theme of APP_THEMES) assert.equal(parseAppTheme(theme), theme);
  for (const value of [null, undefined, '', 'Purple', 'dark', 'sections ', 42, {}]) assert.equal(parseAppTheme(value), 'purple');
});

test('the default theme and pages outside the app carry no theme attribute', () => {
  assert.deepEqual(themeAttributes('/home', null), { section: 'home', appTheme: null });
  assert.deepEqual(themeAttributes('/home', 'purple'), { section: 'home', appTheme: null });
  assert.deepEqual(themeAttributes('/home', 'amber'), { section: 'home', appTheme: 'amber' });
  assert.deepEqual(themeAttributes('/', 'amber'), { section: null, appTheme: null });
  assert.deepEqual(themeAttributes('/login', 'sections'), { section: null, appTheme: null });
});

test('the boot script sets exactly what the app sets after hydration', () => {
  const paths = ['/', '/home', '/music/album/1', '/explore', '/login', '/constructor', '/room/x', '/settings'];
  const stored = [null, 'purple', 'sections', 'amber', 'graphite', 'bogus', '__proto__'];
  for (const path of paths) {
    for (const value of [...stored, 'THROWS']) {
      const attributes = new Map<string, string>([['data-section', 'stale'], ['data-app-theme', 'stale']]);
      const documentElement = {
        setAttribute: (name: string, next: string) => attributes.set(name, next),
        removeAttribute: (name: string) => attributes.delete(name),
      };
      const localStorage = { getItem: () => { if (value === 'THROWS') throw new Error('blocked'); return value; } };
      vm.runInNewContext(THEME_BOOT_SCRIPT, { document: { documentElement }, localStorage, location: { pathname: path } });
      const expected = themeAttributes(path, value === 'THROWS' ? null : value);
      assert.equal(attributes.get('data-section') ?? null, expected.section, `${path} ${value} section`);
      assert.equal(attributes.get('data-app-theme') ?? null, expected.appTheme, `${path} ${value} theme`);
    }
  }
});

test('app-themes.css is generated from app-theme.ts and up to date', () => {
  assert.equal(
    // Git may check the file out with CRLF line endings on Windows.
    read('src/app/app-themes.css').replace(/\r\n/g, '\n'),
    renderThemeCss(),
    'Run `npm run test:unit` (compiles the theme module), then `node scripts/write-app-themes-css.mjs`.',
  );
});

test('every palette variable the stylesheets use exists, and none is unused', () => {
  const used = new Set<string>();
  for (const file of STYLESHEETS) for (const match of read(file).matchAll(/--pal-([0-9a-f]{6})|pal\('([0-9a-f]{6})'\)/g)) used.add(match[1] ?? match[2]);
  const known = new Set<string>(PALETTE_COLORS);
  assert.deepEqual([...used].filter((hex) => !known.has(hex)), [], 'Add new purple colours to PALETTE_COLORS.');
  assert.deepEqual([...known].filter((hex) => !used.has(hex)), [], 'Remove palette colours nothing uses.');
});

test('no purple is written as a plain colour in the app stylesheets, so every theme reaches it', () => {
  const offenders: string[] = [];
  const literal = /#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b|rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/g;
  for (const file of STYLESHEETS) {
    read(file).split('\n').forEach((line, index) => {
      // A room's own theme is the owner's choice and must not follow the app theme.
      if (/data-room-theme|room-theme-swatch/.test(line)) return;
      for (const match of line.matchAll(literal)) {
        const rgb = match[1]
          ? hexToRgb((match[1].length === 3 ? [...match[1]].map((c) => c + c).join('') : match[1]).slice(0, 6))
          : [Number(match[2]), Number(match[3]), Number(match[4])] as [number, number, number];
        const [, chroma, hue] = rgbToLch(rgb);
        if (chroma > 0.016 && hue >= 250 && hue <= 335) offenders.push(`${file}:${index + 1} ${match[0]}`);
      }
    });
  }
  assert.deepEqual(offenders, [], 'Write purple colours as rgb(var(--pal-<hex>)) and list the hex in PALETTE_COLORS.');
});

test('the default theme is the dark purple, a step darker than before', () => {
  for (const hex of PALETTE_COLORS) assert.equal(paletteColor(hex, null), `#${hex}`);
  const globals = read('src/app/globals.css');
  assert.match(globals, /--omni-bg: rgb\(var\(--pal-0e0b14\)\);/);
  assert.match(globals, /--omni-bg-raised: rgb\(var\(--pal-17131f\)\);/);
  assert.match(globals, /--color-neutral-950: rgb\(var\(--pal-0e0b14\)\);/);
  assert.ok(rgbToLch(hexToRgb('0e0b14'))[0] < rgbToLch(hexToRgb('15111e'))[0]);
});

function checkReadable(name: string, colour: (hex: string) => string) {
  const base = colour('0e0b14'), raised = colour('231d36');
  assert.ok(contrastRatio(colour('b9a8ff'), base) >= 7, `${name}: accent on base`);
  assert.ok(contrastRatio(colour('bdb5d0'), base) >= 7, `${name}: secondary text on base`);
  assert.ok(contrastRatio(colour('a39cb8'), base) >= 4.5, `${name}: muted text on base`);
  assert.ok(contrastRatio(colour('a39cb8'), raised) >= 4.5, `${name}: muted text on a raised surface`);
  assert.ok(contrastRatio(colour('0e0b14'), colour('b9a8ff')) >= 7, `${name}: dark text on accent buttons`);
  assert.ok(contrastRatio(colour('0e0b14'), colour('c9bcff')) >= 7, `${name}: dark text on the button gradient`);
}

test('every palette keeps text and accents readable', () => {
  checkReadable('purple', (hex) => paletteColor(hex, null));
  for (const palette of PALETTES) checkReadable(palette, (hex) => paletteColor(hex, palette));
});

test('every cover colour keeps text and accents readable', () => {
  for (let hue = 0; hue < 360; hue += 5) {
    const css = coverThemeCss(hue);
    const value = (hex: string) => {
      const match = css.match(new RegExp(`--pal-${hex}: (\\d+) (\\d+) (\\d+);`));
      assert.ok(match, `${hue}: ${hex}`);
      return `#${match.slice(1).map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
    };
    checkReadable(`cover ${hue}`, value);
  }
  assert.match(coverThemeCss(30), /^:root\[data-app-theme="sections"\]\[data-section="music"\]\{/);
  assert.equal(coverThemeCss(390), coverThemeCss(30));
});

test('palettes differ only in hue: bases stay as deep and accents as light as the purple', () => {
  const purpleBase = rgbToLch(hexToRgb('0e0b14'))[0];
  const accents = PALETTES.filter((palette) => palette !== 'graphite').map((palette) => rgbToLch(hexToRgb(paletteColor('b9a8ff', palette))));
  for (const palette of PALETTES) {
    const base = rgbToLch(hexToRgb(paletteColor('0e0b14', palette)))[0];
    assert.ok(Math.abs(base - purpleBase) <= (palette === 'midnight' ? 0.03 : 0.005), `${palette} base depth`);
  }
  for (const [lightness] of accents) assert.ok(lightness > 0.74 && lightness < 0.9, 'accent lightness');
  // Every colourful palette sits at least 20 degrees from the others and from purple.
  const hues = [rgbToLch(hexToRgb('b9a8ff'))[2], ...accents.map(([, , hue]) => hue)];
  for (let i = 0; i < hues.length; i += 1) {
    for (let j = i + 1; j < hues.length; j += 1) {
      const gap = Math.min(Math.abs(hues[i] - hues[j]), 360 - Math.abs(hues[i] - hues[j]));
      assert.ok(gap >= 20, `hues ${i} and ${j} are ${gap.toFixed(1)} degrees apart`);
    }
  }
  assert.ok(rgbToLch(hexToRgb(paletteColor('b9a8ff', 'graphite')))[1] < 0.03, 'graphite has almost no colour');
});

test('cover colours follow the cover hue', () => {
  const [, , red] = coverAccent(0), [, , blue] = coverAccent(220), [, , green] = coverAccent(130);
  assert.ok(red < 40 || red > 340, `red cover → ${red}`);
  assert.ok(blue > 230 && blue < 270, `blue cover → ${blue}`);
  assert.ok(green > 120 && green < 160, `green cover → ${green}`);
});

test('section, room and profile colours point at real palettes', () => {
  const palettes = new Set<Palette | null>([...PALETTES, null]);
  for (const value of Object.values(SECTION_PALETTE)) assert.ok(palettes.has(value));
  assert.deepEqual(Object.keys(ROOM_THEME_PALETTE).sort(), [...ROOM_THEMES].sort());
  for (const color of PROFILE_COLORS) assert.equal(parseProfileColor(color), color);
  for (const value of [null, '', 'Coral', 'pink', 7, 'violet ']) assert.equal(parseProfileColor(value), null);
  assert.equal(sectionAccents().length, 8);
  const css = renderThemeCss();
  assert.match(css, /html\[data-app-theme="sections"\]\[data-section="search"\]/);
  assert.match(css, /html\[data-app-theme="sections"\]\[data-section="room"\]\[data-room-theme="ocean"\]/);
  assert.match(css, /html\[data-app-theme="sections"\]\[data-section="profile"\]\[data-profile-color="violet"\]/);
  assert.doesNotMatch(css, /data-section="home"/, 'Home keeps the default purple');
});
