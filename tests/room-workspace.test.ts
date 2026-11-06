import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  DEFAULT_ROOM_APPEARANCE,
  ROOM_LAYOUTS,
  ROOM_THEMES,
  appearanceFromSettings,
  effectiveActivity,
  effectiveLayout,
  effectiveTheme,
  effectiveTool,
} from '../src/lib/room-layout.js';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');

test('owner settings parse safely and drive the effective layout and theme', () => {
  assert.deepEqual(appearanceFromSettings(null), DEFAULT_ROOM_APPEARANCE);
  assert.deepEqual(appearanceFromSettings({ default_layout: 'grid', layout_locked: 'yes', theme: 'neon' }), DEFAULT_ROOM_APPEARANCE);
  const owner = appearanceFromSettings({ default_layout: 'chat', layout_locked: false, theme: 'ocean' });
  assert.equal(effectiveLayout(owner, null), 'chat');
  assert.equal(effectiveLayout(owner, 'stage'), 'stage');
  assert.equal(effectiveLayout(owner, 'nonsense'), 'chat');
  assert.equal(effectiveLayout({ ...owner, layoutLocked: true }, 'stage'), 'chat', 'a locked room ignores personal presets');
  assert.equal(effectiveTheme(owner, null), 'ocean');
  assert.equal(effectiveTheme(owner, 'rose'), 'rose');
});

test('disabled features never open an empty stage or panel', () => {
  assert.equal(effectiveActivity('watch', { watch: false }), 'home');
  assert.equal(effectiveActivity('whiteboard', { study: false }), 'home');
  assert.equal(effectiveActivity('study', { watch: false }), 'study');
  assert.equal(effectiveActivity('home', {}), 'home');
  assert.equal(effectiveTool('chat', { chat: false }), 'members');
  assert.equal(effectiveTool('files', { files: false }), 'chat');
  assert.equal(effectiveTool('files', { files: false, chat: false }), 'members');
  assert.equal(effectiveTool('members', { chat: false, files: false }), 'members');
});

test('the database checks match the client lists and only manage_settings may change them', () => {
  const sql = read('supabase/migrations/20261105190000_action09_room_layout_theme.sql');
  assert.ok(sql.includes(`CHECK (default_layout IN (${ROOM_LAYOUTS.map((value) => `'${value}'`).join(', ')}))`));
  assert.ok(sql.includes(`CHECK (theme IN (${ROOM_THEMES.map((value) => `'${value}'`).join(', ')}))`));
  assert.match(sql, /NOT public\.room_has_capability\(p_room_id, auth\.uid\(\), 'manage_settings'\)/);
  assert.match(sql, /SECURITY DEFINER\nSET search_path = ''/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.update_room_appearance\(uuid, text, boolean, text\) FROM PUBLIC, anon;\nGRANT EXECUTE ON FUNCTION public\.update_room_appearance\(uuid, text, boolean, text\) TO authenticated;/);
  assert.match(sql, /record_room_control_event\(p_room_id, 'settings_changed'/);
});

test('one desk window per feature; chat, media and study stay mounted while closed', () => {
  const page = read('src/app/room/[id]/page.tsx');
  assert.equal((page.match(/<RoomChat /g) ?? []).length, 1);
  assert.equal((page.match(/<MediaStage /g) ?? []).length, 1);
  assert.equal((page.match(/<StudyStage /g) ?? []).length, 1);
  assert.equal((page.match(/<RoomDesk\b/g) ?? []).length, 1);
  // Playback, the shared timer and the chat keep running when their window closes.
  for (const id of ['watch', 'study', 'chat']) assert.match(page, new RegExp(`id: '${id}', open: isOpen\\('${id}'\\), keepMounted: featureEnabled\\(`), id);
  // Personal layout, theme, the open windows and their boxes are keyed by room and user.
  for (const key of ["'layout'", "'theme'", "'desk'", "'desk-windows'"]) {
    assert.ok(page.includes(`roomWorkspacePreferenceKey(roomData?.id ?? '', roomSync.currentUserId, ${key})`), key);
  }
  const desk = read('src/components/room/RoomDesk.tsx');
  assert.match(desk, /windows\.filter\(\(w\) => w\.open \|\| w\.keepMounted\)/, 'closed kept-mounted windows are still rendered');
  const css = read('src/app/app.css');
  assert.match(css, /\.desk-win\[data-open="false"\] \{ visibility: hidden; pointer-events: none; \}/, 'closed windows are hidden, not unmounted');
  assert.match(css, /@media \(max-width: 767px\) \{[^}]*\n  \.room-shell \{ height: auto; min-height: 100dvh; overflow: visible; \}/, 'phones scroll one stacked column');
});

test('gestures paint once per frame and commit to state on release', () => {
  const desk = read('src/components/room/RoomDesk.tsx');
  assert.match(desk, /requestAnimationFrame\(\(\) => \{ g\.frame = 0; paintWindow\(/);
  assert.match(desk, /const onGestureEnd[\s\S]*setBoxes\(next\);\s*persist\(next\);/);
  assert.match(desk, /setPointerCapture\(event\.pointerId\)/);
  assert.doesNotMatch(desk, /onPointerMove=\{[^}]*setBoxes/, 'no React state per pointer move');
});
