BEGIN;
SELECT plan(14);

SELECT has_column(
  'public', 'rooms', 'scheduled_for',
  'rooms retain an explicit scheduled start time'
);

SELECT has_column(
  'public', 'room_members', 'is_ghost_mode',
  'members retain an explicit ghost-presence preference'
);

SELECT col_not_null(
  'public', 'room_members', 'is_ghost_mode',
  'ghost-presence preference is always defined'
);

SELECT has_table(
  'public', 'room_realtime_snapshots',
  'late-join realtime snapshots have durable storage'
);

SELECT has_table(
  'public', 'room_cleanup_jobs',
  'cleanup work is tracked durably for retry'
);

SELECT has_function(
  'public', 'room_lifecycle_state', ARRAY['uuid'],
  'room lifecycle state is calculated by an authoritative helper'
);

SELECT has_function(
  'public', 'set_room_ghost_mode', ARRAY['uuid', 'boolean'],
  'members can change ghost mode through an authorized RPC'
);

SELECT has_function(
  'public', 'get_my_room_presence_mode', ARRAY['uuid'],
  'clients can resolve their authorized presence scope'
);

SELECT has_function(
  'public', 'upsert_room_realtime_snapshot', ARRAY['uuid', 'text', 'bigint', 'jsonb'],
  'authorized feature state uses monotonic durable snapshots'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE oid = 'public.upsert_room_realtime_snapshot(uuid,text,bigint,jsonb)'::regprocedure
      AND prosrc LIKE '%state_version + 1%'
  ),
  'snapshot versions are allocated under the database row lock'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'room_members'
      AND policyname = 'Active room members respect ghost visibility'
  ),
  'room-member reads honor ghost visibility'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'realtime'
      AND tablename = 'messages'
      AND policyname = 'Room members publish capability-scoped realtime'
  ),
  'realtime publication is capability-scoped'
);

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.room_realtime_snapshots', 'SELECT'),
  'snapshots cannot be read directly by authenticated users'
);

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.room_cleanup_jobs', 'SELECT'),
  'cleanup jobs cannot be read directly by authenticated users'
);

SELECT * FROM finish();
ROLLBACK;
