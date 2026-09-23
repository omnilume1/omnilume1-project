BEGIN;
SELECT plan(18);

SELECT has_table('public', 'study_notes', 'persistent study notes table exists');
SELECT has_table('public', 'pdf_annotations', 'private PDF annotations table exists');
SELECT has_table('public', 'room_whiteboards', 'versioned room whiteboards table exists');

SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.study_notes'::regclass)
  AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.pdf_annotations'::regclass)
  AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.room_whiteboards'::regclass),
  'all Action 10 collaboration tables enforce RLS'
);

SELECT ok(EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.study_notes'::regclass AND pg_get_constraintdef(oid, true) LIKE '%scope = ANY%' AND pg_get_constraintdef(oid, true) LIKE '%personal%'), 'notes constrain scope to room or personal');
SELECT ok(EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.study_notes'::regclass AND pg_get_constraintdef(oid, true) LIKE '%version > 0%'), 'notes carry a positive optimistic version');
SELECT ok(EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.pdf_annotations'::regclass AND pg_get_constraintdef(oid, true) LIKE '%page_number > 0%'), 'annotations require a positive page number');
SELECT ok(EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.room_whiteboards'::regclass AND pg_get_constraintdef(oid, true) LIKE '%version > 0%'), 'whiteboards carry a positive optimistic version');

SELECT has_function('public', 'create_study_note', ARRAY['uuid', 'text', 'text', 'text'], 'authorized note creation RPC exists');
SELECT has_function('public', 'update_study_note', ARRAY['uuid', 'bigint', 'text', 'text'], 'versioned note update RPC exists');
SELECT has_function('public', 'list_pdf_annotations', ARRAY['uuid'], 'authorized annotation read RPC exists');
SELECT has_function('public', 'save_room_whiteboard', ARRAY['uuid', 'bigint', 'jsonb'], 'versioned whiteboard save RPC exists');

SELECT ok(
  has_function_privilege('authenticated', 'public.update_study_note(uuid,bigint,text,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.update_study_note(uuid,bigint,text,text)', 'EXECUTE'),
  'only authenticated callers may update notes'
);

SELECT ok(NOT has_table_privilege('authenticated', 'public.study_notes', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.pdf_annotations', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.room_whiteboards', 'SELECT'), 'collaboration data is not directly readable through table grants');

SELECT ok(EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'study_notes' AND policyname = 'Study members read scoped notes' AND qual LIKE '%room_has_capability%'), 'note policy is tied to Study capability');
SELECT ok(EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'pdf_annotations' AND policyname = 'Study members read PDF annotations' AND qual LIKE '%files%'), 'annotation policy requires private-file authorization');
SELECT ok(EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'room_whiteboards' AND policyname = 'Study members read whiteboards' AND qual LIKE '%study%'), 'whiteboard policy is tied to Study capability');

SELECT ok(
  (SELECT prosrc FROM pg_proc WHERE oid = 'public.update_study_note(uuid,bigint,text,text)'::regprocedure) LIKE '%p_expected_version <> note_row.version%'
  AND (SELECT prosrc FROM pg_proc WHERE oid = 'public.save_room_whiteboard(uuid,bigint,jsonb)'::regprocedure) LIKE '%board_row.version <> p_expected_version%',
  'stale note and whiteboard updates are rejected server-side'
);

SELECT * FROM finish();
ROLLBACK;
