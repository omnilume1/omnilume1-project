import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  countdownRemaining,
  createThrottle,
  localDateTimeInput,
  pollPercentages,
  SCREEN_UPLOAD_BUDGET,
  screenBitrate,
  shouldInitiateOffer,
  studyStats,
  withStereoOpus,
  youTubeId,
} from '../src/lib/collab-model.js';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');

test('study statistics: totals, longest, today/week, per subject', () => {
  const now = new Date(2026, 10, 5, 18, 0, 0);
  const at = (daysAgo: number, hour = 10) => new Date(2026, 10, 5 - daysAgo, hour, 0, 0).toISOString();
  const stats = studyStats([
    { subject: 'Maths', duration_minutes: 50, created_at: at(0) },
    { subject: 'Maths', duration_minutes: 25, created_at: at(1) },
    { subject: 'Physics', duration_minutes: 90, created_at: at(2) },
    { subject: 'Physics', duration_minutes: 30, created_at: at(10) },
  ], now);
  assert.equal(stats.totalMinutes, 195);
  assert.equal(stats.sessions, 4);
  assert.equal(stats.longestMinutes, 90);
  assert.equal(stats.todayMinutes, 50);
  assert.equal(stats.weekMinutes, 165);
  assert.equal(stats.currentStreakDays, 3);
  assert.equal(stats.bestStreakDays, 3);
  assert.deepEqual(stats.bySubject.map((row) => row.subject), ['Physics', 'Maths']);
  assert.equal(Math.round(stats.bySubject[0].share * 100), 62);
});

test('study streak survives a day with no session yet, and breaks on a gap', () => {
  const now = new Date(2026, 10, 5, 9, 0, 0);
  const at = (daysAgo: number) => new Date(2026, 10, 5 - daysAgo, 20, 0, 0).toISOString();
  assert.equal(studyStats([{ subject: 'A', duration_minutes: 10, created_at: at(1) }, { subject: 'A', duration_minutes: 10, created_at: at(2) }], now).currentStreakDays, 2);
  assert.equal(studyStats([{ subject: 'A', duration_minutes: 10, created_at: at(2) }], now).currentStreakDays, 0);
  assert.equal(studyStats([], now).bestStreakDays, 0);
});

