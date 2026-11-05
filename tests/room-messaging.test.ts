import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  ROOM_MESSAGE_COLUMNS,
  ROOM_PIN_LIMIT,
  ROOM_REACTION_EMOJIS,
  activeMentionQuery,
  canEditMessage,
  firstUnreadMessageId,
  insertMention,
  memberLabel,
  mentionSuggestions,
  messageSegments,
  pinnedMessages,
  reactionChips,
  replyPreview,
  unreadBadge,
  type MemberIdentity,
  type RoomChatMessage,
} from '../src/lib/room-chat-model.js';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
const migration = read('supabase/migrations/20261105180000_action08_room_messaging.sql');
const ME = '11111111-1111-4111-8111-111111111111';
const ALEX = '22222222-2222-4222-8222-222222222222';
const SAM = '33333333-3333-4333-8333-333333333333';
const members: MemberIdentity[] = [
  { user_id: ME, username: 'me.user', account_display_name: 'Me', room_display_name: null },
  { user_id: ALEX, username: 'alex', account_display_name: 'Alex Doe', room_display_name: 'Lex' },
  { user_id: SAM, username: 'sam_k', account_display_name: null, room_display_name: null },
];
const message = (id: string, extra: Partial<RoomChatMessage> = {}): RoomChatMessage => ({
  id, sender_id: ALEX, content: `text ${id}`, is_deleted: false, created_at: '2026-11-05T10:00:00Z', ...extra,
});

test('reaction set matches the database and chips keep a fixed order', () => {
  const sqlSet = migration.match(/SELECT ARRAY\[(.*?)\]::text\[\];/)?.[1] ?? '';
  const decoded = [...sqlSet.matchAll(/U&'((?:\\\+[0-9A-F]{6}|\\[0-9A-F]{4})+)'/g)].map((match) => match[1]
    .replace(/\\\+([0-9A-F]{6})|\\([0-9A-F]{4})/g, (_, six: string, four: string) => String.fromCodePoint(parseInt(six ?? four, 16))));
  assert.deepEqual(decoded, [...ROOM_REACTION_EMOJIS]);

  const chips = reactionChips({
    [ROOM_REACTION_EMOJIS[2]]: { count: 1, users: [SAM] },
    [ROOM_REACTION_EMOJIS[0]]: { count: 3, users: [ME, ALEX, SAM] },
    'x': { count: 9, users: [] },
    [ROOM_REACTION_EMOJIS[1]]: { count: 0, users: [] },
  }, ME);
  assert.deepEqual(chips.map((chip) => [chip.emoji, chip.count, chip.mine]), [[ROOM_REACTION_EMOJIS[0], 3, true], [ROOM_REACTION_EMOJIS[2], 1, false]]);
  assert.deepEqual(reactionChips(null, ME), []);
  assert.deepEqual(reactionChips([1, 2], ME), []);
});

test('mentions: only room members, trailing punctuation, not emails, self highlighted', () => {
  const segments = messageSegments('hi @alex. and @me.user, mail x@sam_k or @stranger', members, ME);
  const mentions = segments.filter((segment) => segment.kind === 'mention');
  assert.deepEqual(mentions.map((segment) => segment.text), ['@alex', '@me.user']);
  assert.equal(mentions[1].kind === 'mention' && mentions[1].isMe, true);
  assert.equal(segments.map((segment) => segment.text).join(''), 'hi @alex. and @me.user, mail x@sam_k or @stranger');
});

test('mention autocomplete finds the query, suggests members and inserts the username', () => {
  assert.deepEqual(activeMentionQuery('hello @al', 9), { start: 6, query: 'al' });
  assert.deepEqual(activeMentionQuery('@', 1), { start: 0, query: '' });
  assert.equal(activeMentionQuery('mail x@al', 9), null);
  assert.equal(activeMentionQuery('hello', 5), null);
  assert.deepEqual(mentionSuggestions(members, 'al', ME).map((member) => member.username), ['alex']);
  assert.deepEqual(mentionSuggestions(members, 'lex', ME).map((member) => member.username), ['alex']);
  assert.deepEqual(mentionSuggestions(members, '', ME).map((member) => member.username), ['alex', 'sam_k']);
  assert.deepEqual(insertMention('hello @al there', 6, 9, 'alex'), { text: 'hello @alex  there', caret: 12 });
  assert.equal(memberLabel(members[1]), 'Lex');
  assert.equal(memberLabel(members[2]), '@sam_k');
  assert.equal(memberLabel(undefined, 'Former member'), 'Former member');
});

