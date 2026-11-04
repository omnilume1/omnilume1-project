-- OmniLume Actions 01-10 remote security catalog audit
--
-- Run this unchanged in the linked project's Supabase Dashboard SQL Editor.
-- It is catalog/read-only inspection only: no DDL, DML, migration repair, or
-- impersonated authorization calls are included. Download/save its result with
-- the audit record. `ROLLBACK` closes the explicitly read-only transaction.

BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';

-- 1. Verify the recovered migration-history entries are present remotely.
WITH expected(version) AS (
  VALUES
    ('20260918150138'), ('20260923120000'), ('20260923130000'),
    ('20260923140000'), ('20260924090000'), ('20260924093000'),
    ('20260924100000')
)
SELECT e.version, (m.version IS NOT NULL) AS present_remotely
FROM expected e
LEFT JOIN supabase_migrations.schema_migrations m ON m.version = e.version
ORDER BY e.version;

-- 2. RLS posture for every public base table and the policy definitions for
-- Actions 01-10 tables. A target with rls_enabled = false is a finding.
SELECT n.nspname AS schema_name,
       c.relname AS table_name,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced,
       COUNT(p.polname) AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policy p ON p.polrelid = c.oid
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
GROUP BY n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity
ORDER BY c.relname;

SELECT schemaname, tablename, policyname, permissive, roles, cmd,
       qual AS using_expression, with_check AS with_check_expression
FROM pg_policies
WHERE (schemaname, tablename) IN (
  ('public', 'profiles'), ('public', 'follows'),
  ('public', 'friend_requests'), ('public', 'friendships'),
  ('public', 'posts'), ('public', 'rooms'), ('public', 'room_members'),
  ('public', 'room_member_profiles'), ('public', 'room_control_settings'),
  ('public', 'room_role_permissions'), ('public', 'room_invites'),
  ('public', 'room_restrictions'), ('public', 'room_announcements'),
  ('public', 'room_messages'), ('public', 'messages'),
  ('public', 'message_reactions'), ('public', 'message_requests'),
  ('public', 'private_chats'), ('public', 'recovery_requests'),
  ('public', 'room_permanent_requests'), ('public', 'room_notifications'),
  ('public', 'temporary_media'), ('public', 'room_files'),
  ('public', 'room_cleanup_jobs'), ('public', 'temporary_media_cleanup_jobs'),
  ('public', 'room_realtime_snapshots'), ('public', 'study_notes'),
  ('public', 'pdf_annotations'), ('public', 'room_whiteboards')
)
ORDER BY schemaname, tablename, policyname;

-- 3. SECURITY DEFINER functions: report search_path, PUBLIC EXECUTE, owner,
-- and complete definitions. Every security-definer function must have a fixed
-- search_path and no PUBLIC/anon EXECUTE grant unless explicitly justified.
SELECT n.nspname AS schema_name,
       p.proname AS function_name,
       pg_get_function_identity_arguments(p.oid) AS identity_arguments,
       pg_get_userbyid(p.proowner) AS owner,
       p.prosecdef AS security_definer,
       COALESCE(array_to_string(p.proconfig, ', '), '') AS function_settings,
       EXISTS (
         SELECT 1
         FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
         WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
       ) AS public_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prosecdef
ORDER BY p.proname, identity_arguments;

SELECT n.nspname AS schema_name,
       p.proname AS function_name,
       pg_get_function_identity_arguments(p.oid) AS identity_arguments,
       COALESCE(grantee.rolname, 'PUBLIC') AS grantee,
       acl.privilege_type,
       acl.is_grantable
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
WHERE n.nspname = 'public'
  AND p.proname IN (
    'send_message_request', 'accept_message_request', 'reject_message_request',
    'cancel_message_request', 'room_has_active_access',
    'room_lifecycle_state', 'room_in_recovery_window',
    'room_has_capability', 'get_room_by_identifier',
    'get_my_room_join_eligibility', 'upsert_room_realtime_snapshot',
    'get_room_realtime_snapshots', 'register_room_file',
    'list_room_files', 'get_room_file_download_path', 'begin_room_file_delete',
    'complete_room_file_delete', 'register_temporary_media',
    'set_temporary_media_subtitle', 'create_study_note', 'list_study_notes',
    'update_study_note', 'delete_study_note', 'list_pdf_annotations',
    'create_pdf_annotation', 'delete_pdf_annotation', 'get_room_whiteboard',
    'save_room_whiteboard', 'notify_room_recovery_decision'
  )
ORDER BY function_name, identity_arguments, grantee;

