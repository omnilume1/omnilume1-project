import { MAX_UPLOAD_BYTES } from '@/lib/upload-limits';

export const ROOM_ATTACHMENT_BUCKET = 'room_attachments';
export const RECORDINGS_BUCKET = 'room_recordings';
export const ROOM_FILE_MAX_BYTES = MAX_UPLOAD_BYTES;

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const ROOM_ID_PATTERN = new RegExp(`^${UUID_PATTERN}$`, 'i');
const UPLOAD_ID_PATTERN = new RegExp(`^${UUID_PATTERN}$`, 'i');

// This is the explicit Action 09 contract for the existing Supabase bucket.
// It deliberately excludes executable and archive formats. MIME verification is
// an allow-list check; content inspection/transcoding needs a future worker.
export const ROOM_FILE_MIME_TYPES = [
  'application/pdf',
  'application/x-subrip',
  'text/plain',
  'text/markdown',
  'text/vtt',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'audio/mpeg',
  'audio/flac',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'video/mp4',
  'video/ogg',
  'video/webm',
] as const;

export const ROOM_MEDIA_MIME_TYPES = ROOM_FILE_MIME_TYPES.filter((mimeType) =>
  mimeType.startsWith('audio/') || mimeType.startsWith('video/'),
);

export const ROOM_SUBTITLE_MIME_TYPES = ['text/vtt', 'application/x-subrip'] as const;

export type RoomFileKind = 'file' | 'media' | 'subtitle';

export function isRoomFileMimeType(mimeType: string) {
  return (ROOM_FILE_MIME_TYPES as readonly string[]).includes(mimeType);
}

export function isRoomMediaMimeType(mimeType: string) {
  return (ROOM_MEDIA_MIME_TYPES as readonly string[]).includes(mimeType);
}

export function isRoomSubtitleMimeType(mimeType: string) {
  return (ROOM_SUBTITLE_MIME_TYPES as readonly string[]).includes(mimeType);
}

export function normalizeRoomFileName(fileName: string) {
  const normalized = fileName
    .normalize('NFKC')
    .replace(/[\\/\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);

  if (!normalized || normalized === '.' || normalized === '..') {
    throw new Error('Choose a file with a valid name.');
  }

  return normalized;
}

export function extensionForFileName(fileName: string, fallback = 'bin') {
  const lastSegment = fileName.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '');
  return lastSegment && lastSegment.length <= 16 ? lastSegment : fallback;
}

function hasMatchingFlacExtension(fileName: string, mimeType: string) {
  const hasFlacExtension = extensionForFileName(fileName) === 'flac';
  const isFlacMimeType = mimeType === 'audio/flac';
  return hasFlacExtension === isFlacMimeType;
}

// A FLAC suffix is meaningful to browser playback selection and to the SQL
// registration contract. Keep the filename, MIME type, and generated object
// path aligned; other allowed formats preserve the existing extension rules.
export function hasValidRoomFileMimeExtension(fileName: string, mimeType: string) {
  return hasMatchingFlacExtension(fileName, mimeType.toLowerCase());
}

export function assertRoomFileInput(file: Pick<File, 'name' | 'size' | 'type'>, kind: RoomFileKind) {
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    throw new Error('Choose a non-empty file.');
  }
  if (file.size > ROOM_FILE_MAX_BYTES) {
    throw new Error('Files are capped at 500 MB.');
  }

  const mimeType = file.type.toLowerCase();
  const isAllowed = kind === 'media'
    ? isRoomMediaMimeType(mimeType)
    : kind === 'subtitle'
      ? isRoomSubtitleMimeType(mimeType)
      : isRoomFileMimeType(mimeType);
  if (!isAllowed) {
    throw new Error(`Unsupported ${kind === 'file' ? 'file' : kind} type.`);
  }
  if (!hasValidRoomFileMimeExtension(file.name, mimeType)) {
    throw new Error('FLAC uploads must use the .flac extension and audio/flac MIME type.');
  }

  return {
    fileName: normalizeRoomFileName(file.name),
    mimeType,
    size: file.size,
  };
}

export function createRoomObjectPath(roomId: string, kind: RoomFileKind, uploadId: string, fileName: string) {
  if (!ROOM_ID_PATTERN.test(roomId) || !UPLOAD_ID_PATTERN.test(uploadId)) {
    throw new Error('Invalid room upload path.');
  }
  const extension = extensionForFileName(fileName, kind === 'subtitle' ? 'vtt' : 'bin');
  const prefix = kind === 'file' ? 'files' : kind === 'media' ? 'media' : 'subtitles';
  return `${roomId}/${prefix}/${uploadId}.${extension}`;
}

export function isRoomObjectPath(roomId: string, path: string, kind?: RoomFileKind) {
  if (!ROOM_ID_PATTERN.test(roomId) || typeof path !== 'string' || path.length > 512) return false;
  const kindPattern = kind === 'file'
    ? 'files'
    : kind === 'media'
      ? 'media'
      : kind === 'subtitle'
        ? 'subtitles'
        : '(?:files|media|subtitles)';
  return new RegExp(`^${roomId}/${kindPattern}/${UUID_PATTERN}\\.[a-z0-9]{1,16}$`, 'i').test(path);
}

export function isLegacyRoomObjectPath(roomId: string, path: string) {
  return ROOM_ID_PATTERN.test(roomId)
    && typeof path === 'string'
    && path.startsWith(`${roomId}/`)
    && !path.includes('..')
    && !path.includes('\\')
    && !/^https?:\/\//i.test(path);
}

export function isPrivateStorageUrl(value: unknown) {
  return typeof value === 'string' && /\/storage\/v1\/object\/(?:sign|authenticated)\//i.test(value);
}
