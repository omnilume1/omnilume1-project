-- Action 08 forward repair: output-column names in a PL/pgSQL RETURNS TABLE
-- function must not be used as inferred conflict-target columns. The linked
-- database's room_realtime_snapshots_pkey is the composite primary key on
-- (room_id, snapshot_type), inspected before this migration was written.

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

  -- The database owns version allocation. ON CONSTRAINT avoids resolving the
  -- RETURNS TABLE output name snapshot_type as a PL/pgSQL variable.
  INSERT INTO public.room_realtime_snapshots AS target (
    room_id, snapshot_type, state_version, payload, updated_at, updated_by
  ) VALUES (
    p_room_id, p_snapshot_type, 1, p_payload, now(), auth.uid()
  )
  ON CONFLICT ON CONSTRAINT room_realtime_snapshots_pkey DO UPDATE
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
