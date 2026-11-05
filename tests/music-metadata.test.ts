import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { coverArtUrl, musicBrainzQuery, parseMusicBrainz } from '../src/lib/music-metadata.js';

const mbid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

test('query is a quoted Lucene phrase; quotes and backslashes cannot break out', () => {
  assert.equal(musicBrainzQuery({ title: 'Song', artist: 'Band' }), 'recording:"Song" AND artist:"Band"');
  assert.equal(musicBrainzQuery({ title: 'A "B" \\ C', artist: 'Unknown Artist' }), 'recording:"A \\"B\\" \\\\ C"');
  assert.equal(musicBrainzQuery({ title: 'x OR artist:"evil"' }), 'recording:"x OR artist:\\"evil\\""');
});

test('MusicBrainz response → at most 5 clean candidates; malformed entries skipped', () => {
  const candidates = parseMusicBrainz({
    recordings: [
      {
        id: mbid(1), title: 'Real\u0000 Title', score: 98, length: 245000,
        'artist-credit': [{ name: 'A', joinphrase: ' & ' }, { name: 'B' }],
        releases: [{ id: mbid(2), title: 'The Album', date: '1999-05-01', media: [{ track: [{ number: '7' }] }] }],
      },
      { id: 'not-a-uuid', title: 'Skip me' },
      { id: mbid(3), title: '' },
      { id: mbid(4), title: 'No release', length: 'x', releases: [{ id: 'bad', date: '???' }] },
      ...Array.from({ length: 10 }, (_, i) => ({ id: mbid(10 + i), title: `Filler ${i}` })),
    ],
  });
  assert.equal(candidates.length, 5);
  assert.deepEqual(candidates[0], {
    recordingId: mbid(1), releaseId: mbid(2), title: 'Real Title', artist: 'A & B', album: 'The Album',
    year: 1999, trackNo: 7, durationMs: 245000, score: 98,
  });
  assert.equal(candidates[1].title, 'No release');
  assert.equal(candidates[1].releaseId, null);
  assert.equal(candidates[1].year, null);
  assert.equal(candidates[1].durationMs, null);
  assert.deepEqual(parseMusicBrainz({ recordings: 'nope' }), []);
  assert.deepEqual(parseMusicBrainz(null), []);
});

test('artwork URL only for a valid release id on the fixed Cover Art Archive host', () => {
  assert.equal(coverArtUrl(mbid(2), 500), `https://coverartarchive.org/release/${mbid(2)}/front-500`);
  assert.equal(coverArtUrl('../../etc', 500), null);
});

test('fix-tags contract: owner-only hardened RPC, fixed outbound host, nothing applied without the owner', () => {
  const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/20261113100000_action16_music_fix_tags.sql'), 'utf8');
  assert.match(sql, /SECURITY DEFINER\s+SET search_path = ''/);
  assert.match(sql, /IF uid IS NULL THEN\s+RAISE EXCEPTION 'Not authorized\.' USING ERRCODE = '42501'/);
  assert.match(sql, /row_in\.owner_id <> uid OR row_in\.state <> 'active' OR row_in\.expires_at <= now\(\)/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.update_music_upload_tags[^;]+FROM PUBLIC, anon, authenticated;/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.update_music_upload_tags[^;]+TO authenticated, service_role;/);
  const route = readFileSync(resolve(process.cwd(), 'src/app/api/music/metadata/route.ts'), 'utf8');
  assert.match(route, /fetch\(url,/);
  assert.match(route, /const url = `\$\{MUSICBRAINZ_SEARCH\}\?query=\$\{encodeURIComponent\(/, 'the only outbound URL is the fixed MusicBrainz endpoint');
  assert.match(route, /redirect: 'error'/);
  assert.match(route, /isUuid\(uploadId\)/);
});
