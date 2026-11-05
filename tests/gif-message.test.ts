import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { cleanGifTitle, formatGifMessage, giphyImageUrl, isGiphyMediaUrl, parseGifMessage } from '../src/lib/gif-message.js';

test('GIF messages carry only a GIPHY id and a cleaned title', () => {
  assert.equal(formatGifMessage({ id: 'xT9IgDEI1iZyb2wqo8', title: 'Excited  |dance]\nparty' }), '[gif:xT9IgDEI1iZyb2wqo8|Excited dance party]');
  assert.equal(formatGifMessage({ id: 'abcd1234', title: '' }), '[gif:abcd1234]');
  assert.throws(() => formatGifMessage({ id: 'https://evil.example/x.gif', title: 'x' }));
  assert.equal(cleanGifTitle('a'.repeat(300)).length, 100);
});

test('only well-formed GIF tokens render as GIFs; the URL is built from the id', () => {
  assert.deepEqual(parseGifMessage('[gif:abcd1234|Hello]'), { id: 'abcd1234', title: 'Hello' });
  assert.deepEqual(parseGifMessage('  [gif:abcd1234]  '), { id: 'abcd1234', title: '' });
  for (const content of ['hello [gif:abcd1234]', '[gif:../../x]', '[gif:abcd1234|a]b]', '[gif:https://evil.example/x.gif]', null, 42]) {
    assert.equal(parseGifMessage(content), null, String(content));
  }
  assert.equal(giphyImageUrl('abcd1234'), 'https://media.giphy.com/media/abcd1234/200w.gif');
  assert.throws(() => giphyImageUrl('"><script>'));
});

test('picker previews must be GIPHY media URLs', () => {
  assert.ok(isGiphyMediaUrl('https://media3.giphy.com/media/v1.Y2lkPTdiYzMy/ip0u4oJUSPdZn65nQ0/100w.gif'));
  assert.ok(isGiphyMediaUrl('https://media.giphy.com/media/abcd1234/200w.webp?cid=abc&rid=200w.webp&ct=g'));
  for (const url of ['https://evil.example/media/abcd1234/1.gif', 'http://media.giphy.com/media/abcd1234/1.gif', 'https://media.giphy.com.evil.example/media/abcd1234/1.gif', 'javascript:alert(1)']) {
    assert.equal(isGiphyMediaUrl(url), false, url);
  }
});

test('the GIPHY key stays server-side', () => {
  const action = readFileSync(resolve(process.cwd(), 'src/actions/gifs.ts'), 'utf8');
  const picker = readFileSync(resolve(process.cwd(), 'src/components/room/GifPicker.tsx'), 'utf8');
  assert.match(action, /^'use server';/);
  assert.match(action, /process\.env\.GIPHY_API_KEY/);
  assert.match(action, /auth\.getUser\(\)/);
  assert.doesNotMatch(action + picker, /NEXT_PUBLIC_GIPHY/);
  assert.doesNotMatch(picker, /api\.giphy\.com|GIPHY_API_KEY/);
});
