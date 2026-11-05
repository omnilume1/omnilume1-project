import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  ROOM_MEDIA_MAX_BYTES,
  roomMediaStorageMimeType,
  roomStorageObjectPath,
  roomSubtitleStorageMimeType,
  validateRoomMediaUpload,
  validateRoomSubtitleUpload,
} from '../src/lib/room-file-validation.js';

// Contract from register_temporary_media / room_storage_path_kind
// (supabase/migrations/20260923140000 and 20260924093000).
const RPC_MEDIA_MIME_TYPES = new Set([
  'audio/mpeg', 'audio/flac', 'audio/ogg', 'audio/wav', 'audio/webm', 'video/mp4', 'video/ogg', 'video/webm',
]);
const rpcMediaPath = (roomId: string) =>
  new RegExp(`^${roomId}/media/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.[a-z0-9]{1,16}$`, 'i');

test('media uploads use the register_temporary_media path and MIME contract', () => {
  const roomId = randomUUID();
  for (const file of [
    { name: 'focus.mp3', type: 'audio/mp3', size: 1_024 },
    { name: 'focus.flac', type: 'audio/x-flac', size: 1_024 },
    { name: 'focus.MP4', type: 'video/mp4', size: 1_024 },
    { name: 'focus.webm', type: '', size: 1_024 },
  ]) {
    const mimeType = roomMediaStorageMimeType(file);
    assert.ok(mimeType && RPC_MEDIA_MIME_TYPES.has(mimeType), `${file.name} maps outside the RPC MIME list`);
    assert.equal(validateRoomMediaUpload(file), null);
    const path = roomStorageObjectPath(roomId, 'media', randomUUID().toUpperCase(), 'mp4');
    assert.match(path, rpcMediaPath(roomId));
    // The RPC requires FLAC MIME types if and only if the name and path end in .flac.
    assert.equal(mimeType === 'audio/flac', file.name.toLowerCase().endsWith('.flac'));
  }
});

test('media formats the storage contract rejects are refused before upload', () => {
  for (const name of ['clip.mov', 'clip.mkv', 'clip.avi', 'track.m4a', 'track.aac']) {
    const type = /\.(m4a|aac)$/.test(name) ? 'audio/mp4' : 'video/quicktime';
    assert.equal(roomMediaStorageMimeType({ name, type, size: 1_024 }), null);
    assert.match(validateRoomMediaUpload({ name, type, size: 1_024 }) ?? '', /Supported formats/);
  }
});

test('subtitle uploads use the subtitles prefix and an allowed bucket MIME type', () => {
  const roomId = randomUUID();
  assert.equal(roomSubtitleStorageMimeType('captions.vtt'), 'text/vtt');
  assert.equal(roomSubtitleStorageMimeType('captions.SRT'), 'application/x-subrip');
  assert.equal(roomSubtitleStorageMimeType('captions.txt'), null);
  assert.ok(roomStorageObjectPath(roomId, 'subtitles', randomUUID(), 'vtt').startsWith(`${roomId}/subtitles/`));
});

test('accepts supported room media within the upload limit', () => {
  assert.equal(validateRoomMediaUpload({ name: 'focus.mp4', type: 'video/mp4', size: 1_024 }), null);
  assert.equal(validateRoomMediaUpload({ name: 'focus.mp3', type: 'audio/mpeg', size: ROOM_MEDIA_MAX_BYTES }), null);
});

test('rejects non-media, empty, and oversized room uploads', () => {
  assert.match(validateRoomMediaUpload({ name: 'archive.zip', type: 'application/zip', size: 1_024 }) ?? '', /audio or video/i);
  assert.match(validateRoomMediaUpload({ name: 'empty.mp4', type: 'video/mp4', size: 0 }) ?? '', /empty/i);
  assert.match(validateRoomMediaUpload({ name: 'large.mp4', type: 'video/mp4', size: ROOM_MEDIA_MAX_BYTES + 1 }) ?? '', /50MB/i);
});

test('accepts only bounded VTT or SRT subtitle uploads', () => {
  assert.equal(validateRoomSubtitleUpload({ name: 'captions.vtt', type: 'text/vtt', size: 1_024 }), null);
  assert.match(validateRoomSubtitleUpload({ name: 'captions.txt', type: 'text/plain', size: 1_024 }) ?? '', /VTT or SRT/i);
});
