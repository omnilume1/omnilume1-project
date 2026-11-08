import { MAX_UPLOAD_BYTES } from './upload-limits';

export type RoomUploadCandidate = {
  name: string;
  type: string;
  size: number;
};

export type RoomMediaKind = 'audio' | 'video';

export const ROOM_MEDIA_MAX_BYTES = MAX_UPLOAD_BYTES;
export const ROOM_SUBTITLE_MAX_BYTES = MAX_UPLOAD_BYTES;

const AUDIO_EXTENSIONS = new Set(['aac', 'flac', 'm4a', 'mp3', 'ogg', 'opus', 'wav', 'weba']);
const VIDEO_EXTENSIONS = new Set(['avi', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'ogv', 'webm']);
const SUBTITLE_EXTENSIONS = new Set(['srt', 'vtt']);
const SUBTITLE_MIME_TYPES = new Set([
  '',
  'application/octet-stream',
  'application/srt',
  'application/x-subrip',
  'text/plain',
  'text/vtt',
]);

export function roomFileExtension(name: string) {
  const extension = name.trim().toLowerCase().split('.').pop() ?? '';
  return /^[a-z0-9]{1,10}$/.test(extension) ? extension : '';
}

export function getRoomMediaKind(file: RoomUploadCandidate): RoomMediaKind | null {
  const extension = roomFileExtension(file.name);
  const type = file.type.trim().toLowerCase();
  const isKnownAudio = AUDIO_EXTENSIONS.has(extension);
  const isKnownVideo = VIDEO_EXTENSIONS.has(extension);

  if (type.startsWith('audio/') && isKnownAudio) return 'audio';
  if (type.startsWith('video/') && isKnownVideo) return 'video';
  if (!type && isKnownAudio) return 'audio';
  if (!type && isKnownVideo) return 'video';
  return null;
}

// MIME types accepted by both the room_attachments bucket and
// register_temporary_media (migration 20260923140000). The upload is sent with
// this type, so the browser-reported type never has to match the contract.
const ROOM_MEDIA_STORAGE_MIME_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  weba: 'audio/webm',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  ogv: 'video/ogg',
  webm: 'video/webm',
};

const ROOM_SUBTITLE_STORAGE_MIME_TYPES: Record<string, string> = {
  vtt: 'text/vtt',
  srt: 'application/x-subrip',
};

export function roomMediaStorageMimeType(file: RoomUploadCandidate): string | null {
  if (!getRoomMediaKind(file)) return null;
  return ROOM_MEDIA_STORAGE_MIME_TYPES[roomFileExtension(file.name)] ?? null;
}

export function roomSubtitleStorageMimeType(name: string): string | null {
  return ROOM_SUBTITLE_STORAGE_MIME_TYPES[roomFileExtension(name)] ?? null;
}

// Browsers report inconsistent types (an empty string for .srt, audio/x-flac,
// application/octet-stream). Re-type a validated file with its contract type
// so assertRoomFileInput, the bucket allow-list and the server-side metadata
// check all see the same value. Unknown files keep their reported type and
// are then rejected by assertRoomFileInput.
export function withRoomStorageMimeType(file: File, kind: 'media' | 'subtitle'): File {
  const contractType = kind === 'media' ? roomMediaStorageMimeType(file) : roomSubtitleStorageMimeType(file.name);
  if (!contractType || contractType === file.type) return file;
  return new File([file], file.name, { type: contractType, lastModified: file.lastModified });
}

// Storage policies authorize writes only under <room>/media/ and
// <room>/subtitles/, and register_temporary_media requires
// <room>/media/<uuid v4>.<extension>.
export function roomStorageObjectPath(
  roomId: string,
  kind: 'media' | 'subtitles',
  objectId: string,
  extension: string,
) {
  return `${roomId}/${kind}/${objectId.toLowerCase()}.${extension}`;
}

export function validateRoomMediaUpload(file: RoomUploadCandidate) {
  if (!Number.isSafeInteger(file.size) || file.size <= 0) return 'The selected file is empty.';
  if (file.size > ROOM_MEDIA_MAX_BYTES) return 'Files are capped at 500MB.';
  if (!getRoomMediaKind(file)) return 'Choose a supported audio or video file.';
  if (!roomMediaStorageMimeType(file)) {
    return 'Supported formats are MP3, FLAC, OGG, Opus, WAV, WEBA, MP4, M4V, OGV and WebM.';
  }
  return null;
}

export function validateRoomSubtitleUpload(file: RoomUploadCandidate) {
  if (!Number.isSafeInteger(file.size) || file.size <= 0) return 'The selected subtitle file is empty.';
  if (file.size > ROOM_SUBTITLE_MAX_BYTES) return 'Subtitle files are capped at 500MB.';
  if (!SUBTITLE_EXTENSIONS.has(roomFileExtension(file.name)) || !SUBTITLE_MIME_TYPES.has(file.type.trim().toLowerCase())) {
    return 'Choose a VTT or SRT subtitle file.';
  }
  return null;
}
