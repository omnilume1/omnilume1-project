-- Query 02: SECURITY DEFINER functions, fixed search paths, grants, and bodies.
-- Read-only. A public_execute value of true requires explicit review.
WITH function_grants AS (
  SELECT p.oid,
         jsonb_agg(
           jsonb_build_object(
             'grantee', COALESCE(r.rolname, 'PUBLIC'),
             'privilege', acl.privilege_type,
             'grantable', acl.is_grantable
           )
           ORDER BY COALESCE(r.rolname, 'PUBLIC'), acl.privilege_type
         ) AS grants
  FROM pg_proc p
  CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
  LEFT JOIN pg_roles r ON r.oid = acl.grantee
  GROUP BY p.oid
)
SELECT n.nspname AS schema_name,
       p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS function_name,
       jsonb_build_object(
         'owner', pg_get_userbyid(p.proowner),
         'security_definer', p.prosecdef,
         'function_settings', COALESCE(p.proconfig, ARRAY[]::text[]),
         'public_execute', EXISTS (
           SELECT 1
           FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
           WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
         ),
         'grants', COALESCE(g.grants, '[]'::jsonb),
         'definition', pg_get_functiondef(p.oid)
       ) AS evidence
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
LEFT JOIN function_grants g ON g.oid = p.oid
WHERE n.nspname = 'public' AND p.prosecdef
ORDER BY function_name;