test('poll percentages always total 100 and handle no votes', () => {
  assert.deepEqual(pollPercentages([1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(pollPercentages([0, 0]), [0, 0]);
  assert.deepEqual(pollPercentages([3, 1]), [75, 25]);
  assert.equal(pollPercentages([2, 2, 3]).reduce((a, b) => a + b, 0), 100);
});

test('countdown, offer rule, YouTube ids, datetime input', () => {
  assert.equal(countdownRemaining(new Date(10_500).toISOString(), 0), 11);
  assert.equal(countdownRemaining(new Date(0).toISOString(), 5_000), 0);
  assert.equal(countdownRemaining('not a date', 0), 0);
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';
  assert.equal(shouldInitiateOffer(a, b), true);
  assert.equal(shouldInitiateOffer(b, a), false, 'exactly one side offers');
  assert.equal(screenBitrate(0), 10_000_000);
  assert.equal(screenBitrate(1), 10_000_000);
  assert.equal(screenBitrate(2), 10_000_000);
  assert.equal(screenBitrate(5), 4_600_000);
  const sdp = 'v=0\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\na=rtpmap:96 VP8/90000\r\na=fmtp:97 apt=96\r\n';
  const stereo = withStereoOpus(sdp);
  assert.ok(stereo.includes('a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1\r\n'), 'opus marked stereo');
  assert.ok(stereo.includes('a=fmtp:97 apt=96\r\n'), 'other codecs untouched');
  assert.equal(withStereoOpus(stereo), stereo, 'idempotent');
  for (let watching = 1; watching <= 12; watching += 1) assert.ok(screenBitrate(watching) * watching <= SCREEN_UPLOAD_BUDGET, 'total upload stays under the cap');
  assert.equal(youTubeId('https://www.youtube.com/watch?v=aqz-KE-bpKQ'), 'aqz-KE-bpKQ');
  assert.equal(youTubeId('https://youtu.be/aqz-KE-bpKQ?t=10'), 'aqz-KE-bpKQ');
  assert.equal(youTubeId('https://m.youtube.com/shorts/aqz-KE-bpKQ'), 'aqz-KE-bpKQ');
  assert.equal(youTubeId('http://www.youtube.com/watch?v=aqz-KE-bpKQ'), null, 'https only');
  assert.equal(youTubeId('https://evil.example/watch?v=aqz-KE-bpKQ'), null);
  assert.equal(youTubeId('https://www.youtube.com/watch?v=bad'), null);
  assert.equal(localDateTimeInput(30, new Date(2026, 0, 2, 23, 45, 10)), '2026-01-03T00:15');
});

test('cursor throttle sends the first point and only the last of a burst', () => {
  let clock = 0;
  let pending: (() => void) | null = null;
  const sent: number[] = [];
  const throttle = createThrottle<number>((value) => sent.push(value), 80, {
    now: () => clock,
    set: (fn) => { pending = fn; return 1; },
    clear: () => { pending = null; },
  });
  throttle.push(1);
  clock = 10; throttle.push(2);
  clock = 20; throttle.push(3);
  assert.deepEqual(sent, [1]);
  clock = 80; (pending as (() => void) | null)?.();
  assert.deepEqual(sent, [1, 3]);
  throttle.push(4);
  throttle.cancel();
  assert.deepEqual(sent, [1, 3]);
});

test('Action 12 migration: RLS everywhere, no direct writes, definer functions pinned', () => {
  const sql = read('supabase/migrations/20261107100000_action12_collaboration.sql');
  const tables = [
    'study_note_versions', 'room_hand_raises', 'room_polls', 'room_poll_votes', 'room_countdowns', 'room_tasks',
    'room_events', 'room_study_resources', 'room_resource_progress', 'room_resource_notes', 'room_voice_moderation',
    'room_recordings', 'room_recording_consents', 'room_recording_transcripts',
  ];
  for (const table of tables) {
    assert.match(sql, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY;`), `${table} has RLS`);
    assert.match(sql, new RegExp(`REVOKE ALL ON TABLE [^;]*public\\.${table}[^;]*FROM PUBLIC, anon, authenticated;`), `${table} revokes direct access`);
  }
  assert.doesNotMatch(sql, /GRANT (INSERT|UPDATE|DELETE|ALL)/, 'no direct table writes are granted');
  for (const body of sql.split('CREATE OR REPLACE FUNCTION').slice(1)) {
    const header = body.split('AS $$')[0];
    assert.match(header, /SECURITY DEFINER/);
    assert.match(header, /SET search_path (=|TO) ''/);
  }
  // Policy helpers run as the caller, so authenticated must be able to execute them.
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.can_view_room_recording\(uuid\) TO authenticated;/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.room_recording_object_access\(text, text\) TO authenticated;/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.expire_room_recordings\(\) FROM PUBLIC, anon, authenticated;/);
  // Votes stay private: members read only their own row.
  assert.match(sql, /USING \(user_id = auth\.uid\(\) AND public\.room_has_capability\(room_id, auth\.uid\(\), 'chat'\)\)/);
  // Recordings: everyone listed must agree before 'recording'; private bucket.
  assert.match(sql, /IF v_granted = cardinality\(v_row\.participants\) THEN/);
  assert.match(sql, /VALUES \('room_recordings', 'room_recordings', false/);
  // Moderation and events are manager-only.
  assert.match(sql, /set_room_voice_moderation[\s\S]*?'manage_members'/);
  assert.match(sql, /create_room_event[\s\S]*?'manage_announcements'/);
});

test('Action 12 wiring: one realtime path, enforcement on both ends', () => {
  const sync = read('src/hooks/useRoomSync.ts');
  assert.equal((sync.match(/supabase\.channel\(/g) ?? []).length, 5, 'no new channel');
  assert.match(sync, /if \(eventType === 'collab_changed' \|\| eventType === 'rtc_signal'\) return 'chat';/);
  assert.match(sync, /eventType === 'cursor' \|\| eventType === 'note_editing' \|\| eventType === 'pdf_follow'\) return 'study';/);
  const voice = read('src/components/room/VoiceRoom.tsx');
  assert.match(voice, /<VoiceAudio key=\{peer\.id\} stream=\{peer\.audio\} muted=\{Boolean\(moderation\.get\(peer\.id\)\?\.audio_muted\)\} volume=\{memberVolumes\[peer\.id\] \?\? 1\} \/>/, 'listeners silence a muted member');
  assert.match(voice, /const boosting = Boolean\(stream\) && !muted && volume > 1;/, 'a manager mute also silences a boosted voice');
  assert.match(voice, /if \(!boosting\) element\.muted = muted;/, 'the element follows a manager mute when not boosted');
  assert.match(voice, /element\.muted = context\.state === 'running';/, 'a boosted voice never plays twice or drops out');
  assert.match(voice, /if \(forcedMute\) meshRef\.current\?\.setMicEnabled\(false\);/, 'the muted member stops sending');
  assert.match(voice, /activeRecording\.requested_by === currentUserId && joined/, 'only the requester records, only in voice');
  const mesh = read('src/lib/voice-mesh.ts');
  assert.match(mesh, /peer\.ignoreOffer = !peer\.polite && collision;/, 'perfect negotiation');
  assert.doesNotMatch(mesh, /console\.(log|info|debug)/, 'signaling is never logged');
  const panel = read('src/components/room/StudyNotesPanel.tsx');
  assert.match(panel, /sendRoomEvent\('note_editing', \{ noteId: selectedId, editing: true \}\)/, 'presence carries the note id only');
});
