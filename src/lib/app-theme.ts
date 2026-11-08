/**
 * App colour themes.
 *
 * Dark purple is the default on every section: near-black, with purple in the light,
 * the accents and a faint tint. Every purple-family colour in the app stylesheets is a
 * `--pal-<hex>` variable named after the colour it was designed as (src/app/app-themes.css,
 * generated from this file). The default darkens the deep colours of that design (BASE_DEPTH);
 * a theme also turns every colour to its own hue at the same lightness, so layout, depth and
 * contrast stay the same and only the colour moves. A theme can give its bases a hue of their
 * own (a blue-black under a blue accent, a pure black under white).
 *
 * No imports on purpose: the unit tests compile this file on its own.
 */

export const APP_THEMES = ['purple', 'sections', 'mono', 'carbon', 'harbor', 'jade', 'ember', 'blush', 'orchid', 'amber'] as const;
export type AppTheme = (typeof APP_THEMES)[number];
export const DEFAULT_APP_THEME: AppTheme = 'purple';
export const APP_THEME_STORAGE_KEY = 'omnilume:theme';
/** Dispatched on window when this tab changes the theme (other tabs get a `storage` event). */
export const APP_THEME_EVENT = 'omnilume:theme-change';
/** Themes that were replaced by a close one: a device that saved the old name gets its replacement. */
const REPLACED_THEMES: Readonly<Record<string, AppTheme>> = { graphite: 'mono', ocean: 'carbon', moonlight: 'carbon', midnight: 'harbor', mint: 'jade', coral: 'ember' };

export function parseAppTheme(value: unknown): AppTheme {
  if (typeof value !== 'string') return DEFAULT_APP_THEME;
  if ((APP_THEMES as readonly string[]).includes(value)) return value as AppTheme;
  return Object.prototype.hasOwnProperty.call(REPLACED_THEMES, value) ? REPLACED_THEMES[value] : DEFAULT_APP_THEME;
}

export type AppSection = 'home' | 'search' | 'rooms' | 'room' | 'create' | 'messages' | 'music' | 'profile' | 'settings';

/** First path segment → section. Pages not listed (landing, sign-in, share, admin) keep the default purple. */
const SECTION_BY_SEGMENT: Readonly<Record<string, AppSection>> = {
  home: 'home',
  search: 'search',
  explore: 'rooms',
  room: 'room',
  'room-settings': 'room',
  'create-room': 'create',
  messages: 'messages',
  music: 'music',
  profile: 'profile',
  settings: 'settings',
};

export function sectionOf(pathname: string): AppSection | null {
  const segment = pathname.split('/')[1] ?? '';
  return Object.prototype.hasOwnProperty.call(SECTION_BY_SEGMENT, segment) ? SECTION_BY_SEGMENT[segment] : null;
}

/** What <html> carries: the section, and the theme (absent for the default and outside the app). */
export function themeAttributes(pathname: string, stored: unknown): { section: AppSection | null; appTheme: AppTheme | null } {
  const section = sectionOf(pathname);
  const theme = parseAppTheme(stored);
  return { section, appTheme: section && theme !== DEFAULT_APP_THEME ? theme : null };
}

