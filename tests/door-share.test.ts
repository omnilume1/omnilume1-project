import assert from 'node:assert/strict';
import test from 'node:test';
import { doorShareData, doorShareUrl, shareDoorLink, shareFailureOutcome, type ShareNavigator } from '../src/lib/door-share.js';

const TOKEN = '0123456789abcdef'.repeat(3);
const URL_ = `https://omnilume.app/join/${TOKEN}?ref=invite`;

function abortError() {
  const error = new Error('Share canceled');
  error.name = 'AbortError';
  return error;
}

function fakeNavigator(share?: ShareNavigator['share'], copyFails = false) {
  const copied: string[] = [];
  const nav: ShareNavigator = {
    share,
    clipboard: { writeText: async (text) => { if (copyFails) throw new Error('denied'); copied.push(text); } },
  };
  return { nav, copied };
}

test('the share URL is origin + /join/<token>?ref=invite', () => {
  assert.equal(doorShareUrl('https://omnilume.app', TOKEN), URL_);
  assert.equal(doorShareUrl('https://omnilume.app/', TOKEN), URL_);
  assert.doesNotMatch(doorShareUrl('https://omnilume.app', TOKEN), /\/room\//);
});

test('the share text names the room: "Room <nameplate> · door\'s open"', () => {
  assert.deepEqual(doorShareData('B-204', URL_), { title: 'Room B-204', text: "Room B-204 · door's open", url: URL_ });
  assert.deepEqual(doorShareData(' B-204 ', URL_).text, "Room B-204 · door's open");
  assert.deepEqual(doorShareData(null, URL_), { title: 'OmniLume room', text: "Door's open", url: URL_ });
  assert.equal(doorShareData('', URL_).text, "Door's open");
});

test('closing the share sheet is ignored; any other failure copies', () => {
  assert.equal(shareFailureOutcome(abortError()), 'cancelled');
  assert.equal(shareFailureOutcome(new TypeError('not allowed')), 'copy');
  assert.equal(shareFailureOutcome(Object.assign(new Error('x'), { name: 'NotAllowedError' })), 'copy');
  assert.equal(shareFailureOutcome(undefined), 'copy');
  assert.equal(shareFailureOutcome('AbortError'), 'copy');
});

test('a successful share does not copy', async () => {
  const shared: unknown[] = [];
  const { nav, copied } = fakeNavigator(async (data) => { shared.push(data); });
  const data = doorShareData('B-204', URL_);
  assert.equal(await shareDoorLink(nav, data), 'shared');
  assert.deepEqual(shared, [data]);
  assert.deepEqual(copied, []);
});

test('navigator.share runs synchronously, before any await', () => {
  let called = false;
  const { nav } = fakeNavigator(async () => { called = true; });
  void shareDoorLink(nav, doorShareData('B-204', URL_));
  assert.equal(called, true);
});

test('AbortError is ignored: no copy', async () => {
  const { nav, copied } = fakeNavigator(async () => { throw abortError(); });
  assert.equal(await shareDoorLink(nav, doorShareData('B-204', URL_)), 'cancelled');
  assert.deepEqual(copied, []);
});

test('other share errors, a throwing share and no share sheet all copy the URL', async () => {
  for (const share of [
    async () => { throw new TypeError('bad data'); },
    () => { throw new Error('sync throw'); },
    undefined,
  ] as Array<ShareNavigator['share']>) {
    const { nav, copied } = fakeNavigator(share);
    assert.equal(await shareDoorLink(nav, doorShareData('B-204', URL_)), 'copied');
    assert.deepEqual(copied, [URL_]);
  }
});

test('when copying also fails the outcome is failed, never a rejection', async () => {
  const { nav } = fakeNavigator(undefined, true);
  assert.equal(await shareDoorLink(nav, doorShareData('B-204', URL_)), 'failed');
  assert.equal(await shareDoorLink(undefined, doorShareData('B-204', URL_)), 'failed');
  assert.equal(await shareDoorLink({}, doorShareData('B-204', URL_)), 'failed');
});
