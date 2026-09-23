-- Actions 05–07: authoritative lifecycle, membership visibility, and
-- capability-scoped Realtime. This migration is additive: it extends the
-- existing room, membership, control, and Realtime architecture without
-- replacing its records or creating a parallel sync system.

ALTER TABLE public.rooms
  ADD COLUMN IF NOT EXISTS scheduled_for timestamptz;

ALTER TABLE public.room_members
  ADD COLUMN IF NOT EXISTS is_ghost_mode boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS rooms_scheduled_for_idx
  ON public.rooms (scheduled_for)
  WHERE scheduled_for IS NOT NULL;

CREATE INDEX IF NOT EXISTS room_members_active_access_idx
  ON public.room_members (room_id, user_id, join_status, guest_expires_at);

CREATE TABLE IF NOT EXISTS public.room_cleanup_jobs (
  room_id uuid PRIMARY KEY REFERENCES public.rooms(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.room_realtime_snapshots (
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  snapshot_type text NOT NULL CHECK (snapshot_type IN ('media', 'timer', 'settings')),
  state_version bigint NOT NULL CHECK (state_version > 0),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  PRIMARY KEY (room_id, snapshot_type)
);

CREATE INDEX IF NOT EXISTS room_cleanup_jobs_pending_idx
  ON public.room_cleanup_jobs (created_at)
  WHERE status IN ('pending', 'failed');

ALTER TABLE public.room_cleanup_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_realtime_snapshots ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.room_cleanup_jobs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.room_realtime_snapshots FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.validate_room_schedule()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $$
BEGIN
  IF NEW.scheduled_for IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.scheduled_for <= now() THEN
    RAISE EXCEPTION 'Scheduled rooms require a future start timestamp.';
  END IF;

  IF NEW.expiration_type <> 'permanent'
     AND (NEW.expires_at IS NULL OR NEW.expires_at <= NEW.scheduled_for) THEN
    RAISE EXCEPTION 'Temporary rooms must expire after their scheduled start.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_room_schedule ON public.rooms;
CREATE TRIGGER validate_room_schedule
BEFORE INSERT OR UPDATE OF scheduled_for, expiration_type, expires_at ON public.rooms
FOR EACH ROW
EXECUTE FUNCTION public.validate_room_schedule();

CREATE OR REPLACE FUNCTION public.room_lifecycle_state(p_room_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  room_row public.rooms%ROWTYPE;
  room_locked boolean := false;
BEGIN
  SELECT r.*
  INTO room_row
  FROM public.rooms r
  WHERE r.id = p_room_id;

  IF NOT FOUND THEN
    RETURN 'destroyed';
  END IF;

  SELECT s.is_locked
  INTO room_locked
  FROM public.room_control_settings s
  WHERE s.room_id = p_room_id;
  room_locked := COALESCE(room_locked, false);

  IF room_row.scheduled_for IS NOT NULL AND room_row.scheduled_for > now() THEN
    RETURN 'scheduled';
  END IF;

  IF room_row.expiration_type = 'permanent' THEN
    RETURN CASE WHEN room_locked THEN 'locked' ELSE 'permanent' END;
  END IF;

  IF room_row.reopened_until IS NOT NULL AND room_row.reopened_until > now() THEN
    RETURN CASE WHEN room_locked THEN 'locked' ELSE 'reopened' END;
  END IF;

  IF room_row.expires_at IS NOT NULL AND room_row.expires_at > now() THEN
    RETURN CASE WHEN room_locked THEN 'locked' ELSE 'active' END;
  END IF;

  IF room_row.expiration_type = 'recoverable'
     AND room_row.expires_at IS NOT NULL
     AND now() <= room_row.expires_at + interval '24 hours' THEN
    RETURN 'recovery-window';
  END IF;

  RETURN 'destroyed';
END;
$$;

CREATE OR REPLACE FUNCTION public.room_has_active_access(p_room_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT public.room_lifecycle_state(p_room_id) IN ('active', 'reopened', 'permanent', 'locked');
$$;

CREATE OR REPLACE FUNCTION public.room_in_recovery_window(p_room_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT public.room_lifecycle_state(p_room_id) = 'recovery-window';
$$;

CREATE OR REPLACE FUNCTION public.room_can_join(p_room_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT
    (auth.uid() = p_user_id OR COALESCE(current_setting('request.jwt.claim.role', true), '') = 'service_role')
    AND public.room_lifecycle_state(p_room_id) IN ('active', 'reopened', 'permanent')
    AND NOT public.room_user_is_restricted(p_room_id, p_user_id);
$$;

CREATE OR REPLACE FUNCTION public.get_room_by_identifier(identifier text)
RETURNS SETOF public.rooms
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT r.*
  FROM public.rooms r
  WHERE (lower(r.username) = lower(identifier) OR r.id::text = identifier)
    AND (
      (
        public.room_has_active_access(r.id)
        AND (
          NOT r.is_private
          OR public.is_approved_room_member(r.id, auth.uid())
          OR r.created_by = auth.uid()
        )
      )
      OR (
        public.room_lifecycle_state(r.id) = 'scheduled'
        AND (r.created_by = auth.uid() OR public.is_approved_room_member(r.id, auth.uid()))
      )
      OR (
        public.room_in_recovery_window(r.id)
        AND public.is_room_admin_or_owner(r.id, auth.uid())
      )
    )
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.get_my_room_join_eligibility(p_room_id uuid)
RETURNS TABLE (
  state text,
  can_join boolean,
  join_status text,
  role text,
  guest_expires_at timestamptz,
  restriction_types text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  room_row public.rooms%ROWTYPE;
  member_exists boolean := false;
  member_join_status text;
  member_role text;
  member_guest_expires_at timestamptz;
  active_restrictions text[];
  lifecycle text;
  next_join_status text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT r.* INTO room_row FROM public.rooms r WHERE r.id = p_room_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unavailable'::text, false, NULL::text, NULL::text, NULL::timestamptz, ARRAY[]::text[];
    RETURN;
  END IF;

  lifecycle := public.room_lifecycle_state(p_room_id);

  SELECT COALESCE(array_agg(r.restriction_type ORDER BY r.restriction_type), ARRAY[]::text[])
  INTO active_restrictions
  FROM public.room_member_restrictions r
  WHERE r.room_id = p_room_id
    AND r.user_id = auth.uid()
    AND (r.expires_at IS NULL OR r.expires_at > now());

  SELECT rm.join_status, rm.role, rm.guest_expires_at
  INTO member_join_status, member_role, member_guest_expires_at
  FROM public.room_members rm
  WHERE rm.room_id = p_room_id AND rm.user_id = auth.uid();
  member_exists := FOUND;

  IF 'ban' = ANY(active_restrictions) THEN
    RETURN QUERY SELECT 'banned'::text, false, member_join_status, member_role, member_guest_expires_at, active_restrictions;
    RETURN;
  END IF;
  IF 'block' = ANY(active_restrictions) THEN
    RETURN QUERY SELECT 'blocked'::text, false, member_join_status, member_role, member_guest_expires_at, active_restrictions;
    RETURN;
  END IF;

  IF member_exists AND member_role = 'guest' AND member_guest_expires_at <= now() THEN
    RETURN QUERY SELECT 'guest_expired'::text, false, member_join_status, member_role, member_guest_expires_at, active_restrictions;
    RETURN;
  END IF;

  IF lifecycle = 'scheduled' THEN
    RETURN QUERY SELECT 'scheduled'::text, false, member_join_status, member_role, member_guest_expires_at, active_restrictions;
    RETURN;
  END IF;

  IF member_exists THEN
    IF member_join_status = 'approved' AND public.is_approved_room_member(p_room_id, auth.uid()) THEN
      RETURN QUERY SELECT 'already_joined'::text, false, member_join_status, member_role, member_guest_expires_at, active_restrictions;
    END IF;
    RETURN QUERY SELECT COALESCE(member_join_status, 'unavailable')::text, false, member_join_status, member_role, member_guest_expires_at, active_restrictions;
    RETURN;
  END IF;

  IF lifecycle NOT IN ('active', 'reopened', 'permanent') THEN
    RETURN QUERY SELECT 'unavailable'::text, false, NULL::text, NULL::text, NULL::timestamptz, active_restrictions;
    RETURN;
  END IF;
  IF NOT public.room_can_join(p_room_id, auth.uid()) THEN
    RETURN QUERY SELECT 'restricted'::text, false, NULL::text, NULL::text, NULL::timestamptz, active_restrictions;
    RETURN;
  END IF;

  next_join_status := CASE WHEN room_row.is_private THEN 'pending' ELSE 'approved' END;
  RETURN QUERY SELECT 'eligible'::text, true, next_join_status, NULL::text, NULL::timestamptz, active_restrictions;
END;
$$;

CREATE OR REPLACE FUNCTION public.transfer_room_ownership(p_room_id uuid, p_target_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  target_role text;
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.room_has_active_access(p_room_id)
     OR NOT EXISTS (
       SELECT 1 FROM public.rooms r
       WHERE r.id = p_room_id AND r.created_by = auth.uid()
     ) THEN
    RAISE EXCEPTION 'Only the active room owner can transfer ownership.';
  END IF;

  IF p_target_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Choose a different eligible member to transfer ownership.';
  END IF;

  SELECT rm.role
  INTO target_role
  FROM public.room_members rm
  WHERE rm.room_id = p_room_id
    AND rm.user_id = p_target_user_id
    AND rm.join_status = 'approved'
    AND rm.role <> 'guest'
    AND rm.guest_expires_at IS NULL
  FOR UPDATE;

  IF target_role IS NULL
     OR public.room_user_is_restricted(p_room_id, p_target_user_id) THEN
    RAISE EXCEPTION 'The new owner must be an approved permanent member.';
  END IF;

  PERFORM set_config('app.omnilume_room_control', 'ownership_transfer', true);
  UPDATE public.room_members
  SET role = 'admin'
  WHERE room_id = p_room_id AND user_id = auth.uid();
  UPDATE public.room_members
  SET role = 'owner'
  WHERE room_id = p_room_id AND user_id = p_target_user_id;
  UPDATE public.rooms
  SET created_by = p_target_user_id
  WHERE id = p_room_id;

  PERFORM public.record_room_control_event(
    p_room_id,
    'ownership_changed',
    p_target_user_id,
    jsonb_build_object('previous_owner_id', auth.uid())
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.room_can_view_member(
  p_room_id uuid,
  p_target_user_id uuid,
  p_viewer_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_viewer_id THEN
    RETURN false;
  END IF;

  IF NOT public.room_has_active_access(p_room_id)
     OR NOT public.is_approved_room_member(p_room_id, p_viewer_id) THEN
    RETURN false;
  END IF;

  IF p_target_user_id = p_viewer_id
     OR public.is_room_admin_or_owner(p_room_id, p_viewer_id) THEN
    RETURN true;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.room_members rm
    WHERE rm.room_id = p_room_id
      AND rm.user_id = p_target_user_id
      AND rm.join_status = 'approved'
      AND (rm.guest_expires_at IS NULL OR rm.guest_expires_at > now())
      AND NOT rm.is_ghost_mode
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_room_ghost_mode(
  p_room_id uuid,
  p_is_ghost_mode boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.room_has_active_access(p_room_id)
     OR NOT public.is_approved_room_member(p_room_id, auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized to update room presence.';
  END IF;

  UPDATE public.room_members
  SET is_ghost_mode = p_is_ghost_mode
  WHERE room_id = p_room_id AND user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Room membership is unavailable.';
  END IF;

  RETURN p_is_ghost_mode;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_my_room_presence_mode(p_room_id uuid)
RETURNS TABLE (
  is_ghost_mode boolean,
  can_view_ghost_presence boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.room_has_active_access(p_room_id)
     OR NOT public.is_approved_room_member(p_room_id, auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized to view room presence.';
  END IF;

  RETURN QUERY
  SELECT rm.is_ghost_mode,
         public.room_has_capability(p_room_id, auth.uid(), 'manage_members')
  FROM public.room_members rm
  WHERE rm.room_id = p_room_id AND rm.user_id = auth.uid();
END;
$$;

CREATE OR REPLACE FUNCTION public.get_room_member_presence_modes(p_room_id uuid)
RETURNS TABLE (
  user_id uuid,
  is_ghost_mode boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  can_manage boolean;
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.room_has_active_access(p_room_id)
     OR NOT public.is_approved_room_member(p_room_id, auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized to view room presence modes.';
  END IF;

  can_manage := public.room_has_capability(p_room_id, auth.uid(), 'manage_members');

  RETURN QUERY
  SELECT rm.user_id, rm.is_ghost_mode
  FROM public.room_members rm
  WHERE rm.room_id = p_room_id
    AND rm.join_status = 'approved'
    AND (can_manage OR rm.user_id = auth.uid())
  ORDER BY rm.user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_room_member_identities(p_room_id uuid)
RETURNS TABLE (
  user_id uuid,
  username text,
  account_display_name text,
  room_display_name text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.room_has_active_access(p_room_id)
     OR NOT public.is_approved_room_member(p_room_id, auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized to view room member identities.';
  END IF;

  RETURN QUERY
  SELECT rm.user_id, p.username, p.display_name, rmp.display_name
  FROM public.room_members rm
  LEFT JOIN public.profiles p ON p.id = rm.user_id
  LEFT JOIN public.room_member_profiles rmp
    ON rmp.room_id = rm.room_id AND rmp.user_id = rm.user_id
  WHERE rm.room_id = p_room_id
    AND rm.join_status = 'approved'
    AND public.room_can_view_member(p_room_id, rm.user_id, auth.uid());
END;
$$;

DROP POLICY IF EXISTS "Approved members can view active room membership" ON public.room_members;
CREATE POLICY "Active room members respect ghost visibility"
ON public.room_members
FOR SELECT
TO authenticated
USING (
  public.room_can_view_member(room_id, user_id, auth.uid())
);

DROP POLICY IF EXISTS "Members read room profiles" ON public.room_member_profiles;
CREATE POLICY "Members read room profiles"
ON public.room_member_profiles
FOR SELECT
TO authenticated
USING (
  public.room_can_view_member(room_id, user_id, auth.uid())
);

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

  -- p_state_version is retained for additive RPC compatibility and validated
  -- as a client hint only. The database allocates the authoritative version
  -- while holding the conflicting snapshot row lock, so concurrent writers
  -- receive distinct versions instead of racing on a shared client counter.
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
  RETURNING * INTO snapshot_row;

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

CREATE OR REPLACE FUNCTION public.get_room_realtime_snapshots(p_room_id uuid)
RETURNS TABLE (
  snapshot_type text,
  state_version bigint,
  payload jsonb,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.room_has_active_access(p_room_id)
     OR NOT public.is_approved_room_member(p_room_id, auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized to view realtime snapshots.';
  END IF;

  RETURN QUERY
  SELECT s.snapshot_type, s.state_version, s.payload, s.updated_at
  FROM public.room_realtime_snapshots s
  WHERE s.room_id = p_room_id
    AND (
      (s.snapshot_type = 'media' AND public.room_has_capability(p_room_id, auth.uid(), 'watch'))
      OR (s.snapshot_type = 'timer' AND public.room_has_capability(p_room_id, auth.uid(), 'study'))
      OR (s.snapshot_type = 'settings' AND public.room_has_capability(p_room_id, auth.uid(), 'manage_settings'))
    )
  ORDER BY s.snapshot_type;
END;
$$;

CREATE OR REPLACE FUNCTION public.room_realtime_topic_room_id(p_topic text)
RETURNS uuid
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO ''
AS $$
BEGIN
  IF p_topic IS NULL
     OR p_topic !~ '^(sync|sync-chat|sync-study|sync-watch|sync-control|presence|presence-privileged):[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    RETURN NULL;
  END IF;

  RETURN split_part(p_topic, ':', 2)::uuid;
END;
$$;

DROP POLICY IF EXISTS "Approved room members receive room realtime" ON realtime.messages;
DROP POLICY IF EXISTS "Approved room members send room realtime" ON realtime.messages;
DROP POLICY IF EXISTS "Room members receive capability-scoped realtime" ON realtime.messages;
DROP POLICY IF EXISTS "Room members publish capability-scoped realtime" ON realtime.messages;

CREATE POLICY "Room members receive capability-scoped realtime"
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  realtime.messages.extension IN ('broadcast', 'presence')
  AND (
    (
      (SELECT realtime.topic()) LIKE 'sync:%'
      AND public.room_has_active_access(public.room_realtime_topic_room_id((SELECT realtime.topic())))
      AND public.is_approved_room_member(public.room_realtime_topic_room_id((SELECT realtime.topic())), (SELECT auth.uid()))
    )
    OR (
      (SELECT realtime.topic()) LIKE 'sync-chat:%'
      AND public.room_has_capability(public.room_realtime_topic_room_id((SELECT realtime.topic())), (SELECT auth.uid()), 'chat')
    )
    OR (
      (SELECT realtime.topic()) LIKE 'sync-study:%'
      AND public.room_has_capability(public.room_realtime_topic_room_id((SELECT realtime.topic())), (SELECT auth.uid()), 'study')
    )
    OR (
      ((SELECT realtime.topic()) LIKE 'sync-watch:%' OR (SELECT realtime.topic()) LIKE 'sync-control:%')
      AND public.room_has_capability(public.room_realtime_topic_room_id((SELECT realtime.topic())), (SELECT auth.uid()), 'watch')
    )
    OR (
      (SELECT realtime.topic()) LIKE 'presence:%'
      AND public.room_has_active_access(public.room_realtime_topic_room_id((SELECT realtime.topic())))
      AND public.is_approved_room_member(public.room_realtime_topic_room_id((SELECT realtime.topic())), (SELECT auth.uid()))
      AND NOT EXISTS (
        SELECT 1 FROM public.room_members rm
        WHERE rm.room_id = public.room_realtime_topic_room_id((SELECT realtime.topic()))
          AND rm.user_id = (SELECT auth.uid())
          AND rm.is_ghost_mode
      )
    )
    OR (
      (SELECT realtime.topic()) LIKE 'presence-privileged:%'
      AND public.room_has_capability(public.room_realtime_topic_room_id((SELECT realtime.topic())), (SELECT auth.uid()), 'manage_members')
    )
  )
);

CREATE POLICY "Room members publish capability-scoped realtime"
ON realtime.messages
FOR INSERT
TO authenticated
WITH CHECK (
  realtime.messages.extension IN ('broadcast', 'presence')
  AND (
    (
      (SELECT realtime.topic()) LIKE 'sync:%'
      AND public.room_has_active_access(public.room_realtime_topic_room_id((SELECT realtime.topic())))
      AND public.is_approved_room_member(public.room_realtime_topic_room_id((SELECT realtime.topic())), (SELECT auth.uid()))
    )
    OR (
      (SELECT realtime.topic()) LIKE 'sync-chat:%'
      AND public.room_has_capability(public.room_realtime_topic_room_id((SELECT realtime.topic())), (SELECT auth.uid()), 'chat')
    )
    OR (
      (SELECT realtime.topic()) LIKE 'sync-study:%'
      AND public.room_has_capability(public.room_realtime_topic_room_id((SELECT realtime.topic())), (SELECT auth.uid()), 'study')
    )
    OR (
      (SELECT realtime.topic()) LIKE 'sync-watch:%'
      AND public.room_has_capability(public.room_realtime_topic_room_id((SELECT realtime.topic())), (SELECT auth.uid()), 'watch')
    )
    OR (
      (SELECT realtime.topic()) LIKE 'sync-control:%'
      AND public.room_has_capability(public.room_realtime_topic_room_id((SELECT realtime.topic())), (SELECT auth.uid()), 'watch_control')
    )
    OR (
      (SELECT realtime.topic()) LIKE 'presence:%'
      AND public.room_has_active_access(public.room_realtime_topic_room_id((SELECT realtime.topic())))
      AND public.is_approved_room_member(public.room_realtime_topic_room_id((SELECT realtime.topic())), (SELECT auth.uid()))
      AND NOT EXISTS (
        SELECT 1 FROM public.room_members rm
        WHERE rm.room_id = public.room_realtime_topic_room_id((SELECT realtime.topic()))
          AND rm.user_id = (SELECT auth.uid())
          AND rm.is_ghost_mode
      )
    )
    OR (
      (SELECT realtime.topic()) LIKE 'presence-privileged:%'
      AND public.room_has_capability(public.room_realtime_topic_room_id((SELECT realtime.topic())), (SELECT auth.uid()), 'manage_members')
    )
  )
);

REVOKE ALL ON FUNCTION public.room_lifecycle_state(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.room_has_active_access(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.room_in_recovery_window(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.room_can_join(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_room_by_identifier(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.transfer_room_ownership(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.room_can_view_member(uuid, uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_room_ghost_mode(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_my_room_presence_mode(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_room_member_presence_modes(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_room_member_identities(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.upsert_room_realtime_snapshot(uuid, text, bigint, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_room_realtime_snapshots(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.room_has_active_access(uuid),
  public.room_in_recovery_window(uuid),
  public.room_can_join(uuid, uuid),
  public.get_room_by_identifier(text),
  public.transfer_room_ownership(uuid, uuid),
  public.get_room_member_identities(uuid)
TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.room_realtime_topic_room_id(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.room_realtime_topic_room_id(text) TO authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.room_can_view_member(uuid, uuid, uuid),
  public.set_room_ghost_mode(uuid, boolean),
  public.get_my_room_presence_mode(uuid),
  public.get_room_member_presence_modes(uuid),
  public.upsert_room_realtime_snapshot(uuid, text, bigint, jsonb),
  public.get_room_realtime_snapshots(uuid)
TO authenticated;