SELECT n.nspname AS schema_name,
       p.proname AS function_name,
       pg_get_function_identity_arguments(p.oid) AS identity_arguments,
       pg_get_functiondef(p.oid) AS definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'send_message_request', 'accept_message_request', 'reject_message_request',
    'cancel_message_request', 'room_has_active_access',
    'room_lifecycle_state', 'room_has_capability',
    'upsert_room_realtime_snapshot', 'register_room_file',
    'get_room_file_download_path', 'register_temporary_media',
    'create_study_note', 'update_study_note', 'create_pdf_annotation',
    'save_room_whiteboard', 'notify_room_recovery_decision'
  )
ORDER BY function_name, identity_arguments;

-- 4. Constraints, foreign keys, indexes, and non-internal triggers on the
-- action-owned tables. Compare definitions to the recovered migrations.
SELECT n.nspname AS schema_name, c.relname AS table_name,
       con.conname AS constraint_name, con.contype AS constraint_type,
       pg_get_constraintdef(con.oid, true) AS definition
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN (
    'message_requests', 'room_files', 'temporary_media',
    'room_cleanup_jobs', 'temporary_media_cleanup_jobs',
    'room_realtime_snapshots', 'study_notes', 'pdf_annotations',
    'room_whiteboards', 'room_members', 'room_notifications',
    'recovery_requests', 'room_permanent_requests'
  )
ORDER BY table_name, constraint_name;

SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN (
    'message_requests', 'room_files', 'temporary_media',
    'room_cleanup_jobs', 'temporary_media_cleanup_jobs',
    'room_realtime_snapshots', 'study_notes', 'pdf_annotations',
    'room_whiteboards', 'room_members', 'room_notifications',
    'recovery_requests', 'room_permanent_requests'
  )
ORDER BY tablename, indexname;

SELECT n.nspname AS schema_name, c.relname AS table_name,
       t.tgname AS trigger_name, pg_get_triggerdef(t.oid, true) AS definition
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT t.tgisinternal
  AND n.nspname = 'public'
  AND c.relname IN (
    'rooms', 'room_members', 'messages', 'message_requests', 'private_chats',
    'recovery_requests', 'room_permanent_requests', 'profiles', 'posts'
  )
ORDER BY table_name, trigger_name;

-- 5. Private storage contract and exact storage.objects policies.
SELECT id, name, public, file_size_limit, allowed_mime_types, created_at,
       updated_at
FROM storage.buckets
WHERE id = 'room_attachments';

SELECT schemaname, tablename, policyname, permissive, roles, cmd,
       qual AS using_expression, with_check AS with_check_expression
FROM pg_policies
WHERE schemaname = 'storage' AND tablename = 'objects'
ORDER BY policyname;

-- 6. Realtime database publication and broadcast-channel policy contract.
SELECT pubname, puballtables, pubinsert, pubupdate, pubdelete, pubtruncate
FROM pg_publication
WHERE pubname = 'supabase_realtime';

SELECT pubname, schemaname, tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime'
  AND schemaname = 'public'
  AND tablename IN ('message_requests', 'private_chats', 'friendships')
ORDER BY tablename;

SELECT schemaname, tablename, policyname, permissive, roles, cmd,
       qual AS using_expression, with_check AS with_check_expression
FROM pg_policies
WHERE schemaname = 'realtime' AND tablename = 'messages'
ORDER BY policyname;

-- 7. Catalog-only checks for former-member and notification-recipient guards.
-- Expected definitions call room_has_active_access/is_approved_room_member or
-- room_has_capability, and room_notifications is recipient-scoped.
SELECT policyname, cmd, qual AS using_expression, with_check AS with_check_expression
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('room_members', 'room_notifications', 'temporary_media',
                    'room_files', 'room_realtime_snapshots', 'study_notes',
                    'pdf_annotations', 'room_whiteboards', 'messages',
                    'room_messages')
ORDER BY tablename, policyname;

-- 8. Investigate the CLI lint's broken extensions test helpers. These are
-- catalog-only diagnostics; they are not Action 01-10 application objects.
SELECT e.extname, e.extversion, n.nspname AS extension_schema
FROM pg_extension e
JOIN pg_namespace n ON n.oid = e.extnamespace
WHERE e.extname ILIKE '%tap%' OR n.nspname = 'extensions'
ORDER BY e.extname;

SELECT n.nspname AS schema_name, p.proname AS function_name,
       pg_get_function_identity_arguments(p.oid) AS identity_arguments,
       p.prokind AS function_kind
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'extensions'
  AND p.proname IN ('_query', '_get_rel_owner', '_array_to_sorted_string',
                    '_db_privs', '_get_func_privs', 'plan', 'ok')
ORDER BY function_name, identity_arguments;

ROLLBACK;
