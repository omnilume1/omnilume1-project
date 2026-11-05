-- Query 03: expected tables, constraints/FKs, indexes, and non-internal triggers.
-- Read-only. Missing expected tables or missing recovered-migration constraints are findings.
WITH target_tables(table_name) AS (
  VALUES
    ('message_requests'), ('room_files'), ('temporary_media'),
    ('room_cleanup_jobs'), ('temporary_media_cleanup_jobs'),
    ('room_realtime_snapshots'), ('study_notes'), ('pdf_annotations'),
    ('room_whiteboards'), ('room_members'), ('room_notifications'),
    ('recovery_requests'), ('room_permanent_requests'), ('rooms'),
    ('messages'), ('private_chats'), ('profiles'), ('posts')
)
SELECT 'table' AS audit_kind, 'public' AS schema_name, t.table_name AS object_name,
       jsonb_build_object('exists', c.oid IS NOT NULL) AS evidence
FROM target_tables t
LEFT JOIN pg_namespace n ON n.nspname = 'public'
LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = t.table_name
                       AND c.relkind IN ('r', 'p')
UNION ALL
SELECT 'constraint', n.nspname, c.relname || '.' || con.conname,
       jsonb_build_object('type', con.contype, 'definition', pg_get_constraintdef(con.oid, true))
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN target_tables t ON t.table_name = c.relname
WHERE n.nspname = 'public'
UNION ALL
SELECT 'index', i.schemaname, i.tablename || '.' || i.indexname,
       jsonb_build_object('definition', i.indexdef)
FROM pg_indexes i
JOIN target_tables t ON t.table_name = i.tablename
WHERE i.schemaname = 'public'
UNION ALL
SELECT 'trigger', n.nspname, c.relname || '.' || trg.tgname,
       jsonb_build_object('definition', pg_get_triggerdef(trg.oid, true))
FROM pg_trigger trg
JOIN pg_class c ON c.oid = trg.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN target_tables t ON t.table_name = c.relname
WHERE n.nspname = 'public' AND NOT trg.tgisinternal
ORDER BY audit_kind, schema_name, object_name;
