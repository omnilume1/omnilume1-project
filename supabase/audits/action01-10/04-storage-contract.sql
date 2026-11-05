-- Query 04: private bucket metadata, storage.objects policies, and path helpers.
-- Read-only. room_attachments must be non-public and policy expressions must
-- bind a parsed room id to room capability checks.
SELECT 'bucket' AS audit_kind,
       'storage' AS schema_name,
       'room_attachments' AS object_name,
       jsonb_build_object(
         'exists', b.id IS NOT NULL,
         'public', b.public,
         'file_size_limit', b.file_size_limit,
         'allowed_mime_types', b.allowed_mime_types
       ) AS evidence
FROM (SELECT 1) probe
LEFT JOIN storage.buckets b ON b.id = 'room_attachments'
UNION ALL
SELECT 'policy' AS audit_kind,
       p.schemaname AS schema_name,
       p.tablename || '.' || p.policyname AS object_name,
       jsonb_build_object(
         'roles', p.roles,
         'command', p.cmd,
         'using_expression', p.qual,
         'with_check_expression', p.with_check
       ) AS evidence
FROM pg_policies p
WHERE p.schemaname = 'storage' AND p.tablename = 'objects'
UNION ALL
SELECT 'path_helper' AS audit_kind,
       n.nspname AS schema_name,
       p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS object_name,
       jsonb_build_object(
         'settings', COALESCE(p.proconfig, ARRAY[]::text[]),
         'public_execute', EXISTS (
           SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
           WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
         ),
         'definition', pg_get_functiondef(p.oid)
       ) AS evidence
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('room_storage_path_room_id', 'room_storage_path_kind')
ORDER BY audit_kind, schema_name, object_name;
