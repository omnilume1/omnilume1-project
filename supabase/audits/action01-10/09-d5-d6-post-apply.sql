-- Query 09: post-apply verification for 20261105090000 (D5, D6) and
-- 20261105100000 (D8). Read-only. 11 rows.
-- Run this file by itself after `supabase db push`. Every row must report
-- `ok`. Any other status means the deployed catalog does not match the
-- reviewed migration.
WITH notify_fn AS (
  SELECT p.oid, p.prosecdef, p.proconfig, pg_get_functiondef(p.oid) AS def
  FROM pg_proc p
  WHERE p.oid = 'public.notify_room_recovery_decision()'::regprocedure
), helper_fn AS (
  SELECT p.oid, p.prosecdef, p.proconfig, p.provolatile
  FROM pg_proc p
  WHERE p.proname = 'room_file_owned_by_caller'
    AND p.pronamespace = 'public'::regnamespace
), delete_policy AS (
  SELECT qual
  FROM pg_policies
  WHERE schemaname = 'storage' AND tablename = 'objects'
    AND policyname = 'Members can delete active room attachments'
)
SELECT 'd5_variables_renamed' AS check_name,
       CASE WHEN def ~ '\mv_notification_type\s+text;' AND def !~ '\m(?<!v_)notification_type\s+text;' THEN 'ok' ELSE 'FAIL' END AS status
FROM notify_fn
UNION ALL
SELECT 'd5_security_definer_empty_search_path',
       CASE WHEN prosecdef AND proconfig @> ARRAY['search_path=""'] THEN 'ok' ELSE 'FAIL' END
FROM notify_fn
UNION ALL
SELECT 'd5_no_client_execute',
       CASE WHEN NOT has_function_privilege('anon', oid, 'EXECUTE')
             AND NOT has_function_privilege('authenticated', oid, 'EXECUTE') THEN 'ok' ELSE 'FAIL' END
FROM notify_fn
UNION ALL
SELECT 'd5_trigger_still_bound',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_trigger t
         WHERE t.tgrelid = 'public.recovery_requests'::regclass
           AND t.tgname = 'notify_room_recovery_decision'
           AND t.tgfoid = 'public.notify_room_recovery_decision()'::regprocedure
           AND t.tgenabled <> 'D'
       ) THEN 'ok' ELSE 'FAIL' END
UNION ALL
SELECT 'd6_helper_present',
       CASE WHEN count(*) = 1 THEN 'ok' ELSE 'FAIL' END
FROM helper_fn
UNION ALL
SELECT 'd6_helper_security_definer_stable_empty_search_path',
       CASE WHEN h.prosecdef AND h.provolatile = 's' AND h.proconfig @> ARRAY['search_path=""'] THEN 'ok' ELSE 'FAIL' END
FROM (SELECT 1) probe LEFT JOIN helper_fn h ON true
UNION ALL
SELECT 'd6_helper_execute_authenticated_only',
       CASE WHEN h.oid IS NOT NULL
             AND has_function_privilege('authenticated', h.oid, 'EXECUTE')
             AND NOT has_function_privilege('anon', h.oid, 'EXECUTE') THEN 'ok' ELSE 'FAIL' END
FROM (SELECT 1) probe LEFT JOIN helper_fn h ON true
UNION ALL
SELECT 'd6_policy_uses_helper_not_room_files',
       CASE WHEN qual LIKE '%room_file_owned_by_caller(bucket_id, name)%'
             AND qual NOT LIKE '%FROM room_files%'
             AND qual LIKE '%room_storage_path_room_id(name) IS NOT NULL%'
             AND qual LIKE '%''watch_control''::text%' THEN 'ok' ELSE 'FAIL' END
FROM delete_policy
UNION ALL
SELECT 'd6_room_files_still_unreadable_by_clients',
       CASE WHEN NOT has_table_privilege('authenticated', 'public.room_files', 'SELECT')
             AND NOT has_table_privilege('anon', 'public.room_files', 'SELECT') THEN 'ok' ELSE 'FAIL' END
UNION ALL
-- D8 (20261105100000): the subtitle path regex uses a single backslash.
SELECT 'd8_subtitle_regex_single_backslash',
       CASE WHEN position('[0-9a-f]{12}\.(vtt|srt)$' IN pg_get_functiondef('public.set_temporary_media_subtitle(uuid, text)'::regprocedure)) > 0
             AND position('[0-9a-f]{12}\\.(vtt|srt)$' IN pg_get_functiondef('public.set_temporary_media_subtitle(uuid, text)'::regprocedure)) = 0
            THEN 'ok' ELSE 'FAIL' END
UNION ALL
SELECT 'd8_subtitle_rpc_execute_authenticated_only',
       CASE WHEN has_function_privilege('authenticated', 'public.set_temporary_media_subtitle(uuid, text)'::regprocedure, 'EXECUTE')
             AND NOT has_function_privilege('anon', 'public.set_temporary_media_subtitle(uuid, text)'::regprocedure, 'EXECUTE')
            THEN 'ok' ELSE 'FAIL' END
ORDER BY check_name;
