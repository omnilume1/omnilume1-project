import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ROOM_MEDIA_MAX_BYTES,
  validateRoomMediaUpload,
  validateRoomSubtitleUpload,
} from '../src/lib/room-file-validation.js';

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
