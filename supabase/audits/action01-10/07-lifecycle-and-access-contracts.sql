-- Query 07: lifecycle, former-member, and notification-recipient catalog contracts.
-- Read-only. This checks the definitions that should deny expired/former users;
-- it is not a substitute for authenticated two-account probes.
WITH expected_functions(function_name) AS (
  VALUES
    ('is_approved_room_member'), ('is_room_admin_or_owner'),
    ('room_has_active_access'), ('room_in_recovery_window'),
    ('room_lifecycle_state'), ('room_has_capability'),
    ('get_room_by_identifier'), ('get_my_room_join_eligibility'),
    ('review_recovery_request'), ('review_permanent_room_request'),
    ('convert_active_room_to_permanent'), ('notify_room_recovery_decision')
), target_tables(table_name) AS (
  VALUES
    ('rooms'), ('room_members'), ('recovery_requests'),
    ('room_permanent_requests'), ('room_notifications'), ('temporary_media'),
    ('room_files'), ('room_realtime_snapshots'), ('study_notes'),
    ('pdf_annotations'), ('room_whiteboards'), ('messages'), ('room_messages')
)
SELECT 'authorization_function' AS audit_kind,
       'public' AS schema_name,
       e.function_name AS object_name,
       jsonb_build_object(
         'present', p.oid IS NOT NULL,
         'security_definer', COALESCE(p.prosecdef, false),
         'settings', COALESCE(p.proconfig, ARRAY[]::text[]),
         'definition', CASE WHEN p.oid IS NULL THEN NULL ELSE pg_get_functiondef(p.oid) END
       ) AS evidence
FROM expected_functions e
LEFT JOIN pg_namespace n ON n.nspname = 'public'
LEFT JOIN pg_proc p ON p.pronamespace = n.oid AND p.proname = e.function_name
UNION ALL
SELECT 'access_policy', p.schemaname,
       p.tablename || '.' || p.policyname,
       jsonb_build_object(
         'roles', p.roles,
         'command', p.cmd,
         'using_expression', p.qual,
         'with_check_expression', p.with_check
       )
FROM pg_policies p
JOIN target_tables t ON t.table_name = p.tablename
WHERE p.schemaname = 'public'
UNION ALL
SELECT 'access_table_grant', n.nspname,
       c.relname || '.' || COALESCE(r.rolname, 'PUBLIC') || '.' || acl.privilege_type,
       jsonb_build_object('grantable', acl.is_grantable)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN target_tables t ON t.table_name = c.relname
CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) acl
LEFT JOIN pg_roles r ON r.oid = acl.grantee
WHERE n.nspname = 'public'
ORDER BY audit_kind, schema_name, object_name;
