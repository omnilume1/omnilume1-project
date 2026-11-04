export type RoomUploadCandidate = {
  name: string;
  type: string;
  size: number;
};

export type RoomMediaKind = 'audio' | 'video';

export const ROOM_MEDIA_MAX_BYTES = 50 * 1024 * 1024;
export const ROOM_SUBTITLE_MAX_BYTES = 5 * 1024 * 1024;

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

export function validateRoomMediaUpload(file: RoomUploadCandidate) {
  if (!Number.isSafeInteger(file.size) || file.size <= 0) return 'The selected file is empty.';
  if (file.size > ROOM_MEDIA_MAX_BYTES) return 'Files are capped at 50MB.';
  if (!getRoomMediaKind(file)) return 'Choose a supported audio or video file.';
  return null;
}

export function validateRoomSubtitleUpload(file: RoomUploadCandidate) {
  if (!Number.isSafeInteger(file.size) || file.size <= 0) return 'The selected subtitle file is empty.';
  if (file.size > ROOM_SUBTITLE_MAX_BYTES) return 'Subtitle files are capped at 5MB.';
  if (!SUBTITLE_EXTENSIONS.has(roomFileExtension(file.name)) || !SUBTITLE_MIME_TYPES.has(file.type.trim().toLowerCase())) {
    return 'Choose a VTT or SRT subtitle file.';
  }
  return null;
}
