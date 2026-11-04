-- Action 08: make recovery decisions observable without changing room data
-- ownership or creating a second lifecycle model.

-- Forward repair for the Action 07 snapshot RPC. The original migration is
-- already deployed and must remain immutable; qualifying RETURNING removes
-- the PL/pgSQL output-column ambiguity reported by Supabase lint.
CREATE OR REPLACE FUNCTION public.upsert_room_realtime_snapshot(
  p_room_id uuid,
  p_snapshot_type text,
  p_state_version bigint,
  p_payload jsonb
)
RETURNS TABLE (
  snapshot_type text,
  state_version bigint,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  required_capability text;
  snapshot_row public.room_realtime_snapshots%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL
     OR p_snapshot_type NOT IN ('media', 'timer', 'settings')
     OR p_state_version < 1
     OR p_payload IS NULL
     OR jsonb_typeof(p_payload) <> 'object'
     OR octet_length(p_payload::text) > 65536 THEN
    RAISE EXCEPTION 'Invalid realtime snapshot.';
  END IF;

  required_capability := CASE p_snapshot_type
    WHEN 'media' THEN 'watch_control'
    WHEN 'timer' THEN 'study'
    WHEN 'settings' THEN 'manage_settings'
  END;

  IF NOT public.room_has_capability(p_room_id, auth.uid(), required_capability) THEN
    RAISE EXCEPTION 'Not authorized to update this realtime snapshot.';
  END IF;

  INSERT INTO public.room_realtime_snapshots AS target (
    room_id, snapshot_type, state_version, payload, updated_at, updated_by
  ) VALUES (
    p_room_id, p_snapshot_type, 1, p_payload, now(), auth.uid()
  )
  ON CONFLICT (room_id, snapshot_type) DO UPDATE
  SET state_version = target.state_version + 1,
      payload = EXCLUDED.payload,
      updated_at = EXCLUDED.updated_at,
      updated_by = EXCLUDED.updated_by
  RETURNING target.* INTO snapshot_row;

  IF NOT FOUND THEN
    SELECT s.*
    INTO snapshot_row
    FROM public.room_realtime_snapshots s
    WHERE s.room_id = p_room_id AND s.snapshot_type = p_snapshot_type;
  END IF;

  RETURN QUERY
  SELECT snapshot_row.snapshot_type, snapshot_row.state_version, snapshot_row.updated_at;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_room_realtime_snapshot(uuid, text, bigint, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_room_realtime_snapshot(uuid, text, bigint, jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.notify_room_recovery_decision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  notification_type text;
  notification_message text;
BEGIN
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('approved', 'rejected') THEN
    RETURN NEW;
  END IF;

  notification_type := CASE NEW.status
    WHEN 'approved' THEN 'recovery_approved'
    ELSE 'recovery_rejected'
  END;

  notification_message := CASE NEW.status
    WHEN 'approved' THEN 'Room recovery was approved. The room is reopened for seven days.'
    ELSE 'Room recovery was rejected. The room remains unavailable.'
  END;

  INSERT INTO public.room_notifications (
    room_id,
    recipient_id,
    notification_type,
    message,
    metadata
  )
  SELECT DISTINCT
    NEW.room_id,
    recipients.user_id,
    notification_type,
    notification_message,
    jsonb_build_object(
      'request_id', NEW.id,
      'requester_id', NEW.requester_id,
      'status', NEW.status,
      'reviewed_by', NEW.reviewed_by
    )
  FROM (
    SELECT NEW.requester_id AS user_id
    UNION
    SELECT rm.user_id
    FROM public.room_members rm
    WHERE rm.room_id = NEW.room_id
      AND rm.join_status = 'approved'
  ) recipients
  WHERE recipients.user_id IS NOT NULL
  ON CONFLICT (room_id, recipient_id, notification_type) DO NOTHING;

  RETURN NEW;
END;
$$;

-- This migration is forward-only. The trigger does not exist before Action 08,
-- and a pre-existing one already points at the function whose definition above
-- was replaced in place, so never drop it as part of deployment.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.recovery_requests'::regclass
      AND tgname = 'notify_room_recovery_decision'
      AND NOT tgisinternal
  ) THEN
    EXECUTE $trigger$
      CREATE TRIGGER notify_room_recovery_decision
      AFTER UPDATE OF status ON public.recovery_requests
      FOR EACH ROW
      EXECUTE FUNCTION public.notify_room_recovery_decision()
    $trigger$;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_room_recovery_decision() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_room_recovery_decision() TO service_role;

-- These functions are called by the authenticated room-entry path. Make the
-- intended RPC boundary explicit even if an earlier migration granted it.
REVOKE ALL ON FUNCTION public.get_my_room_join_eligibility(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_room_join_eligibility(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.room_lifecycle_state(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.room_lifecycle_state(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.notify_room_recovery_decision() IS
  'Creates private recovery outcome notifications for the requester and approved room members.';
