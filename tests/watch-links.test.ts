import assert from 'node:assert/strict';
import test from 'node:test';
import { isAuthRequiredPath } from '../src/lib/auth.js';
import { findLink, hasYouTubeVideo, normalizeCastUrl, youtubePlaylistId } from '../src/lib/cast-url.js';
import { cleanQuery, decodeEntities, parseTwitchSearch, parseYouTubePlaylist, parseYouTubeSearch } from '../src/lib/media-search.js';

test('a pasted, dropped or shared text gives its first web link', () => {
  assert.equal(findLink('Watch this! https://youtu.be/dQw4w9WgXcQ.'), 'https://youtu.be/dQw4w9WgXcQ');
  assert.equal(findLink('https://www.twitch.tv/somechannel'), 'https://www.twitch.tv/somechannel');
  assert.equal(findLink('look at youtube.com/watch?v=dQw4w9WgXcQ now'), 'youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(findLink('# comment\nhttps://example.com/a.mp4'), 'https://example.com/a.mp4');
  assert.equal(findLink('just some words'), null);
  assert.equal(findLink(''), null);
});

test('YouTube playlist links are told apart from single videos', () => {
  assert.equal(youtubePlaylistId('https://www.youtube.com/playlist?list=PLabcdefghij123'), 'PLabcdefghij123');
  assert.equal(hasYouTubeVideo('https://www.youtube.com/playlist?list=PLabcdefghij123'), false);
  assert.equal(youtubePlaylistId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabcdefghij123'), 'PLabcdefghij123');
  assert.equal(hasYouTubeVideo('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabcdefghij123'), true);
  assert.equal(youtubePlaylistId('https://example.com/?list=PLabcdefghij123'), null);
  assert.equal(youtubePlaylistId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(youtubePlaylistId('not a link'), null);
});

test('found links still go through the Cast rules', () => {
  assert.deepEqual(normalizeCastUrl('https://youtu.be/dQw4w9WgXcQ'), { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'YouTube video' });
  assert.equal(normalizeCastUrl('https://www.twitch.tv/somechannel').title, 'Twitch live stream');
  assert.throws(() => normalizeCastUrl('https://kick.com/somechannel'), /Kick channel/);
});

test('YouTube search results keep only what the room shows', () => {
  const results = parseYouTubeSearch({
    items: [
      { id: { videoId: 'dQw4w9WgXcQ' }, snippet: { title: 'Tom &amp; Jerry &#39;live&#39;', channelTitle: 'Cartoons', liveBroadcastContent: 'live', thumbnails: { medium: { url: 'https://i.ytimg.com/vi/x/mq.jpg' } }, extra: 'dropped' } },
      { id: { channelId: 'UC123' }, snippet: { title: 'A channel' } },
      { id: { videoId: 'bad id' }, snippet: { title: 'Broken' } },
      { id: { videoId: 'abcdefghijk' }, snippet: { title: 'Plain', thumbnails: { medium: { url: 'http://insecure/x.jpg' } } } },
    ],
  });
  assert.deepEqual(results, [
    { source: 'youtube', id: 'dQw4w9WgXcQ', title: "Tom & Jerry 'live'", channel: 'Cartoons', thumbnail: 'https://i.ytimg.com/vi/x/mq.jpg', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', live: true },
    { source: 'youtube', id: 'abcdefghijk', title: 'Plain', channel: '', thumbnail: null, url: 'https://www.youtube.com/watch?v=abcdefghijk', live: false },
  ]);
  assert.deepEqual(parseYouTubeSearch(null), []);
  assert.deepEqual(parseYouTubeSearch({ items: 'nope' }), []);
});

test('Twitch search lists live channels first and links to the channel', () => {
  const results = parseTwitchSearch({
    data: [
      { broadcaster_login: 'quietone', display_name: 'QuietOne', is_live: false, title: 'old title', thumbnail_url: 'https://static-cdn.jtvnw.net/a.png' },
      { broadcaster_login: 'LiveOne', display_name: 'LiveOne', is_live: true, title: 'Speedrun', game_name: 'Celeste', thumbnail_url: 'https://static-cdn.jtvnw.net/b.png' },
      { broadcaster_login: 'bad login!', display_name: 'x' },
    ],
  });
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], { source: 'twitch', id: 'LiveOne', title: 'Speedrun', channel: 'LiveOne · Celeste', thumbnail: 'https://static-cdn.jtvnw.net/b.png', url: 'https://www.twitch.tv/liveone', live: true });
  assert.equal(results[1].title, 'QuietOne');
  assert.equal(results[1].live, false);
});

test('playlist import skips private and deleted videos', () => {
  const items = parseYouTubePlaylist({
    items: [
      { snippet: { title: 'First', resourceId: { videoId: 'aaaaaaaaaaa' } } },
      { snippet: { title: 'Private video', resourceId: { videoId: 'bbbbbbbbbbb' } } },
      { snippet: { title: 'Deleted video', resourceId: { videoId: 'ccccccccccc' } } },
      { snippet: { title: 'Rock &amp; Roll', resourceId: { videoId: 'ddddddddddd' } } },
    ],
  });
  assert.deepEqual(items, [
    { title: 'First', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' },
    { title: 'Rock & Roll', url: 'https://www.youtube.com/watch?v=ddddddddddd' },
  ]);
});

test('search queries are trimmed and bounded, and the share page needs sign-in', () => {
  assert.equal(cleanQuery('  lofi   beats '), 'lofi beats');
  assert.equal(cleanQuery(''), null);
  assert.equal(cleanQuery(null), null);
  assert.equal(cleanQuery('x'.repeat(101)), null);
  assert.equal(decodeEntities('a &lt;b&gt; &quot;c&quot;'), 'a <b> "c"');
  assert.equal(isAuthRequiredPath('/share'), true);
  assert.equal(isAuthRequiredPath('/shared'), false);
});
