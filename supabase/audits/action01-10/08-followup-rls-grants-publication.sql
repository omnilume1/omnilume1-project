-- Query 08: follow-up for gaps in the 2026-11-04 exports. Read-only.
-- Run this file by itself and export the single result set.
-- Plain text columns (no JSON) keep each row short so the export is not cut
-- off like the 01 table_rls rows were.
--   table_rls      RLS state for every Action 01-10 table, including
--                  room_member_restrictions and room_control_events (01 listed
--                  the wrong name, room_restrictions).
--   client_grant   any TRUNCATE/TRIGGER/REFERENCES/MAINTAIN still held by
--                  PUBLIC, anon or authenticated on a public table. Expected:
--                  no rows after 20261104120000.
--   anon_execute   public functions anon can execute. Expected: none of
--                  is_room_admin_or_owner, get_room_for_join,
--                  review_recovery_request, review_permanent_room_request,
--                  convert_active_room_to_permanent after 20261104120000.
--   publication    Postgres Changes membership for every table the app subscribes to.
--   messages_insert the effective room branch of "Users can insert messages".
WITH target_tables(table_name) AS (
  VALUES
    ('profiles'), ('follows'), ('friend_requests'), ('friendships'), ('posts'),
    ('rooms'), ('room_members'), ('room_member_profiles'),
    ('room_control_settings'), ('room_role_permissions'), ('room_invites'),
    ('room_member_restrictions'), ('room_control_events'), ('room_announcements'),
    ('room_messages'), ('messages'), ('message_reactions'), ('message_requests'),
    ('private_chats'), ('recovery_requests'), ('room_permanent_requests'),
    ('room_notifications'), ('temporary_media'), ('room_files'),
    ('room_cleanup_jobs'), ('temporary_media_cleanup_jobs'),
    ('room_realtime_snapshots'), ('study_notes'), ('pdf_annotations'),
    ('room_whiteboards')
), subscribed_tables(table_name) AS (
  VALUES ('friendships'), ('message_requests'), ('private_chats'), ('messages'),
         ('room_control_events')
)
SELECT 'table_rls' AS audit_kind,
       t.table_name AS object_name,
       CASE
         WHEN c.oid IS NULL THEN 'MISSING'
         ELSE 'rls=' || c.relrowsecurity || ' forced=' || c.relforcerowsecurity
              || ' policies=' || (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)
       END AS status
FROM target_tables t
LEFT JOIN pg_class c
  ON c.relnamespace = 'public'::regnamespace
 AND c.relname = t.table_name
 AND c.relkind IN ('r', 'p')
UNION ALL
SELECT 'client_grant',
       c.relname || '.' || CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE acl.grantee::regrole::text END,
       acl.privilege_type
FROM pg_class c
CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) acl
WHERE c.relnamespace = 'public'::regnamespace
  AND c.relkind IN ('r', 'p')
  AND acl.privilege_type IN ('TRUNCATE', 'TRIGGER', 'REFERENCES', 'MAINTAIN')
  AND (acl.grantee = 0 OR acl.grantee IN ('anon'::regrole, 'authenticated'::regrole))
UNION ALL
SELECT 'anon_execute',
       p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
       CASE WHEN p.prosecdef THEN 'security_definer' ELSE 'security_invoker' END
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND has_function_privilege('anon', p.oid, 'EXECUTE')
UNION ALL
SELECT 'publication',
       s.table_name,
       CASE WHEN pt.tablename IS NULL THEN 'absent' ELSE 'present' END
FROM subscribed_tables s
LEFT JOIN pg_publication_tables pt
  ON pt.pubname = 'supabase_realtime'
 AND pt.schemaname = 'public'
 AND pt.tablename = s.table_name
UNION ALL
SELECT 'messages_insert',
       p.policyname,
       CASE
         WHEN p.with_check LIKE '%room_has_capability(room_id, auth.uid(), ''chat''::text)%'
           THEN 'room branch requires chat capability'
         ELSE 'room branch lacks chat capability'
       END
FROM pg_policies p
WHERE p.schemaname = 'public'
  AND p.tablename = 'messages'
  AND p.policyname = 'Users can insert messages'
ORDER BY audit_kind, object_name, status;
