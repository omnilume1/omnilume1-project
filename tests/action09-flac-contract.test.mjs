import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function source(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

test('Action 09 accepts FLAC only with a matching .flac filename and media path', async () => {
  const contract = await source('src/lib/room-file-contract.ts');
  const mediaAction = await source('src/actions/media.ts');
  const roomFilesAction = await source('src/actions/room-files.ts');

  assert.match(contract, /'audio\/flac'/);
  assert.match(contract, /hasFlacExtension === isFlacMimeType/);
  assert.match(mediaAction, /hasValidRoomFileMimeExtension\(fileName, mimeType \?\? ''\)/);
  assert.match(mediaAction, /hasValidRoomFileMimeExtension\(filePath, mimeType \?\? ''\)/);
  assert.match(roomFilesAction, /hasValidRoomFileMimeExtension\(input\.objectPath, checked\.mimeType\)/);
});

test('Action 09 keeps FLAC playback private and reports unsupported browser playback', async () => {
  const stage = await source('src/components/room/MediaStage.tsx');
  const sync = await source('src/hooks/useRoomSync.ts');

  const contract = await source('src/lib/room-broadcast-contract.ts');

  // Playback URLs are resolved per viewer from the media id under that
  // viewer's own authorization (Action 07 D7); no URL or storage path is
  // ever broadcast or persisted in the shared snapshot.
  assert.match(stage, /resolveRoomMedia\(roomId, result\.mediaId\)/);
  assert.match(stage, /canPlayType\('audio\/flac'\)/);
  assert.match(stage, /This browser cannot play FLAC audio/);
  assert.match(sync, /resolveRoomMedia\(roomId, mediaId\)/);
  assert.match(sync, /saveRoomRealtimeSnapshot\(roomId, snapshotType, 1, \{ eventType, payload: wirePayload \}\)/);
  assert.doesNotMatch(contract, /\b(url|filePath|title|subtitleUrl):/);
});

test('Action 09 FLAC migrations update only configuration and validation, not storage objects', async () => {
  const bucketRepair = await source('supabase/migrations/20260924090000_action09_room_attachments_bucket_contract_repair.sql');
  const registrationRepair = await source('supabase/migrations/20260924093000_action09_flac_registration_support.sql');
  const executableBucketRepair = bucketRepair.replace(/^--.*$/gm, '');
  const executableRegistrationRepair = registrationRepair.replace(/^--.*$/gm, '');

  assert.match(bucketRepair, /UPDATE storage\.buckets/);
  assert.match(bucketRepair, /'audio\/flac'/);
  assert.doesNotMatch(executableBucketRepair, /(?:DELETE\s+FROM|UPDATE|INSERT\s+INTO|ALTER\s+TABLE|DROP\s+TABLE)\s+storage\.objects/i);
  assert.match(registrationRepair, /room_files_mime_type_flac_check/);
  assert.match(registrationRepair, /'audio\/flac'/);
  assert.doesNotMatch(executableRegistrationRepair, /(?:DELETE\s+FROM|UPDATE|INSERT\s+INTO|ALTER\s+TABLE|DROP\s+TABLE)\s+storage\.objects/i);
});