interface AttributeTarget {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export function applyThemeAttributes(target: AttributeTarget, attributes: { section: AppSection | null; appTheme: AppTheme | null }) {
  if (attributes.section) target.setAttribute('data-section', attributes.section);
  else target.removeAttribute('data-section');
  if (attributes.appTheme) target.setAttribute('data-app-theme', attributes.appTheme);
  else target.removeAttribute('data-app-theme');
}

/**
 * Runs in <head> before the first paint, so a saved theme never flashes purple first.
 * Same rules as themeAttributes (the unit tests run both and compare).
 */
export const THEME_BOOT_SCRIPT = `(function(){var d=document.documentElement,m=${JSON.stringify(SECTION_BY_SEGMENT)},t=${JSON.stringify(APP_THEMES)},r=${JSON.stringify(REPLACED_THEMES)},v=null;try{v=localStorage.getItem(${JSON.stringify(APP_THEME_STORAGE_KEY)})}catch(e){}if(typeof v==='string'&&Object.prototype.hasOwnProperty.call(r,v))v=r[v];var s=location.pathname.split('/')[1]||'';s=Object.prototype.hasOwnProperty.call(m,s)?m[s]:'';if(s)d.setAttribute('data-section',s);else d.removeAttribute('data-section');if(s&&v!==${JSON.stringify(DEFAULT_APP_THEME)}&&t.indexOf(v)>=0)d.setAttribute('data-app-theme',v);else d.removeAttribute('data-app-theme')})()`;

// ---------- Palettes ----------

export type Palette = Exclude<AppTheme, 'purple' | 'sections'>;
export const PALETTES = ['mono', 'carbon', 'harbor', 'jade', 'ember', 'blush', 'orchid', 'amber'] as const satisfies readonly Palette[];

interface PaletteSpec {
  /** The colour the purple accent (#b9a8ff) turns into. */
  accent: string;
  /** Extra darkness for the bases, on top of the default's. */
  depth?: number;
  /** The bases' own hue (OKLCH degrees); without it they follow the accent. */
  baseHue?: number;
  /** How colourful the bases are next to the purple's (0 = neutral black). */
  baseChroma?: number;
}

/**
 * Each palette is the purple design turned to this accent. Mono, Carbon, Harbor, Jade, Ember and
 * Blush follow Vercel, GitHub, Stripe, Supabase, Raycast and Dribbble.
 */
const PALETTE_SPECS: Record<Palette, PaletteSpec> = {
  mono: { accent: '#ededed', baseChroma: 0, depth: -0.08 },
  carbon: { accent: '#58a6ff', baseHue: 255, baseChroma: 0.85 },
  harbor: { accent: '#80e9ff', baseHue: 252, baseChroma: 2.4 },
  jade: { accent: '#5fe3a7', baseChroma: 0 },
  ember: { accent: '#ff7b78', baseHue: 280, baseChroma: 0.2 },
  blush: { accent: '#ff8fb8', baseHue: 350, baseChroma: 0.35 },
  orchid: { accent: '#e8a6f2' },
  amber: { accent: '#f2c27e' },
};

export const APP_THEME_LABELS: Record<AppTheme, { label: string; note: string }> = {
  purple: { label: 'Dark purple', note: 'Default' },
  sections: { label: 'Section colours', note: 'A colour per section' },
  mono: { label: 'Mono', note: 'Pure black and white' },
  carbon: { label: 'Carbon', note: 'Blue-black, bright blue' },
  harbor: { label: 'Harbor', note: 'Deep navy, cyan' },
  jade: { label: 'Jade', note: 'Black, fresh green' },
  ember: { label: 'Ember', note: 'Cool black, warm red' },
  blush: { label: 'Blush', note: 'Black, soft pink' },
  orchid: { label: 'Orchid', note: 'Soft pink violet' },
  amber: { label: 'Amber', note: 'Warm gold' },
};

/** With "Section colours": each section's palette (null = dark purple). Music and Profile can change theirs. */
export const SECTION_PALETTE: Record<AppSection, Palette | null> = {
  home: null,
  search: 'carbon',
  rooms: 'orchid',
  room: null, // the room's own theme decides (ROOM_THEME_PALETTE)
  create: 'jade',
  messages: 'harbor',
  music: 'amber', // until a song plays: then its cover's colour (coverThemeCss)
  profile: 'ember', // until the owner picks a colour (PROFILE_COLOR_PALETTE)
  settings: 'mono',
};

/** Must match ROOM_THEMES in room-layout.ts (a unit test checks). */
export const ROOM_THEME_PALETTE: Record<'violet' | 'ocean' | 'emerald' | 'amber' | 'rose' | 'graphite', Palette | null> = {
  violet: null,
  ocean: 'carbon',
  emerald: 'jade',
  amber: 'amber',
  rose: 'ember',
  graphite: 'mono',
};

/** Stored on the profile (a database check lists them), so the names stay; each shows as its replacement theme. */
export const PROFILE_COLORS = ['coral', 'amber', 'mint', 'ocean', 'orchid', 'violet'] as const;
export type ProfileColor = (typeof PROFILE_COLORS)[number];
export const DEFAULT_PROFILE_COLOR: ProfileColor = 'coral';
export const PROFILE_COLOR_LABELS: Record<ProfileColor, string> = { coral: 'Red', amber: 'Amber', mint: 'Green', ocean: 'Blue', orchid: 'Orchid', violet: 'Violet' };
export const PROFILE_COLOR_PALETTE: Record<ProfileColor, Palette | null> = { coral: 'ember', amber: 'amber', mint: 'jade', ocean: 'carbon', orchid: 'orchid', violet: null };

export function parseProfileColor(value: unknown): ProfileColor | null {
  return typeof value === 'string' && (PROFILE_COLORS as readonly string[]).includes(value) ? (value as ProfileColor) : null;
}

/** Every purple-family colour the app stylesheets use (each is a --pal-<hex> variable). */
export const PALETTE_COLORS = [
  '06040e', '08060e', '0a0712', '0a0810', '0e0b14', '0e0b16', '14101e', '14121f', '15111e', '17121f', '17131f', '1b1530', '1d1630',
  '1e1830', '1e1b4b', '211a38', '22193e', '221a38', '221c2e', '231d36', '241d36', '28203e', '2a2048', '2a2146', '2c2442', '2e244a', '2f2449',
  '30264e', '312e81', '3a2399', '3b2c63', '3d3550', '4a3770', '4c3a73', '5b4dcf', '6447e0', '674b8e', '6c6582', '746c8f',
  '7bb8ff', '7c5cff', '7c6cf0', '8574ff', '8b5cf6', '8b6cff', '8d7bff', '8f6fb4', '948daa', '9678ff', '9a74a8', '9c95b1', '9d86ff', 'a39cb8',
  'a585c4', 'a78bfa', 'a855f7', 'a893ff', 'b3abc6', 'b9a8ff', 'bdb5d0', 'c084fc','c4b5fd', 'c7d2fe', 'c8baff', 'c999a8', 'c9bcff',
  'cdc6dc', 'cec0ff', 'cfc3ff', 'cfc5ff', 'cfc6ff', 'd4ccff', 'd6a6b8', 'd6ccff', 'd8b4fe', 'd9d0ff', 'dcd0ff', 'ddd6fe', 'ded9ff', 'e0e7ff',
  'e4dff0', 'ece8ff', 'ece9ff', 'ede9fe', 'efeaff', 'f1efff', 'f3e8ff', 'f5f3ff',
] as const;

// ---------- Colour maths (sRGB ↔ OKLCH) ----------

type Rgb = [number, number, number];
export type Lch = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const value = hex.replace('#', '');
  return [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16)) as Rgb;
}

