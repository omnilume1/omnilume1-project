import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  DEFAULT_ROOM_APPEARANCE,
  HOME_CHAT_WIDTH,
  ROOM_LAYOUTS,
  ROOM_THEMES,
  appearanceFromSettings,
  clampHomeChatWidth,
  effectiveActivity,
  effectiveLayout,
  effectiveTheme,
  effectiveTool,
  sidePanelState,
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

test('chat is centred at home and docks beside an open feature', () => {
  assert.deepEqual(sidePanelState('home', 'stage', false), { mode: 'home', visible: true, placement: 'center' });
  assert.deepEqual(sidePanelState('watch', 'balanced', false), { mode: 'stage', visible: true, placement: 'side' });
  assert.deepEqual(sidePanelState('study', 'chat', false), { mode: 'stage', visible: true, placement: 'wide' });
  assert.deepEqual(sidePanelState('watch', 'stage', false), { mode: 'stage', visible: false, placement: 'side' });
  assert.deepEqual(sidePanelState('watch', 'stage', true), { mode: 'stage', visible: true, placement: 'side' });
  assert.equal(clampHomeChatWidth(100), HOME_CHAT_WIDTH.min);
  assert.equal(clampHomeChatWidth(5000), HOME_CHAT_WIDTH.max);
  assert.equal(clampHomeChatWidth(Number.NaN), HOME_CHAT_WIDTH.initial);
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

test('one panel element in every mode, so chat and stages never remount', () => {
  const page = read('src/app/room/[id]/page.tsx');
  assert.equal((page.match(/<RoomChat /g) ?? []).length, 1);
  assert.equal((page.match(/<aside/g) ?? []).length, 1);
  assert.equal((page.match(/<MediaStage /g) ?? []).length, 1);
  assert.equal((page.match(/<StudyStage/g) ?? []).length, 1);
  assert.match(page, /data-workspace-mode=\{sidePanel\.mode\} data-layout=\{layout\}/);
  assert.match(page, /data-collapsed=\{sidePanel\.visible \? undefined : 'true'\}/);
  // Personal layout, theme and sizes are keyed by room and user.
  for (const key of ["'layout'", "'theme'", "'home-chat-width'", "'sidebar-width'"]) {
    assert.ok(page.includes(`roomWorkspacePreferenceKey(roomData?.id ?? '', roomSync.currentUserId, ${key})`), key);
  }
  const css = read('src/app/globals.css');
  assert.match(css, /\.workspace-side\[data-collapsed="true"\] \{ display: none; \}/, 'collapsed panels stay mounted');
  assert.match(css, /\.room-content\[data-workspace-mode="home"\] \.workspace-side \{ order: -1;/);
  assert.match(css, /@media \(max-width: 520px\) \{\n  \.room-content\[data-workspace-mode="home"\] \.workspace-side \{ order: 0;/);
});
