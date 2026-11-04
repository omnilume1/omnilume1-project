-- Query 01: Actions 01-10 RLS state and effective policy expressions.
-- Read-only. Run this file by itself and export the single result set.
WITH target_tables(table_name) AS (
  VALUES
    ('profiles'), ('follows'), ('friend_requests'), ('friendships'), ('posts'),
    ('rooms'), ('room_members'), ('room_member_profiles'),
    ('room_control_settings'), ('room_role_permissions'), ('room_invites'),
    ('room_restrictions'), ('room_announcements'), ('room_messages'),
    ('messages'), ('message_reactions'), ('message_requests'), ('private_chats'),
    ('recovery_requests'), ('room_permanent_requests'), ('room_notifications'),
    ('temporary_media'), ('room_files'), ('room_cleanup_jobs'),
    ('temporary_media_cleanup_jobs'), ('room_realtime_snapshots'),
    ('study_notes'), ('pdf_annotations'), ('room_whiteboards')
), table_state AS (
  SELECT t.table_name,
         c.oid IS NOT NULL AS table_exists,
         COALESCE(c.relrowsecurity, false) AS rls_enabled,
         COALESCE(c.relforcerowsecurity, false) AS rls_forced,
         COUNT(p.polname) FILTER (WHERE p.polname IS NOT NULL) AS policy_count
  FROM target_tables t
  LEFT JOIN pg_namespace n ON n.nspname = 'public'
  LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = t.table_name
                         AND c.relkind IN ('r', 'p')
  LEFT JOIN pg_policy p ON p.polrelid = c.oid
  GROUP BY t.table_name, c.oid, c.relrowsecurity, c.relforcerowsecurity
)
SELECT 'table_rls' AS audit_kind,
       'public' AS schema_name,
       table_name AS object_name,
       jsonb_build_object(
         'table_exists', table_exists,
         'rls_enabled', rls_enabled,
         'rls_forced', rls_forced,
         'policy_count', policy_count
       ) AS evidence
FROM table_state
UNION ALL
SELECT 'policy' AS audit_kind,
       p.schemaname AS schema_name,
       p.tablename || '.' || p.policyname AS object_name,
       jsonb_build_object(
         'permissive', p.permissive,
         'roles', p.roles,
         'command', p.cmd,
         'using_expression', p.qual,
         'with_check_expression', p.with_check
       ) AS evidence
FROM pg_policies p
JOIN target_tables t ON t.table_name = p.tablename
WHERE p.schemaname = 'public'
ORDER BY audit_kind, schema_name, object_name;
