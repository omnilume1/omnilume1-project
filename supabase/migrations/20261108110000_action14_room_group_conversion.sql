-- Action 14: room-to-group conversion. Additive only (lifecycle functions are
-- replaced with the same behaviour plus a "converted rooms are never
-- destroyed" guard).
--
-- Model
--   * `groups` is the persistent group. It has no username and no link, and
--     keeps `source_room_id` (UNIQUE, ON DELETE RESTRICT) as its originating
--     room: the room keeps all chat, files, notes and permissions, so content
--     is preserved by reference and nothing is copied, re-encrypted or
--     deleted. `group_members` is the approved-member snapshot with roles.
--   * `room_group_conversions` is the audit/staging record (counts, previous
--     room settings, what the conversion resolved).
--   * convert_room_to_group is ONE SECURITY DEFINER transaction: any failure
--     rolls everything back and leaves the room unchanged. The row lock on the
--     room makes it idempotent under double clicks.
--   * After conversion the source room is permanent, private and locked
--     (no new joins, invites revoked, username cleared), and lifecycle cleanup
--     can never select or destroy it.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(btrim(name)) >= 1),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  source_room_id uuid NOT NULL UNIQUE REFERENCES public.rooms(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.group_members (
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS group_members_one_owner ON public.group_members (group_id) WHERE role = 'owner';
CREATE INDEX IF NOT EXISTS group_members_user_idx ON public.group_members (user_id);

CREATE TABLE IF NOT EXISTS public.room_group_conversions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL UNIQUE REFERENCES public.rooms(id) ON DELETE RESTRICT,
  group_id uuid NOT NULL UNIQUE REFERENCES public.groups(id) ON DELETE CASCADE,
  converted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed')),
  member_count integer NOT NULL CHECK (member_count >= 1),
  content_refs jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(content_refs) = 'object'),
  resolved jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(resolved) = 'object'),
  previous jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(previous) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_group_conversions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.groups, public.group_members, public.room_group_conversions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.groups, public.group_members, public.room_group_conversions TO authenticated;

