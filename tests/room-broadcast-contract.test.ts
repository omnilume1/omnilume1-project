import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  ROOM_BROADCAST_EVENT_TYPES,
  roomBroadcastEventRequiresMediaId,
  toRoomBroadcastPayload,
} from '../src/lib/room-broadcast-contract.js';

// D7: anything sent over Broadcast reaches a removed member whose connection
// is still open, so the wire contract must never carry protected room data.
const SECRET_MARKER = 'qa-secret-marker';
const leakyPayload = () => ({
  mediaId: randomUUID(),
  castId: randomUUID(),
  controllerId: randomUUID(),
  ownerId: randomUUID(),
  sessionId: randomUUID(),
  sourceType: 'upload',
  time: 12.5,
  speed: 1,
  playing: true,
  muted: false,
  volume: 0.8,
  endTime: Date.now(),
  remaining: 300,
  duration: 1500,
  elapsedSeconds: 10,
  startedAt: Date.now(),
  segmentStartedAt: Date.now(),
  completed: false,
  subject: 'Linear algebra',
  version: 3,
  // Everything below is protected and must never survive.
  elements: [{ id: 'a', kind: 'text', text: SECRET_MARKER }],
  url: `https://project.supabase.co/storage/v1/object/sign/room_attachments/x.mp4?token=${SECRET_MARKER}`,
  subtitleUrl: `https://project.supabase.co/storage/v1/object/sign/x.vtt?token=${SECRET_MARKER}`,
  title: `${SECRET_MARKER} private title.mp4`,
  message: { id: randomUUID(), content: SECRET_MARKER },
  content: SECRET_MARKER,
  file_url: `${randomUUID()}/media/${randomUUID()}.mp4`,
  storage_path: `${randomUUID()}/media/${randomUUID()}.mp4`,
});

test('no Broadcast event type can carry chat text, titles, URLs or storage paths', () => {
  for (const eventType of ROOM_BROADCAST_EVENT_TYPES) {
    const wire = toRoomBroadcastPayload(eventType, leakyPayload());
    assert.ok(wire, `${eventType} should produce a wire payload`);
    const serialized = JSON.stringify(wire);
    assert.ok(!serialized.includes(SECRET_MARKER), `${eventType} leaked protected content: ${serialized}`);
    assert.ok(!/https?:|\/storage\/v1\/|token=|\/media\/|\/subtitles\//i.test(serialized), `${eventType} leaked a URL or path: ${serialized}`);
    for (const key of ['url', 'subtitleUrl', 'title', 'message', 'content', 'file_url', 'storage_path', 'elements']) {
      assert.ok(!(key in wire), `${eventType} kept ${key}`);
    }
  }
});

test('chat events are not part of the Broadcast contract', () => {
  for (const eventType of ['room_message', 'room_message_update']) {
    assert.equal(toRoomBroadcastPayload(eventType, { message: { content: SECRET_MARKER } }), null);
  }
});

test('media events require a valid mediaId and keep the playback state', () => {
  const mediaId = randomUUID();
  for (const eventType of ROOM_BROADCAST_EVENT_TYPES.filter(roomBroadcastEventRequiresMediaId)) {
    assert.equal(toRoomBroadcastPayload(eventType, { time: 1, playing: true }), null, `${eventType} without mediaId must not be sent`);
    assert.equal(toRoomBroadcastPayload(eventType, { mediaId: 'https://evil.example/x.mp4' }), null);
    assert.equal(toRoomBroadcastPayload(eventType, { mediaId })?.mediaId, mediaId);
  }
  assert.deepEqual(
    toRoomBroadcastPayload('seek', { mediaId, time: 42, playing: false, speed: 1.5, muted: true, volume: 0.2, sourceType: 'url', castId: 'abc-123' }),
    { mediaId, castId: 'abc-123', sourceType: 'url', time: 42, speed: 1.5, playing: false, muted: true, volume: 0.2 },
  );
});

test('identifiers and free text that look like URLs are dropped', () => {
  const mediaId = randomUUID();
  const wire = toRoomBroadcastPayload('cast', { mediaId, castId: 'https://evil.example/stream.m3u8', controllerId: 'not-a-uuid' });
  assert.deepEqual(wire, { mediaId });
  for (const subject of ['see https://x.example', 'notes.mp4', 'a'.repeat(121)]) {
    assert.equal(toRoomBroadcastPayload('timer_start', { subject })?.subject, undefined, subject);
  }
  assert.equal(toRoomBroadcastPayload('timer_start', { subject: 'Chapter 4 review' })?.subject, 'Chapter 4 review');
});

test('empty-payload events stay empty', () => {
  for (const eventType of ['typing', 'request_sync', 'stop_cast'] as const) {
    assert.deepEqual(toRoomBroadcastPayload(eventType, leakyPayload()), {});
  }
  assert.equal(toRoomBroadcastPayload('not_an_event', {}), null);
});
