import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('..', import.meta.url);
const read = (relativePath) => readFileSync(new URL(relativePath, root), 'utf8');

test('Action 10 adds server-authorized persistent study collaboration contracts', () => {
  const migrationPath = new URL('../supabase/migrations/20260924100000_action10_study_collaboration.sql', import.meta.url);
  assert.equal(existsSync(migrationPath), true, 'the forward-only Action 10 migration must exist');
  const migration = read('supabase/migrations/20260924100000_action10_study_collaboration.sql');

  for (const contract of [
    'CREATE TABLE public.study_notes',
    'CREATE TABLE public.pdf_annotations',
    'CREATE TABLE public.room_whiteboards',
    'ALTER TABLE public.study_notes ENABLE ROW LEVEL SECURITY',
    'ALTER TABLE public.pdf_annotations ENABLE ROW LEVEL SECURITY',
    'ALTER TABLE public.room_whiteboards ENABLE ROW LEVEL SECURITY',
    'CREATE OR REPLACE FUNCTION public.update_study_note',
    'CREATE OR REPLACE FUNCTION public.save_room_whiteboard',
    'expected version does not match',
    "room_has_capability(p_room_id, auth.uid(), 'study')",
    "room_has_capability(file_row.room_id, auth.uid(), 'files')",
    'REVOKE ALL ON FUNCTION public.update_study_note',
    'GRANT EXECUTE ON FUNCTION public.update_study_note',
  ]) {
    assert.ok(migration.includes(contract), `missing Action 10 contract: ${contract}`);
  }
});

test('Action 10 replaces local-only Study placeholders with accessible persistent panels', () => {
  const study = read('src/components/room/StudyStage.tsx');
  const notes = read('src/components/room/StudyNotesPanel.tsx');
  const whiteboard = read('src/components/room/StudyWhiteboardPanel.tsx');
  const pdf = read('src/components/room/StudyPdfPanel.tsx');

  assert.ok(study.includes('StudyNotesPanel'));
  assert.ok(study.includes('StudyWhiteboardPanel'));
  assert.ok(study.includes('StudyPdfPanel'));
  assert.ok(notes.includes('aria-live="polite"'));
  assert.ok(notes.includes('Save changes'));
  assert.ok(whiteboard.includes('expectedVersion'));
  assert.ok(whiteboard.includes('Conflict detected'));
  assert.ok(pdf.includes('getRoomFileDownloadUrl'));
  assert.ok(pdf.includes('PDF files in this room'));
});