-- Policy helpers run as the caller, so they are executable by authenticated.
-- They only ever answer about the caller's own membership.
CREATE OR REPLACE FUNCTION public.is_group_member(p_group_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_user_id IS NOT NULL AND p_user_id = auth.uid() AND EXISTS (
    SELECT 1 FROM public.group_members gm WHERE gm.group_id = p_group_id AND gm.user_id = p_user_id
  );
$$;

CREATE OR REPLACE FUNCTION public.is_group_manager(p_group_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_user_id IS NOT NULL AND p_user_id = auth.uid() AND EXISTS (
    SELECT 1 FROM public.group_members gm
    WHERE gm.group_id = p_group_id AND gm.user_id = p_user_id AND gm.role IN ('owner', 'admin')
  );
$$;
REVOKE ALL ON FUNCTION public.is_group_member(uuid, uuid), public.is_group_manager(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_group_member(uuid, uuid), public.is_group_manager(uuid, uuid) TO authenticated;

DROP POLICY IF EXISTS "Group members read their groups" ON public.groups;
CREATE POLICY "Group members read their groups" ON public.groups FOR SELECT TO authenticated
USING (public.is_group_member(id, auth.uid()));
DROP POLICY IF EXISTS "Group members read the member list" ON public.group_members;
CREATE POLICY "Group members read the member list" ON public.group_members FOR SELECT TO authenticated
USING (public.is_group_member(group_id, auth.uid()));
DROP POLICY IF EXISTS "Group managers read conversion records" ON public.room_group_conversions;
CREATE POLICY "Group managers read conversion records" ON public.room_group_conversions FOR SELECT TO authenticated
USING (public.is_group_manager(group_id, auth.uid()));

-- ---------------------------------------------------------------------------
-- 2. New notification and control-event types (widened, nothing removed)
-- ---------------------------------------------------------------------------
ALTER TABLE public.room_notifications DROP CONSTRAINT IF EXISTS room_notifications_type_allowed;
ALTER TABLE public.room_notifications
  ADD CONSTRAINT room_notifications_type_allowed CHECK (notification_type IN (
    'mention', 'reply', 'announcement', 'pdf_shared', 'timer',
    'recovery_request', 'recovery_decision', 'access', 'security',
    'permanent_conversion', 'room_deletion',
    'task', 'room_event', 'group_conversion'
  ));

ALTER TABLE public.room_control_events DROP CONSTRAINT IF EXISTS room_control_events_event_type_check;
ALTER TABLE public.room_control_events
  ADD CONSTRAINT room_control_events_event_type_check CHECK (event_type IN (
    'membership_changed', 'role_changed', 'invite_changed', 'restriction_changed',
    'ownership_changed', 'settings_changed', 'lock_changed', 'announcement_changed',
    'guest_changed', 'feature_changed', 'group_converted'
  ));

-- ---------------------------------------------------------------------------
-- 3. The conversion
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.convert_room_to_group(p_room_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_room public.rooms%ROWTYPE;
  v_settings public.room_control_settings%ROWTYPE;
  v_conv public.room_group_conversions%ROWTYPE;
  v_group public.groups%ROWTYPE;
  v_members integer;
  v_owners integer;
  v_encrypted integer;
  v_missing_keys integer;
  v_invites integer := 0;
  v_pending integer := 0;
  v_recovery integer := 0;
  v_permanent integer := 0;
  v_jobs integer := 0;
  v_refs jsonb;
  v_member record;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to convert a room.' USING ERRCODE = '42501', HINT = 'not_signed_in';
  END IF;

  -- The row lock serialises concurrent conversions of the same room.
  SELECT * INTO v_room FROM public.rooms r WHERE r.id = p_room_id FOR UPDATE;
  IF NOT FOUND OR public.room_user_role(p_room_id, v_uid) IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Only the room owner can convert this room.' USING ERRCODE = '42501', HINT = 'not_owner';
  END IF;

  -- Idempotent: a second call returns the existing group and changes nothing.
  SELECT * INTO v_conv FROM public.room_group_conversions c WHERE c.room_id = p_room_id;
  IF FOUND THEN
    SELECT * INTO v_group FROM public.groups g WHERE g.id = v_conv.group_id;
    RETURN jsonb_build_object('group_id', v_group.id, 'name', v_group.name, 'already_converted', true,
      'member_count', v_conv.member_count, 'converted_at', v_conv.created_at);
  END IF;

  IF NOT public.room_has_active_access(p_room_id) THEN
    RAISE EXCEPTION 'The room is not currently active.' USING ERRCODE = 'P0001', HINT = 'not_active';
  END IF;
  IF v_room.expiration_type = 'irreversible' THEN
    RAISE EXCEPTION 'Irreversible rooms cannot be converted to groups.' USING ERRCODE = 'P0001', HINT = 'irreversible';
  END IF;
  IF v_room.deletion_scheduled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cancel the scheduled deletion before converting this room.' USING ERRCODE = 'P0001', HINT = 'deletion_scheduled';
  END IF;

  -- Approved, permanent (non-guest), unrestricted members migrate with roles.
  SELECT count(*), count(*) FILTER (WHERE rm.role = 'owner')
    INTO v_members, v_owners
  FROM public.room_members rm
  WHERE rm.room_id = p_room_id AND rm.join_status = 'approved'
    AND rm.role IN ('owner', 'admin', 'member') AND rm.guest_expires_at IS NULL
    AND NOT public.room_user_is_restricted(p_room_id, rm.user_id);
  IF v_owners <> 1 THEN
    RAISE EXCEPTION 'The room needs exactly one eligible owner.' USING ERRCODE = 'P0001', HINT = 'owner_invalid';
  END IF;

  -- End-to-end encrypted content converts only when every migrating member
  -- has a key on file. Ciphertext is never read, rewritten or re-encrypted.
  SELECT count(*) INTO v_encrypted FROM public.messages m WHERE m.room_id = p_room_id AND m.ciphertext IS NOT NULL;
  IF v_encrypted > 0 THEN
    SELECT count(*) INTO v_missing_keys
    FROM public.room_members rm
    LEFT JOIN public.profiles p ON p.id = rm.user_id
    WHERE rm.room_id = p_room_id AND rm.join_status = 'approved'
      AND rm.role IN ('owner', 'admin', 'member') AND rm.guest_expires_at IS NULL
      AND NOT public.room_user_is_restricted(p_room_id, rm.user_id)
      AND (p.public_key IS NULL OR btrim(p.public_key) = '');
    IF v_missing_keys > 0 THEN
      RAISE EXCEPTION 'Some members have not set up their encryption keys, so this encrypted room cannot convert yet.'
        USING ERRCODE = 'P0001', HINT = 'e2ee_keys_missing';
    END IF;
  END IF;

  SELECT * INTO v_settings FROM public.room_control_settings s WHERE s.room_id = p_room_id;

  INSERT INTO public.groups (name, created_by, source_room_id)
  VALUES (v_room.name, v_uid, p_room_id)
  RETURNING * INTO v_group;

  INSERT INTO public.group_members (group_id, user_id, role, joined_at)
  SELECT v_group.id, rm.user_id, rm.role, rm.joined_at
  FROM public.room_members rm
  WHERE rm.room_id = p_room_id AND rm.join_status = 'approved'
    AND rm.role IN ('owner', 'admin', 'member') AND rm.guest_expires_at IS NULL
    AND NOT public.room_user_is_restricted(p_room_id, rm.user_id);

  -- Content stays where it is (referenced through source_room_id); the record
  -- keeps counts as the staged content references.
  v_refs := jsonb_build_object(
    'messages', (SELECT count(*) FROM public.messages m WHERE m.room_id = p_room_id AND m.ciphertext IS NULL AND NOT COALESCE(m.is_deleted, false)),
    'encrypted_messages', v_encrypted,
    'files', (SELECT count(*) FROM public.room_files f WHERE f.room_id = p_room_id AND f.retention_state = 'active'),
    'notes', (SELECT count(*) FROM public.study_notes n WHERE n.room_id = p_room_id AND n.scope = 'room'),
    'tasks', (SELECT count(*) FROM public.room_tasks t WHERE t.room_id = p_room_id),
    'polls', (SELECT count(*) FROM public.room_polls p WHERE p.room_id = p_room_id),
    'events', (SELECT count(*) FROM public.room_events e WHERE e.room_id = p_room_id),
    'clips', (SELECT count(*) FROM public.room_media_clips c WHERE c.room_id = p_room_id));

  -- Close the room to new joins and old links; settle lifecycle leftovers so
  -- no cleanup, recovery or permanent-room workflow can act on this room.
  UPDATE public.room_invites SET revoked_at = now(), revoked_by = v_uid
  WHERE room_id = p_room_id AND revoked_at IS NULL;
  GET DIAGNOSTICS v_invites = ROW_COUNT;
  UPDATE public.room_members SET join_status = 'rejected'
  WHERE room_id = p_room_id AND join_status = 'pending';
  GET DIAGNOSTICS v_pending = ROW_COUNT;
  DELETE FROM public.recovery_requests WHERE room_id = p_room_id AND status = 'pending';
  GET DIAGNOSTICS v_recovery = ROW_COUNT;
  UPDATE public.room_permanent_requests
  SET status = 'approved', reviewed_at = now(), reviewed_by = v_uid
  WHERE room_id = p_room_id AND status = 'pending';
  GET DIAGNOSTICS v_permanent = ROW_COUNT;
  DELETE FROM public.room_cleanup_jobs WHERE room_id = p_room_id;
  GET DIAGNOSTICS v_jobs = ROW_COUNT;

  PERFORM set_config('app.omnilume_lifecycle_authorized', 'permanent_conversion', true);
  UPDATE public.rooms
  SET is_group = true, is_private = true, expiration_type = 'permanent',
      expires_at = NULL, reopened_until = NULL, username = NULL
  WHERE id = p_room_id;
  UPDATE public.room_control_settings
  SET is_locked = true, updated_at = now(), updated_by = v_uid
  WHERE room_id = p_room_id;

  INSERT INTO public.room_group_conversions (room_id, group_id, converted_by, member_count, content_refs, resolved, previous)
  VALUES (p_room_id, v_group.id, v_uid, v_members, v_refs,
    jsonb_build_object('invites_revoked', v_invites, 'join_requests_rejected', v_pending,
      'recovery_requests_cleared', v_recovery, 'permanent_requests_resolved', v_permanent,
      'cleanup_jobs_cleared', v_jobs),
    jsonb_build_object('username', v_room.username, 'expiration_type', v_room.expiration_type,
      'expires_at', v_room.expires_at, 'is_private', v_room.is_private, 'is_group', v_room.is_group,
      'is_locked', COALESCE(v_settings.is_locked, false)));

  -- One notice per migrated member (never the actor), deduplicated per room.
  FOR v_member IN
    SELECT gm.user_id FROM public.group_members gm WHERE gm.group_id = v_group.id AND gm.user_id <> v_uid
  LOOP
    PERFORM public.enqueue_room_notification(
      v_member.user_id, p_room_id, 'group_conversion',
      public.notification_user_label(v_uid) || ' converted "' || left(v_room.name, 120)
        || '" into a group. Your membership, history and files are kept.',
      jsonb_build_object('group_id', v_group.id, 'room_name', v_room.name),
      v_uid, v_group.id, 'group_conversion:' || p_room_id::text);
  END LOOP;

  INSERT INTO public.room_activity (room_id, kind, actor_id, entity_id, dedupe_key)
  VALUES (p_room_id, 'group_converted', v_uid, v_group.id, 'group_converted:' || p_room_id::text)
  ON CONFLICT (room_id, dedupe_key) DO NOTHING;
  -- Exactly one published conversion event (the realtime control feed).
  PERFORM public.record_room_control_event(p_room_id, 'group_converted', NULL, jsonb_build_object('group_id', v_group.id));

  RETURN jsonb_build_object('group_id', v_group.id, 'name', v_group.name, 'already_converted', false,
    'member_count', v_members, 'converted_at', now());
END;
$$;

-- The group a room was converted into, for members of that room.
CREATE OR REPLACE FUNCTION public.get_room_group(p_room_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_approved_room_member(p_room_id, auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized to view this room.' USING ERRCODE = '42501';
  END IF;
  SELECT jsonb_build_object('group_id', g.id, 'name', g.name, 'converted_at', c.created_at, 'member_count', c.member_count)
    INTO v_result
  FROM public.room_group_conversions c JOIN public.groups g ON g.id = c.group_id
  WHERE c.room_id = p_room_id;
  RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Lifecycle: a converted room can never be scheduled, listed or destroyed
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.destroy_expired_room(p_room_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  PERFORM 1 FROM public.rooms r WHERE r.id = p_room_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF EXISTS (SELECT 1 FROM public.groups g WHERE g.source_room_id = p_room_id) THEN
    RETURN false;
  END IF;

  IF public.room_lifecycle_state(p_room_id) <> 'destroyed' THEN
    RETURN false;
  END IF;

  DELETE FROM public.rooms r
  WHERE r.id = p_room_id
    AND (
      r.expiration_type IN ('recoverable', 'irreversible')
      OR (r.expiration_type = 'permanent' AND r.deletion_scheduled_at IS NOT NULL AND r.deletion_scheduled_at <= now())
    );
  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.list_rooms_due_for_destruction(p_limit integer DEFAULT 100)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT r.id
  FROM public.rooms r
  WHERE (
      (r.expiration_type IN ('recoverable', 'irreversible') AND r.expires_at IS NOT NULL AND r.expires_at <= now())
      OR (r.expiration_type = 'permanent' AND r.deletion_scheduled_at IS NOT NULL AND r.deletion_scheduled_at <= now())
    )
    AND NOT EXISTS (SELECT 1 FROM public.groups g WHERE g.source_room_id = r.id)
    AND public.room_lifecycle_state(r.id) = 'destroyed'
  ORDER BY COALESCE(r.expires_at, r.deletion_scheduled_at)
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
$function$;

CREATE OR REPLACE FUNCTION public.schedule_room_deletion(p_room_id uuid, p_grace_days integer DEFAULT 7)
RETURNS timestamp with time zone
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  room_row public.rooms;
  v_deletion_at timestamptz;
  member_row record;
BEGIN
  IF auth.uid() IS NULL OR public.room_user_role(p_room_id, auth.uid()) IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Only the room owner can schedule deletion.' USING ERRCODE = '42501';
  END IF;

  IF p_grace_days IS NULL OR p_grace_days < 7 OR p_grace_days > 14 THEN
    RAISE EXCEPTION 'The deletion grace period must be between 7 and 14 days.';
  END IF;

  SELECT r.* INTO room_row FROM public.rooms r WHERE r.id = p_room_id FOR UPDATE;
  IF NOT FOUND OR room_row.expiration_type <> 'permanent' THEN
    RAISE EXCEPTION 'Only permanent rooms can be scheduled for deletion.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.groups g WHERE g.source_room_id = p_room_id) THEN
    RAISE EXCEPTION 'This room belongs to a group and cannot be scheduled for deletion.';
  END IF;
  IF NOT public.room_has_active_access(p_room_id) THEN
    RAISE EXCEPTION 'The room is not currently active.';
  END IF;
  IF room_row.deletion_scheduled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Deletion is already scheduled for this room.';
  END IF;

  v_deletion_at := now() + make_interval(days => p_grace_days);
  PERFORM set_config('app.omnilume_lifecycle_authorized', 'deletion_schedule', true);
  UPDATE public.rooms
  SET deletion_scheduled_at = v_deletion_at,
      deletion_scheduled_by = auth.uid()
  WHERE id = p_room_id;

  FOR member_row IN
    SELECT rm.user_id FROM public.room_members rm
    WHERE rm.room_id = p_room_id AND rm.join_status = 'approved'
  LOOP
    PERFORM public.enqueue_room_notification(
      member_row.user_id, p_room_id, 'room_deletion',
      '"' || room_row.name || '" will be permanently deleted on '
        || to_char(v_deletion_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC unless the owner cancels.',
      jsonb_build_object('action', 'scheduled', 'deletion_scheduled_at', v_deletion_at),
      auth.uid(), p_room_id,
      'room_deletion:scheduled:' || p_room_id::text || ':' || extract(epoch FROM v_deletion_at)::bigint::text
    );
  END LOOP;

  RETURN v_deletion_at;
END;
$function$;

-- Account deletion: a group's source room cannot be deleted while the group
-- exists, so a sole-member owner's group goes first, and a replacement owner
-- inherits the group's ownership too.
CREATE OR REPLACE FUNCTION public.prepare_account_deletion(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE room_row record; replacement_user uuid; v_group uuid;
BEGIN
  IF auth.uid() IS DISTINCT FROM p_user_id
     AND current_setting('request.jwt.claim.role', true) <> 'service_role' THEN
    RAISE EXCEPTION 'Unauthorized account deletion preparation.';
  END IF;
  PERFORM set_config('app.omnilume_account_deletion', 'true', true);
  FOR room_row IN SELECT id FROM public.rooms WHERE created_by = p_user_id LOOP
    SELECT rm.user_id INTO replacement_user
    FROM public.room_members rm
    WHERE rm.room_id = room_row.id AND rm.user_id <> p_user_id
      AND rm.join_status = 'approved' AND rm.role <> 'guest' AND rm.guest_expires_at IS NULL
    ORDER BY CASE WHEN rm.role = 'admin' THEN 0 ELSE 1 END, rm.joined_at
    LIMIT 1;
    SELECT g.id INTO v_group FROM public.groups g WHERE g.source_room_id = room_row.id;
    IF replacement_user IS NULL THEN
      IF v_group IS NOT NULL THEN
        DELETE FROM public.groups WHERE id = v_group;
      END IF;
      DELETE FROM public.rooms WHERE id = room_row.id;
    ELSE
      UPDATE public.room_members SET role = 'owner'
      WHERE room_id = room_row.id AND user_id = replacement_user;
      UPDATE public.rooms SET created_by = replacement_user WHERE id = room_row.id;
      IF v_group IS NOT NULL THEN
        UPDATE public.group_members SET role = 'admin' WHERE group_id = v_group AND user_id = p_user_id;
        INSERT INTO public.group_members (group_id, user_id, role)
        VALUES (v_group, replacement_user, 'owner')
        ON CONFLICT (group_id, user_id) DO UPDATE SET role = 'owner';
      END IF;
    END IF;
  END LOOP;
END;
$function$;

-- The legacy path made a room permanent and handed out a group username. It
-- conflicts with the final group semantics, so it is no longer callable.
REVOKE ALL ON FUNCTION public.convert_active_room_to_permanent(uuid, text) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.convert_room_to_group(uuid), public.get_room_group(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convert_room_to_group(uuid), public.get_room_group(uuid) TO authenticated;