export function rgbToHex(rgb: Rgb) {
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

const toLinear = (channel: number) => { const v = channel / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const fromLinear = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055) * 255;

export function rgbToLch(rgb: Rgb): Lch {
  const [r, g, b] = rgb.map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360];
}

function lchToLinear([L, C, h]: Lch): Rgb {
  const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (linear: Rgb) => linear.every((v) => v >= -1e-5 && v <= 1 + 1e-5);

/** Nearest sRGB colour: keeps lightness and hue, lowers chroma until it fits. */
export function lchToRgb([L, C, h]: Lch): Rgb {
  const lightness = Math.min(1, Math.max(0, L));
  let chroma = C;
  if (!inGamut(lchToLinear([lightness, chroma, h]))) {
    let low = 0, high = C;
    for (let step = 0; step < 24; step += 1) {
      const mid = (low + high) / 2;
      if (inGamut(lchToLinear([lightness, mid, h]))) low = mid; else high = mid;
    }
    chroma = low;
  }
  return lchToLinear([lightness, chroma, h]).map((v) => Math.round(Math.min(255, Math.max(0, fromLinear(Math.min(1, Math.max(0, v))))))) as Rgb;
}

/** The colour every palette is measured from: the default accent. */
const ANCHOR = rgbToLch(hexToRgb('#b9a8ff'));
/** The hue of the design's base, which a palette's `baseHue` replaces. */
const BASE_HUE = rgbToLch(hexToRgb('#0e0b14'))[2];
/**
 * Every theme is darker than the design: deep colours lose this much OKLCH lightness at black,
 * less as they get lighter and none from L 0.5, so surfaces keep their steps (base #0e0b14 → #050408).
 */
const BASE_DEPTH = -0.075;
/** The default's bases keep this much of their purple: black first, purple second. */
const BASE_CHROMA = 0.75;

type Shift = (colour: Lch) => Lch;

/** Turns the purple design to `target` (an accent in OKLCH): same lightness, hue and chroma moved like the accent's. */
function shiftTo(target: Lch, { depth = 0, baseHue, baseChroma }: Omit<PaletteSpec, 'accent'> = {}): Shift {
  const hueShift = target[2] - ANCHOR[2];
  const chromaScale = target[1] / ANCHOR[1];
  const lift = target[0] - ANCHOR[0];
  const darken = BASE_DEPTH + depth;
  return ([L, C, h]) => {
    // Accents and text move with the accent's lightness in proportion to how colourful they are.
    if (L >= 0.5) return [Math.min(0.985, L + lift * Math.min(1, C / ANCHOR[1])), C * chromaScale, (h + hueShift + 360) % 360];
    const nextL = Math.max(0, L + darken * (1 - L / 0.5));
    if (L >= 0.4) return [nextL, C * chromaScale, (h + hueShift + 360) % 360];
    // Bases: their own hue and colourfulness when the palette sets them.
    const hue = baseHue === undefined ? h + hueShift : h - BASE_HUE + baseHue;
    return [nextL, C * (baseChroma ?? BASE_CHROMA * chromaScale), (hue + 360) % 360];
  };
}

const DEFAULT_SHIFT = shiftTo(ANCHOR);
const PALETTE_SHIFTS = Object.fromEntries(PALETTES.map((palette) => {
  const { accent, ...bases } = PALETTE_SPECS[palette];
  return [palette, shiftTo(rgbToLch(hexToRgb(accent)), bases)];
})) as Record<Palette, Shift>;
const shiftFor = (palette: Palette | null) => (palette ? PALETTE_SHIFTS[palette] : DEFAULT_SHIFT);

function shiftedRgb(hex: string, shift: Shift): Rgb {
  return lchToRgb(shift(rgbToLch(hexToRgb(hex))));
}

/** A design colour as it looks in a palette (null = the default dark purple). */
export function paletteColor(hex: string, palette: Palette | null) {
  return rgbToHex(shiftedRgb(hex, shiftFor(palette)));
}

function paletteDeclarations(shift: Shift) {
  return PALETTE_COLORS.map((hex) => `--pal-${hex}: ${shiftedRgb(hex, shift).join(' ')};`).join(' ');
}

/** The light that sets a cover's colour: how far a hue's accent sits above the purple's (yellows look dull at equal lightness). */
function coverLift(hue: number) {
  const distance = Math.min(Math.abs(hue - 95), 360 - Math.abs(hue - 95));
  return 0.06 * Math.max(0, 1 - distance / 55);
}

/** OKLCH hue of a track's stored cover hue (an HSL hue, sampled at upload). */
export function coverAccent(hslHue: number): Lch {
  const hue = ((Math.round(hslHue) % 360) + 360) % 360;
  const c = 0.7 * (1 - Math.abs(2 * 0.6 - 1));
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = 0.6 - c / 2;
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  const oklchHue = rgbToLch([r, g, b].map((v) => Math.round((v + m) * 255)) as Rgb)[2];
  return [ANCHOR[0] + coverLift(oklchHue), ANCHOR[1], oklchHue];
}

const coverCache = new Map<number, string>();

/** Music with "Section colours": the page takes the playing song's cover colour. */
export function coverThemeCss(hslHue: number) {
  const key = ((Math.round(hslHue) % 360) + 360) % 360;
  let css = coverCache.get(key);
  if (!css) {
    css = `:root[data-app-theme="sections"][data-section="music"]{${paletteDeclarations(shiftTo(coverAccent(key)))}}`;
    coverCache.set(key, css);
  }
  return css;
}

function paletteSelectors(palette: Palette | null) {
  const selectors: string[] = palette ? [`html[data-app-theme="${palette}"]`] : [];
  for (const [section, value] of Object.entries(SECTION_PALETTE)) {
    if (palette && value === palette) selectors.push(`html[data-app-theme="sections"][data-section="${section}"]`);
  }
  for (const [roomTheme, value] of Object.entries(ROOM_THEME_PALETTE)) {
    if (palette && value === palette) selectors.push(`html[data-app-theme="sections"][data-section="room"][data-room-theme="${roomTheme}"]`);
  }
  for (const [color, value] of Object.entries(PROFILE_COLOR_PALETTE)) {
    // Violet resets the profile to the default purple, so it needs its own rule.
    if (value === palette) selectors.push(`html[data-app-theme="sections"][data-section="profile"][data-profile-color="${color}"]`);
  }
  return selectors;
}

/** The whole of src/app/app-themes.css. Regenerate with scripts/write-app-themes-css.mjs after changing anything above. */
export function renderThemeCss() {
  const lines = [
    '/* Generated from src/lib/app-theme.ts by scripts/write-app-themes-css.mjs. Do not edit by hand. */',
    '/* Defaults: the dark purple theme. */',
    `:root { ${paletteDeclarations(DEFAULT_SHIFT)} }`,
  ];
  for (const palette of [...PALETTES, null]) {
    const selectors = paletteSelectors(palette);
    if (selectors.length === 0) continue;
    lines.push(`/* ${palette ? APP_THEME_LABELS[palette].label : 'Dark purple'} */`);
    lines.push(`${selectors.join(',\n')} { ${paletteDeclarations(shiftFor(palette))} }`);
  }
  return `${lines.join('\n')}\n`;
}

/** Colours for the theme picker's preview: base, raised surface and accent. */
export function themeSwatch(palette: Palette | null) {
  return { base: paletteColor('0e0b14', palette), surface: paletteColor('231d36', palette), accent: paletteColor('b9a8ff', palette) };
}

/** Accents of every section, in dock order, for the "Section colours" preview. */
export function sectionAccents() {
  return (['home', 'search', 'rooms', 'create', 'messages', 'music', 'profile', 'settings'] as const).map((section) => paletteColor('b9a8ff', SECTION_PALETTE[section]));
}

export function contrastRatio(foreground: string, background: string) {
  const luminance = (hex: string) => {
    const [r, g, b] = hexToRgb(hex).map(toLinear);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [a, b] = [luminance(foreground), luminance(background)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}
