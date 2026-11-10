import assert from 'node:assert/strict';
import test from 'node:test';
import { messagesChatHref, messagesGroupHref, parseMessagesDeepLink, resolveMessagesDeepLink } from '../src/lib/messages-deep-link.js';

const ID = 'a2f53de6-802b-499e-8369-cdf21b473222';

test('?chat= and ?group= open a thread only for a well-formed id', () => {
  assert.deepEqual(parseMessagesDeepLink(`?chat=${ID}`), { kind: 'chat', id: ID });
  assert.deepEqual(parseMessagesDeepLink(`?group=${ID}`), { kind: 'group', id: ID });
  assert.deepEqual(parseMessagesDeepLink(`?group=${ID.toUpperCase()}`), { kind: 'group', id: ID }, 'ids compare in lower case');
  assert.deepEqual(parseMessagesDeepLink(`?utm_source=x&chat=${ID}`), { kind: 'chat', id: ID });
});

test('invalid deep links are ignored', () => {
  const ignored = [
    '',
    '?',
    '?chat=',
    '?chat=1',
    '?chat=not-a-uuid',
    `?chat=${ID}x`,
    `?chat=${ID}&chat=${ID}`,
    `?chat=${ID.replace(/-/g, '')}`,
    '?chat=../../admin',
    '?chat=%3Cscript%3E',
    `?chat[]=${ID}`,
    `?room=${ID}`,
    '?group=00000000-0000-0000-0000-00000000000g',
    "?group=' or 1=1 --",
  ];
  for (const search of ignored) assert.equal(parseMessagesDeepLink(search), null, search);
});

test('a broken chat id does not hide a valid group id', () => {
  assert.deepEqual(parseMessagesDeepLink(`?chat=nope&group=${ID}`), { kind: 'group', id: ID });
});

test('a deep link opens only a thread that is in the member\'s own inbox', () => {
  const OTHER = 'b7e1c0aa-1111-4222-8333-444455556666';
  const inbox = {
    friends: [{ user_id: 'friend', chat_id: ID }, { user_id: 'new-friend', chat_id: null }],
    general: [{ user_id: 'contact', chat_id: OTHER }],
    requests: [{ user_id: 'pending', chat_id: 'c0000000-0000-4000-8000-000000000001' }],
    chatGroups: [{ group_id: OTHER, name: 'Hostel 4' }],
  };
  assert.deepEqual(resolveMessagesDeepLink({ kind: 'chat', id: ID }, inbox), { kind: 'chat', contact: inbox.friends[0], tab: 'personal' });
  assert.deepEqual(resolveMessagesDeepLink({ kind: 'chat', id: OTHER }, inbox), { kind: 'chat', contact: inbox.general[0], tab: 'general' });
  assert.deepEqual(resolveMessagesDeepLink({ kind: 'group', id: OTHER }, inbox), { kind: 'group', group: inbox.chatGroups[0] });

  assert.equal(resolveMessagesDeepLink({ kind: 'group', id: ID }, inbox), null, 'a chat id is not a group id');
  assert.equal(resolveMessagesDeepLink({ kind: 'chat', id: 'c0000000-0000-4000-8000-000000000001' }, inbox), null, 'a pending request cannot be opened');
  assert.equal(resolveMessagesDeepLink({ kind: 'chat', id: 'd0000000-0000-4000-8000-000000000002' }, inbox), null, 'someone else\'s chat');
  assert.equal(resolveMessagesDeepLink({ kind: 'group', id: 'd0000000-0000-4000-8000-000000000002' }, inbox), null, 'a group this member is not in');
  assert.equal(resolveMessagesDeepLink({ kind: 'chat', id: ID }, { friends: [], general: [], chatGroups: [] }), null, 'an empty inbox opens nothing');
});

test('links built for notifications parse back to the same thread', () => {
  assert.equal(messagesChatHref(ID), `/messages?chat=${ID}`);
  assert.deepEqual(parseMessagesDeepLink(new URL(messagesChatHref(ID), 'https://omnilume.vercel.app').search), { kind: 'chat', id: ID });
  assert.deepEqual(parseMessagesDeepLink(new URL(messagesGroupHref(ID), 'https://omnilume.vercel.app').search), { kind: 'group', id: ID });
});
