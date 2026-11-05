import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { isSourceUrl, parseManifest, parseSearchResults, searchUrlFor } from '../src/lib/music-sources.js';

test('source URLs: https only (http only on localhost), no credentials, no junk', () => {
  for (const ok of ['https://music.example/manifest.json', 'https://a.example:8443/x?y=1', 'http://localhost:3099/m.json', 'http://127.0.0.1/m']) {
    assert.equal(isSourceUrl(ok), true, ok);
  }
  for (const bad of [
    'http://music.example/m.json', 'ftp://x.example/m', 'javascript:alert(1)', 'data:application/json,{}',
    'https://user:pass@x.example/m', 'https://user@x.example/m', 'http://localhost.evil.example/m', '//x.example/m',
    'https://x.example/a b', `https://x.example/${'a'.repeat(500)}`, 42, null,
  ]) {
    assert.equal(isSourceUrl(bad), false, String(bad));
  }
});

test('manifest contract', () => {
  assert.deepEqual(parseManifest({ omnilume: 1, name: '  My  Source ', search: 'https://s.example/q?term={query}', health: 'https://s.example/ok' }),
    { name: 'My Source', searchUrl: 'https://s.example/q?term={query}', healthUrl: 'https://s.example/ok' });
  assert.equal(parseManifest({ omnilume: 1, name: 'X', search: 'https://s.example/q' }).toString(), '"search" must be an https URL containing {query}.');
  assert.match(String(parseManifest({ omnilume: 2, name: 'X', search: 'https://s.example/{query}' })), /omnilume/);
  assert.match(String(parseManifest({ omnilume: 1, search: 'https://s.example/{query}' })), /name/);
  assert.match(String(parseManifest({ omnilume: 1, name: 'X', search: 'http://evil.example/{query}' })), /https/);
  assert.match(String(parseManifest({ omnilume: 1, name: 'X', search: 'https://s.example/{query}', health: 'javascript:x' })), /health/);
  assert.match(String(parseManifest('nope')), /JSON object/);
});

test('query is encoded into every {query} slot and capped', () => {
  assert.equal(searchUrlFor('https://s.example/q?a={query}&b={query}', ' a&b=c/ü '), 'https://s.example/q?a=a%26b%3Dc%2F%C3%BC&b=a%26b%3Dc%2F%C3%BC');
  assert.equal(decodeURIComponent(searchUrlFor('https://s.example/{query}', 'x'.repeat(300)).split('/').pop()!).length, 100);
});

test('search results: invalid entries dropped, text cleaned, unsafe URLs refused, 50 max', () => {
  const source = { id: 'src1', name: 'Mine' };
  const tracks = parseSearchResults({
    tracks: [
      { id: 7, title: 'Good\u0000 Song', artist: 'A', durationMs: 1234.6, artwork: 'https://s.example/a.jpg', audio: 'https://s.example/a.mp3' },
      { id: 'no-audio', title: 'X' },
      { id: 'bad-audio', title: 'X', audio: 'http://s.example/a.mp3' },
      { id: 'js', title: 'X', audio: 'javascript:alert(1)' },
      { title: 'no id', audio: 'https://s.example/b.mp3' },
      { id: 'art', title: 'Bad art', audio: 'https://s.example/c.mp3', artwork: 'data:image/png;base64,AAAA', durationMs: -5 },
      'junk',
    ],
  }, source);
  assert.deepEqual(tracks.map((track) => track.id), ['source:src1:7', 'source:src1:art']);
  assert.equal(tracks[0].title, 'Good Song');
  assert.equal(tracks[0].durationMs, 1235);
  assert.equal(tracks[0].album, 'Mine', 'album falls back to the source name');
  assert.equal(tracks[0].sourceName, 'Mine');
  assert.equal(tracks[0].uploadId, undefined, 'never an upload: cannot be shared, played together or recorded');
  assert.equal(tracks[1].artwork, undefined);
  assert.equal(tracks[1].durationMs, 0);
  const many = parseSearchResults({ tracks: Array.from({ length: 80 }, (_, i) => ({ id: i, title: `T${i}`, audio: `https://s.example/${i}.mp3` })) }, source);
  assert.equal(many.length, 50);
  assert.deepEqual(parseSearchResults(null, source), []);
  assert.deepEqual(parseSearchResults({ tracks: 'x' }, source), []);
});

test('migration contract: owner-only RLS, URL CHECKs, responsibility, cap; no server fetch', () => {
  const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/20261112100000_action16_music_custom_sources.sql'), 'utf8');
  assert.match(sql, /ALTER TABLE public\.music_custom_sources ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.music_custom_sources FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /USING \(owner_id = auth\.uid\(\)\) WITH CHECK \(owner_id = auth\.uid\(\)\)/);
  assert.match(sql, /CHECK \(responsibility_accepted\)/);
  assert.equal((sql.match(/\^https:\/\/\[\^\/@\\s\]\+/g) ?? []).length, 3, 'manifest, search and health URLs are all checked');
  assert.match(sql, /'You can add up to 10 sources\.'/);
  assert.doesNotMatch(sql, /SECURITY DEFINER/, 'nothing here runs with elevated rights');
  // The server must never call a source (no SSRF surface): no route or server module imports the fetcher.
  for (const file of ['src/app/api/music/uploads/route.ts', 'src/app/api/music/uploads/[id]/[asset]/route.ts', 'src/app/api/internal/cleanup-expired-rooms/route.ts']) {
    assert.doesNotMatch(readFileSync(resolve(process.cwd(), file), 'utf8'), /music-sources/);
  }
  assert.match(readFileSync(resolve(process.cwd(), 'src/hooks/useMusicSources.ts'), 'utf8'), /^'use client';/);
});
