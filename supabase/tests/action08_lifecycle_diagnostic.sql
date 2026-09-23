-- Read-only Action 08 diagnostic for Supabase SQL Editor.
-- This query only reads PostgreSQL catalogs and function metadata. It does not
-- call any application RPC, write table data, or change schema/privileges.

WITH function_defs AS (
  SELECT
    p.oid,
    n.nspname AS schema_name,
    p.proname AS function_name,
    pg_get_function_identity_arguments(p.oid) AS identity_arguments,
    oidvectortypes(p.proargtypes) AS argument_types,
    n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS signature,
    pg_get_functiondef(p.oid) AS definition,
    p.prosrc
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'room_lifecycle_state',
      'room_in_recovery_window',
      'review_recovery_request',
      'upsert_room_realtime_snapshot',
      'get_my_room_join_eligibility',
      'notify_room_recovery_decision'
    )
),
trigger_defs AS (
  SELECT COALESCE(
    string_agg(pg_get_triggerdef(t.oid, true), E'\n' ORDER BY t.tgname),
    'NOT FOUND'
  ) AS value
  FROM pg_trigger t
  WHERE t.tgrelid = 'public.recovery_requests'::regclass
    AND t.tgname = 'notify_room_recovery_decision'
    AND NOT t.tgisinternal
),
policy_defs AS (
  SELECT COALESCE(
    string_agg(
      format('policy=%s; using=%s; check=%s', policyname, COALESCE(qual, 'NULL'), COALESCE(with_check, 'NULL')),
      E'\n' ORDER BY policyname
    ),
    'NOT FOUND'
  ) AS value
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'room_notifications'
),
notification_indexes AS (
  SELECT COALESCE(
    string_agg(indexdef, E'\n' ORDER BY indexname),
    'NOT FOUND'
  ) AS value
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename = 'room_notifications'
    AND indexdef ILIKE '%UNIQUE%'
),
snapshot_constraints AS (
  SELECT COALESCE(
    string_agg(
      format('%I.%I: %s', n.nspname, c.conname, pg_get_constraintdef(c.oid, true)),
      E'\n' ORDER BY c.conname
    ),
    'NOT FOUND'
  ) AS value
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = r.relnamespace
  WHERE n.nspname = 'public'
    AND r.relname = 'room_realtime_snapshots'
    AND c.contype IN ('p', 'u')
    AND pg_get_constraintdef(c.oid, true) ILIKE '%room_id%'
    AND pg_get_constraintdef(c.oid, true) ILIKE '%snapshot_type%'
),
assertions AS (
  SELECT 1 AS assertion_no, 'room_notifications table exists' AS assertion,
    to_regclass('public.room_notifications') IS NOT NULL AS passed,
    COALESCE(to_regclass('public.room_notifications')::text, 'NOT FOUND') AS actual_value
  UNION ALL SELECT 2, 'room_cleanup_jobs table exists',
    to_regclass('public.room_cleanup_jobs') IS NOT NULL,
    COALESCE(to_regclass('public.room_cleanup_jobs')::text, 'NOT FOUND')
  UNION ALL SELECT 3, 'room_lifecycle_state(uuid) exists',
    EXISTS (SELECT 1 FROM function_defs WHERE function_name = 'room_lifecycle_state' AND argument_types = 'uuid'),
    COALESCE((SELECT string_agg(signature, E'\n' ORDER BY signature) FROM function_defs WHERE function_name = 'room_lifecycle_state'), 'NOT FOUND')
  UNION ALL SELECT 4, 'room_in_recovery_window(uuid) exists',
    EXISTS (SELECT 1 FROM function_defs WHERE function_name = 'room_in_recovery_window' AND argument_types = 'uuid'),
    COALESCE((SELECT string_agg(signature, E'\n' ORDER BY signature) FROM function_defs WHERE function_name = 'room_in_recovery_window'), 'NOT FOUND')
  UNION ALL SELECT 5, 'get_my_room_join_eligibility(uuid) exists',
    EXISTS (SELECT 1 FROM function_defs WHERE function_name = 'get_my_room_join_eligibility' AND argument_types = 'uuid'),
    COALESCE((SELECT string_agg(signature, E'\n' ORDER BY signature) FROM function_defs WHERE function_name = 'get_my_room_join_eligibility'), 'NOT FOUND')
  UNION ALL SELECT 6, 'notify_room_recovery_decision() exists',
    EXISTS (SELECT 1 FROM function_defs WHERE function_name = 'notify_room_recovery_decision' AND argument_types = ''),
    COALESCE((SELECT string_agg(signature, E'\n' ORDER BY signature) FROM function_defs WHERE function_name = 'notify_room_recovery_decision'), 'NOT FOUND')
  UNION ALL SELECT 7, 'authenticated can execute get_my_room_join_eligibility',
    EXISTS (
      SELECT 1 FROM function_defs f
      WHERE f.function_name = 'get_my_room_join_eligibility'
        AND f.argument_types = 'uuid'
        AND has_function_privilege('authenticated', f.oid, 'EXECUTE')
    ),
    COALESCE((SELECT string_agg(f.signature || ' EXECUTE=' || has_function_privilege('authenticated', f.oid, 'EXECUTE')::text, E'\n' ORDER BY f.signature) FROM function_defs f WHERE f.function_name = 'get_my_room_join_eligibility'), 'NOT FOUND')
  UNION ALL SELECT 8, 'authenticated can execute room_lifecycle_state',
    EXISTS (
      SELECT 1 FROM function_defs f
      WHERE f.function_name = 'room_lifecycle_state'
        AND f.argument_types = 'uuid'
        AND has_function_privilege('authenticated', f.oid, 'EXECUTE')
    ),
    COALESCE((SELECT string_agg(f.signature || ' EXECUTE=' || has_function_privilege('authenticated', f.oid, 'EXECUTE')::text, E'\n' ORDER BY f.signature) FROM function_defs f WHERE f.function_name = 'room_lifecycle_state'), 'NOT FOUND')
  UNION ALL SELECT 9, 'recovery decision trigger exists',
    EXISTS (
      SELECT 1 FROM pg_trigger t
      WHERE t.tgrelid = 'public.recovery_requests'::regclass
        AND t.tgname = 'notify_room_recovery_decision'
        AND NOT t.tgisinternal
    ),
    (SELECT value FROM trigger_defs)
  UNION ALL SELECT 10, 'trigger is AFTER UPDATE OF status',
    (SELECT value LIKE '%AFTER UPDATE OF status%' FROM trigger_defs),
    (SELECT value FROM trigger_defs)
  UNION ALL SELECT 11, 'authenticated cannot execute notification trigger function',
    NOT EXISTS (
      SELECT 1 FROM function_defs f
      WHERE f.function_name = 'notify_room_recovery_decision'
        AND f.argument_types = ''
        AND has_function_privilege('authenticated', f.oid, 'EXECUTE')
    ),
    COALESCE((SELECT string_agg(f.signature || ' EXECUTE=' || has_function_privilege('authenticated', f.oid, 'EXECUTE')::text, E'\n' ORDER BY f.signature) FROM function_defs f WHERE f.function_name = 'notify_room_recovery_decision'), 'NOT FOUND')
  UNION ALL SELECT 12, 'notification policy restricts reads to recipient_id = auth.uid()',
    EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'room_notifications'
        AND policyname = 'Recipients can read room notifications'
        AND qual LIKE '%recipient_id = auth.uid()%'
    ),
    (SELECT value FROM policy_defs)
  UNION ALL SELECT 13, 'notification uniqueness index is recipient-scoped',
    EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'room_notifications'
        AND indexdef LIKE '%UNIQUE%room_id, recipient_id, notification_type%'
    ),
    (SELECT value FROM notification_indexes)
  UNION ALL SELECT 14, 'notification trigger targets approved members and deduplicates',
    EXISTS (
      SELECT 1 FROM function_defs
      WHERE function_name = 'notify_room_recovery_decision'
        AND prosrc LIKE '%rm.join_status = ''approved''%'
        AND prosrc LIKE '%ON CONFLICT (room_id, recipient_id, notification_type) DO NOTHING%'
    ),
    COALESCE((SELECT string_agg(signature || E'\n' || prosrc, E'\n\n' ORDER BY signature) FROM function_defs WHERE function_name = 'notify_room_recovery_decision'), 'NOT FOUND')
  UNION ALL SELECT 15, 'room_lifecycle_state contains recovery-window state',
    EXISTS (
      SELECT 1 FROM function_defs
      WHERE function_name = 'room_lifecycle_state'
        AND prosrc LIKE '%recovery-window%'
    ),
    COALESCE((SELECT string_agg(signature || E'\n' || prosrc, E'\n\n' ORDER BY signature) FROM function_defs WHERE function_name = 'room_lifecycle_state'), 'NOT FOUND')
  UNION ALL SELECT 16, 'recovery delegates 24-hour boundary and sets seven-day reopen',
    EXISTS (
      SELECT 1 FROM function_defs
      WHERE function_name = 'review_recovery_request'
        AND prosrc LIKE '%room_in_recovery_window(request_row.room_id)%'
        AND prosrc LIKE '%7 days%'
    )
    AND EXISTS (
      SELECT 1 FROM function_defs
      WHERE function_name = 'room_lifecycle_state'
        AND prosrc LIKE '%24 hours%'
    ),
    format('review=%s; lifecycle=%s',
      COALESCE((SELECT string_agg(signature || E'\n' || prosrc, E'\n\n' ORDER BY signature) FROM function_defs WHERE function_name = 'review_recovery_request'), 'NOT FOUND'),
      COALESCE((SELECT string_agg(signature || E'\n' || prosrc, E'\n\n' ORDER BY signature) FROM function_defs WHERE function_name = 'room_lifecycle_state'), 'NOT FOUND'))
  UNION ALL SELECT 17, 'snapshot function qualifies RETURNING target.*',
    EXISTS (
      SELECT 1 FROM function_defs
      WHERE function_name = 'upsert_room_realtime_snapshot'
        AND prosrc LIKE '%RETURNING target.*%'
    ),
    COALESCE((SELECT string_agg(signature || E'\n' || prosrc, E'\n\n' ORDER BY signature) FROM function_defs WHERE function_name = 'upsert_room_realtime_snapshot'), 'NOT FOUND')
  UNION ALL SELECT 18, 'snapshot function uses room_realtime_snapshots_pkey',
    EXISTS (
      SELECT 1 FROM function_defs
      WHERE function_name = 'upsert_room_realtime_snapshot'
        AND prosrc LIKE '%ON CONFLICT ON CONSTRAINT room_realtime_snapshots_pkey%'
    ),
    format('function=%s; constraints=%s',
      COALESCE((SELECT string_agg(signature || E'\n' || prosrc, E'\n\n' ORDER BY signature) FROM function_defs WHERE function_name = 'upsert_room_realtime_snapshot'), 'NOT FOUND'),
      (SELECT value FROM snapshot_constraints))
)
SELECT 'assertion' AS record_type, assertion_no, assertion, passed, actual_value
FROM assertions

UNION ALL

SELECT 'function_definition', NULL, signature, NULL,
  format('schema=%s; function=%s; identity_arguments=%s\n\n%s', schema_name, function_name, identity_arguments, definition)
FROM function_defs

UNION ALL

SELECT 'trigger_definition', NULL, 'public.recovery_requests.notify_room_recovery_decision', NULL, value
FROM trigger_defs

UNION ALL

SELECT 'policy_definition', NULL, 'public.room_notifications', NULL, value
FROM policy_defs

UNION ALL

SELECT 'unique_index_definition', NULL, 'public.room_notifications', NULL, value
FROM notification_indexes

UNION ALL

SELECT 'snapshot_constraint_definition', NULL, 'public.room_realtime_snapshots', NULL, value
FROM snapshot_constraints

ORDER BY record_type, assertion_no NULLS LAST, assertion;