test('unread divider, reply previews, edit rights, pins and badges', () => {
  const list = [
    message('a', { created_at: '2026-11-05T09:00:00Z' }),
    message('b', { created_at: '2026-11-05T10:00:00Z', sender_id: ME }),
    message('c', { created_at: '2026-11-05T10:05:00Z', is_deleted: true }),
    message('d', { created_at: '2026-11-05T10:06:00Z' }),
  ];
  assert.equal(firstUnreadMessageId(list, null, ME), null);
  assert.equal(firstUnreadMessageId(list, '2026-11-05T09:30:00Z', ME), 'd');
  assert.equal(firstUnreadMessageId(list, '2026-11-05T11:00:00Z', ME), null);

  assert.equal(replyPreview(undefined), 'Original message');
  assert.equal(replyPreview(message('x', { is_deleted: true })), 'Deleted message');
  assert.equal(replyPreview(message('x', { content: '[gif:abcd1234|Wow]' })), 'GIF');
  assert.equal(replyPreview(message('x', { content: 'y'.repeat(200) })).length, 90);

  assert.equal(canEditMessage(message('x', { sender_id: ME }), ME), true);
  assert.equal(canEditMessage(message('x'), ME), false);
  assert.equal(canEditMessage(message('x', { sender_id: ME, content: '[gif:abcd1234|Wow]' }), ME), false);
  assert.equal(canEditMessage(message('x', { sender_id: ME, is_deleted: true }), ME), false);

  const pins = pinnedMessages([
    ...Array.from({ length: 7 }, (_, index) => message(`p${index}`, { pinned_at: `2026-11-05T10:0${index}:00Z` })),
    message('gone', { pinned_at: '2026-11-05T11:00:00Z', is_deleted: true }),
  ]);
  assert.equal(pins.length, ROOM_PIN_LIMIT);
  assert.equal(pins[0].id, 'p6');
  assert.equal(unreadBadge(0), '');
  assert.equal(unreadBadge(7), '7');
  assert.equal(unreadBadge(100), '99+');
});

test('the database owns edits, pins, reactions and read state', () => {
  // Server-owned columns are reset on insert and guarded on update.
  assert.match(migration, /NEW\.edited_at := NULL;\n  NEW\.pinned_at := NULL;\n  NEW\.pinned_by := NULL;\n  NEW\.reaction_summary := '\{\}'::jsonb;/);
  assert.match(migration, /IF NEW\.reaction_summary IS DISTINCT FROM OLD\.reaction_summary AND v_authorized <> 'reactions' THEN/);
  assert.match(migration, /IF v_authorized <> 'pin' THEN/);
  assert.match(migration, /NEW\.edited_at := OLD\.edited_at;/);
  assert.match(migration, /ELSIF NEW\.content IS DISTINCT FROM OLD\.content THEN\n      NEW\.edited_at := now\(\);/);
  // Clearing references stays possible so ON DELETE SET NULL keeps working.
  assert.match(migration, /IF NEW\.reply_to_id IS DISTINCT FROM OLD\.reply_to_id AND NEW\.reply_to_id IS NOT NULL THEN/);
  // Private (encrypted) messages never carry the new room-only columns.
  assert.match(migration, /room_id IS NOT NULL\n  OR \(edited_at IS NULL AND reply_to_id IS NULL AND pinned_at IS NULL AND pinned_by IS NULL AND reaction_summary = '\{\}'::jsonb\)/);

  for (const table of ['room_message_reactions', 'room_timer_sessions', 'room_read_states']) {
    assert.match(migration, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY;`));
    assert.match(migration, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM PUBLIC, anon, authenticated;`));
  }
  assert.doesNotMatch(migration, /GRANT (INSERT|UPDATE|DELETE)[^;]*room_message_reactions/);
  assert.doesNotMatch(migration, /GRANT [^;]*room_timer_sessions/);

  // Every SECURITY DEFINER function pins its search_path.
  const definers = migration.split('CREATE OR REPLACE FUNCTION').slice(1).filter((body) => /SECURITY DEFINER/.test(body.split('AS $$')[0]));
  assert.ok(definers.length >= 12);
  for (const body of definers) assert.match(body.split('AS $$')[0], /SET search_path = ''/);

  // Client RPCs: authenticated only. Internal helpers: no client access.
  for (const fn of ['toggle_room_message_reaction(uuid, text)', 'set_room_message_pin(uuid, boolean)', 'mark_room_read(uuid)', 'get_room_unread_counts(uuid[])']) {
    assert.ok(migration.includes(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon;\nGRANT EXECUTE ON FUNCTION public.${fn} TO authenticated;`), fn);
  }
  for (const fn of ['room_member_can(uuid, uuid, text)', 'room_message_reaction_summary(uuid)', 'notify_room_message_activity()', 'notify_room_timer_activity()']) {
    assert.ok(migration.includes(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated;`), fn);
  }

  // Pins need manage_announcements; reactions and read state need chat.
  assert.match(migration, /NOT public\.room_has_capability\(v_room, v_uid, 'manage_announcements'\)/);
  assert.match(migration, /IF v_uid IS NULL OR NOT public\.room_has_capability\(p_room_id, v_uid, 'chat'\) THEN/);
  assert.match(migration, /SET last_read_at = GREATEST\(state\.last_read_at, EXCLUDED\.last_read_at\)/);
});

