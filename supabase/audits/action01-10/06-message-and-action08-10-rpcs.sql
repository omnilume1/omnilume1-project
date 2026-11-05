-- Query 06: migration 019 and Actions 08-10 RPC signatures, grants, and bodies.
-- Read-only. Missing expected functions, PUBLIC EXECUTE, or direct mutable
-- message_requests table grants require review.
WITH expected_functions(function_name) AS (
  VALUES
    ('send_message_request'), ('accept_message_request'),
    ('reject_message_request'), ('cancel_message_request'),
    ('upsert_room_realtime_snapshot'), ('get_room_realtime_snapshots'),
    ('notify_room_recovery_decision'), ('register_room_file'),
    ('list_room_files'), ('get_room_file_download_path'),
    ('begin_room_file_delete'), ('complete_room_file_delete'),
    ('register_temporary_media'), ('set_temporary_media_subtitle'),
    ('create_study_note'), ('list_study_notes'), ('update_study_note'),
    ('delete_study_note'), ('list_pdf_annotations'),
    ('create_pdf_annotation'), ('delete_pdf_annotation'),
    ('get_room_whiteboard'), ('save_room_whiteboard')
), function_grants AS (
  SELECT p.oid,
         jsonb_agg(jsonb_build_object(
           'grantee', COALESCE(r.rolname, 'PUBLIC'),
           'privilege', acl.privilege_type,
           'grantable', acl.is_grantable
         ) ORDER BY COALESCE(r.rolname, 'PUBLIC'), acl.privilege_type) AS grants
  FROM pg_proc p
  CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
  LEFT JOIN pg_roles r ON r.oid = acl.grantee
  GROUP BY p.oid
)
SELECT 'rpc' AS audit_kind,
       'public' AS schema_name,
       e.function_name AS object_name,
       jsonb_build_object(
         'present', p.oid IS NOT NULL,
         'identity_arguments', CASE WHEN p.oid IS NULL THEN NULL ELSE pg_get_function_identity_arguments(p.oid) END,
         'security_definer', COALESCE(p.prosecdef, false),
         'settings', COALESCE(p.proconfig, ARRAY[]::text[]),
         'public_execute', COALESCE(EXISTS (
           SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
           WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
         ), false),
         'grants', COALESCE(g.grants, '[]'::jsonb),
         'definition', CASE WHEN p.oid IS NULL THEN NULL ELSE pg_get_functiondef(p.oid) END
       ) AS evidence
FROM expected_functions e
LEFT JOIN pg_namespace n ON n.nspname = 'public'
LEFT JOIN pg_proc p ON p.pronamespace = n.oid AND p.proname = e.function_name
LEFT JOIN function_grants g ON g.oid = p.oid
UNION ALL
SELECT 'message_request_policy', p.schemaname,
       p.tablename || '.' || p.policyname,
       jsonb_build_object(
         'roles', p.roles,
         'command', p.cmd,
         'using_expression', p.qual,
         'with_check_expression', p.with_check
       )
FROM pg_policies p
WHERE p.schemaname = 'public' AND p.tablename = 'message_requests'
UNION ALL
SELECT 'message_request_table_grant', n.nspname,
       c.relname || '.' || COALESCE(r.rolname, 'PUBLIC') || '.' || acl.privilege_type,
       jsonb_build_object('grantable', acl.is_grantable)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) acl
LEFT JOIN pg_roles r ON r.oid = acl.grantee
WHERE n.nspname = 'public' AND c.relname = 'message_requests'
ORDER BY audit_kind, schema_name, object_name;
