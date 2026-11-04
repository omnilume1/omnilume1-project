-- Query 05: Realtime publication membership and broadcast-channel policies.
-- Read-only. Publication rows support Postgres Changes; realtime.messages
-- policies control Broadcast/Presence topics and must retain room capability checks.
WITH expected_tables(table_name) AS (
  VALUES ('message_requests'), ('private_chats'), ('friendships')
), realtime_function AS (
  SELECT p.oid, n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args,
         p.proconfig, p.proacl, p.proowner
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'room_realtime_topic_room_id'
)
SELECT 'publication' AS audit_kind,
       'pg_catalog' AS schema_name,
       'supabase_realtime' AS object_name,
       jsonb_build_object(
         'exists', pub.oid IS NOT NULL,
         'all_tables', pub.puballtables,
         'insert', pub.pubinsert,
         'update', pub.pubupdate,
         'delete', pub.pubdelete,
         'truncate', pub.pubtruncate
       ) AS evidence
FROM (SELECT 1) probe
LEFT JOIN pg_publication pub ON pub.pubname = 'supabase_realtime'
UNION ALL
SELECT 'publication_table', 'public', e.table_name,
       jsonb_build_object('present', pt.tablename IS NOT NULL)
FROM expected_tables e
LEFT JOIN pg_publication_tables pt
  ON pt.pubname = 'supabase_realtime' AND pt.schemaname = 'public'
 AND pt.tablename = e.table_name
UNION ALL
SELECT 'channel_policy', p.schemaname, p.tablename || '.' || p.policyname,
       jsonb_build_object(
         'roles', p.roles,
         'command', p.cmd,
         'using_expression', p.qual,
         'with_check_expression', p.with_check
       )
FROM pg_policies p
WHERE p.schemaname = 'realtime' AND p.tablename = 'messages'
UNION ALL
SELECT 'topic_parser', rf.nspname, rf.proname || '(' || rf.args || ')',
       jsonb_build_object(
         'settings', COALESCE(rf.proconfig, ARRAY[]::text[]),
         'definition', pg_get_functiondef(rf.oid),
         'public_execute', EXISTS (
           SELECT 1 FROM aclexplode(COALESCE(rf.proacl, acldefault('f', rf.proowner))) acl
           WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
         )
       )
FROM realtime_function rf
ORDER BY audit_kind, schema_name, object_name;