test('notifications never copy chat text and never block the action', () => {
  const activity = migration.split('CREATE OR REPLACE FUNCTION public.notify_room_message_activity()')[1].split('$$;')[0];
  assert.doesNotMatch(activity, /\|\|\s*NEW\.content|left\(NEW\.content/);
  assert.match(activity, /' replied to your message\.'/);
  assert.match(activity, /' mentioned you\.'/);
  assert.match(activity, /public\.room_member_can\(NEW\.room_id, v_mentioned, 'chat'\)/);
  assert.match(activity, /IF NEW\.content !~ '\^\\\[gif:' THEN/);
  for (const fn of ['notify_room_message_activity', 'notify_room_announcement', 'notify_room_pdf_shared', 'notify_room_timer_activity']) {
    const body = migration.split(`CREATE OR REPLACE FUNCTION public.${fn}()`)[1].split('$$;')[0];
    assert.match(body, /EXCEPTION WHEN OTHERS THEN\n    RAISE WARNING/, fn);
  }
  const timer = migration.split('CREATE OR REPLACE FUNCTION public.notify_room_timer_activity()')[1].split('$$;')[0];
  // The starter is the authenticated writer, never the client's ownerId.
  assert.match(timer, /VALUES \(NEW\.room_id, v_session, NEW\.updated_by, v_duration\)/);
  assert.doesNotMatch(timer, /ownerId/);
  assert.match(timer, /now\(\) >= s\.started_at \+ make_interval\(secs => s\.duration_seconds\) - interval '15 seconds'/);
});

test('room chat reuses the existing realtime feed and reads every new column', () => {
  const chat = read('src/components/room/RoomChat.tsx');
  assert.equal((chat.match(/\.channel\(/g) ?? []).length, 0, 'RoomChat opens no channel of its own');
  assert.ok((chat.match(/select\(ROOM_MESSAGE_COLUMNS\)/g) ?? []).length >= 5);
  for (const marker of ["rpc('toggle_room_message_reaction'", "rpc('set_room_message_pin'", "rpc('mark_room_read'", 'role="combobox"', 'role="listbox"', 'aria-pressed={chip.mine}', 'New messages', 'Editing message', 'Replying to']) {
    assert.ok(chat.includes(marker), `missing ${marker}`);
  }
  const sync = read('src/hooks/useRoomSync.ts');
  assert.match(sync, /const ROOM_MESSAGE_FIELDS = \['id', 'sender_id', 'content', 'is_deleted', 'created_at', 'edited_at', 'reply_to_id', 'pinned_at', 'pinned_by', 'reaction_summary'\] as const;/);
  for (const column of ROOM_MESSAGE_COLUMNS.split(', ')) assert.ok(sync.includes(`'${column}'`), column);
});
