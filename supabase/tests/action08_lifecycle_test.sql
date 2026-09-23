BEGIN;
SELECT plan(18);

SELECT has_table(
  'public', 'room_notifications',
  'room lifecycle notifications have durable storage'
);

SELECT has_table(
  'public', 'room_cleanup_jobs',
  'irreversible cleanup has durable retry records'
);

SELECT has_function(
  'public', 'room_lifecycle_state', ARRAY['uuid'],
  'room lifecycle state is server authoritative'
);

SELECT has_function(
  'public', 'room_in_recovery_window', ARRAY['uuid'],
  'recovery window has a dedicated server helper'
);

SELECT has_function(
  'public', 'get_my_room_join_eligibility', ARRAY['uuid'],
  'room entry uses lifecycle-aware eligibility'
);

SELECT has_function(
  'public', 'notify_room_recovery_decision', ARRAY[]::text[],
  'recovery decisions have a notification trigger function'
);

SELECT ok(
  has_function_privilege(
    'authenticated',
    'public.get_my_room_join_eligibility(uuid)',
    'EXECUTE'
  ),
  'authenticated clients can call the room eligibility RPC'
);

SELECT ok(
  has_function_privilege(
    'authenticated',
    'public.room_lifecycle_state(uuid)',
    'EXECUTE'
  ),
  'authenticated clients can resolve lifecycle state'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.recovery_requests'::regclass
      AND tgname = 'notify_room_recovery_decision'
  ),
  'recovery decisions trigger private notifications'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_trigger t
    WHERE t.tgrelid = 'public.recovery_requests'::regclass
      AND t.tgname = 'notify_room_recovery_decision'
      AND pg_get_triggerdef(t.oid) LIKE '%AFTER UPDATE OF status%'
  ),
  'only recovery status transitions can create recovery notifications'
);

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.notify_room_recovery_decision()',
    'EXECUTE'
  ),
  'clients cannot invoke the notification trigger function directly'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'room_notifications'
      AND policyname = 'Recipients can read room notifications'
      AND qual LIKE '%recipient_id = auth.uid()%'
  ),
  'notifications remain visible only to their recipient'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'room_notifications'
      AND indexdef LIKE '%UNIQUE%room_id, recipient_id, notification_type%'
  ),
  'recovery outcomes use a recipient-scoped uniqueness boundary'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE oid = 'public.notify_room_recovery_decision()'::regprocedure
      AND prosrc LIKE '%rm.join_status = ''approved''%'
      AND prosrc LIKE '%ON CONFLICT (room_id, recipient_id, notification_type) DO NOTHING%'
  ),
  'notifications target approved members and suppress duplicate outcomes'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE oid = 'public.room_lifecycle_state(uuid)'::regprocedure
      AND prosrc LIKE '%recovery-window%'
  ),
  'lifecycle helper contains an explicit recovery-window state'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE oid = 'public.review_recovery_request(uuid,text)'::regprocedure
      AND prosrc LIKE '%room_in_recovery_window(request_row.room_id)%'
      AND prosrc LIKE '%7 days%'
  )
  AND EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE oid = 'public.room_lifecycle_state(uuid)'::regprocedure
      AND prosrc LIKE '%24 hours%'
  ),
  'recovery approval delegates the 24-hour boundary and sets a seven-day reopen deadline'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE oid = 'public.upsert_room_realtime_snapshot(uuid,text,bigint,jsonb)'::regprocedure
      AND prosrc LIKE '%RETURNING target.*%'
  ),
  'snapshot RPC qualifies its returning row against output columns'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE oid = 'public.upsert_room_realtime_snapshot(uuid,text,bigint,jsonb)'::regprocedure
      AND prosrc LIKE '%ON CONFLICT ON CONSTRAINT room_realtime_snapshots_pkey%'
  ),
  'snapshot RPC uses the inspected primary-key constraint rather than output-column names'
);

SELECT * FROM finish();
ROLLBACK;
