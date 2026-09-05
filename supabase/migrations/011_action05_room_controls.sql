-- Action 05: room controls. This migration is additive and keeps
-- public.rooms/public.room_members as the sole room and membership records.

ALTER TABLE public.room_members
  ADD COLUMN IF NOT EXISTS guest_expires_at timestamptz;

ALTER TABLE public.room_members
  DROP CONSTRAINT IF EXISTS room_members_role_check;
ALTER TABLE public.room_members
  ADD CONSTRAINT room_members_role_check
  CHECK (role IN ('owner', 'admin', 'member', 'guest'));
ALTER TABLE public.room_members
  DROP CONSTRAINT IF EXISTS room_members_guest_expiry_check;
ALTER TABLE public.room_members
  ADD CONSTRAINT room_members_guest_expiry_check
  CHECK (
    (role = 'guest' AND guest_expires_at IS NOT NULL AND guest_expires_at > joined_at)
    OR (role <> 'guest' AND guest_expires_at IS NULL)
  );

CREATE TABLE IF NOT EXISTS public.room_control_settings (
  room_id uuid PRIMARY KEY REFERENCES public.rooms(id) ON DELETE CASCADE,
  rules text NOT NULL DEFAULT '',
  welcome_message text NOT NULL DEFAULT '',
  is_locked boolean NOT NULL DEFAULT false,
  feature_flags jsonb NOT NULL DEFAULT '{"chat": true, "watch": true, "files": true, "study": true, "announcements": true}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT room_control_feature_flags_check CHECK (
    jsonb_typeof(feature_flags) = 'object'
    AND feature_flags ?& ARRAY['chat', 'watch', 'files', 'study', 'announcements']
    AND jsonb_typeof(feature_flags->'chat') = 'boolean'
    AND jsonb_typeof(feature_flags->'watch') = 'boolean'
    AND jsonb_typeof(feature_flags->'files') = 'boolean'
    AND jsonb_typeof(feature_flags->'study') = 'boolean'
    AND jsonb_typeof(feature_flags->'announcements') = 'boolean'
  )
);

CREATE TABLE IF NOT EXISTS public.room_role_permissions (
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin', 'member', 'guest')),
  capability text NOT NULL CHECK (capability IN ('manage_members', 'manage_invites', 'manage_settings', 'manage_announcements', 'chat', 'watch', 'watch_control', 'files', 'study')),
  allowed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (room_id, role, capability)
);

CREATE TABLE IF NOT EXISTS public.room_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at timestamptz,
  max_uses integer,
  uses_count integer NOT NULL DEFAULT 0 CHECK (uses_count >= 0),
  guest_lifetime_minutes integer,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT room_invites_usage_check CHECK (max_uses IS NULL OR max_uses > 0),
  CONSTRAINT room_invites_guest_lifetime_check CHECK (guest_lifetime_minutes IS NULL OR guest_lifetime_minutes BETWEEN 5 AND 10080)
);

CREATE INDEX IF NOT EXISTS room_invites_room_active_idx ON public.room_invites (room_id, created_at DESC) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public.room_member_restrictions (
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  restriction_type text NOT NULL CHECK (restriction_type IN ('ban', 'block')),
  reason text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id, restriction_type)
);

CREATE INDEX IF NOT EXISTS room_member_restrictions_active_idx ON public.room_member_restrictions (room_id, user_id) WHERE expires_at IS NULL;

CREATE TABLE IF NOT EXISTS public.room_member_profiles (
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text,
  avatar_url text,
  bio text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id),
  CONSTRAINT room_member_profiles_lengths CHECK (
    (display_name IS NULL OR char_length(display_name) <= 80)
    AND (avatar_url IS NULL OR char_length(avatar_url) <= 2048)
    AND (bio IS NULL OR char_length(bio) <= 280)
  )
);

CREATE TABLE IF NOT EXISTS public.room_announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  is_pinned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS room_announcements_room_created_idx ON public.room_announcements (room_id, is_pinned DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS public.room_control_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('membership_changed', 'role_changed', 'invite_changed', 'restriction_changed', 'ownership_changed', 'settings_changed', 'lock_changed', 'announcement_changed', 'guest_changed', 'feature_changed')),
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  subject_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS room_control_events_room_id_idx ON public.room_control_events (room_id, id DESC);

ALTER TABLE public.room_control_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_member_restrictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_member_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_control_events ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.room_user_is_restricted(p_room_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.room_member_restrictions r
    WHERE r.room_id = p_room_id AND r.user_id = p_user_id
      AND (r.expires_at IS NULL OR r.expires_at > now())
  );
$$;

CREATE OR REPLACE FUNCTION public.room_user_role(p_room_id uuid, p_user_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public AS $$
  SELECT rm.role FROM public.room_members rm
  WHERE rm.room_id = p_room_id AND rm.user_id = p_user_id
    AND rm.join_status = 'approved'
    AND (rm.guest_expires_at IS NULL OR rm.guest_expires_at > now())
    AND NOT public.room_user_is_restricted(p_room_id, p_user_id)
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.is_approved_room_member(p_room_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public AS $$
  SELECT public.room_user_role(p_room_id, p_user_id) IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION public.room_feature_enabled(p_room_id uuid, p_feature text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public AS $$
  SELECT COALESCE((s.feature_flags ->> p_feature)::boolean, false)
  FROM public.room_control_settings s WHERE s.room_id = p_room_id;
$$;

CREATE OR REPLACE FUNCTION public.room_has_capability(p_room_id uuid, p_user_id uuid, p_capability text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO public AS $$
DECLARE role_name text; feature_name text;
BEGIN
  IF auth.uid() IS DISTINCT FROM p_user_id
     AND COALESCE(current_setting('request.jwt.claim.role', true), '') <> 'service_role' THEN RETURN false; END IF;
  IF NOT public.room_has_active_access(p_room_id) THEN RETURN false; END IF;
  feature_name := CASE p_capability
    WHEN 'chat' THEN 'chat' WHEN 'watch' THEN 'watch' WHEN 'watch_control' THEN 'watch'
    WHEN 'files' THEN 'files' WHEN 'study' THEN 'study'
    WHEN 'manage_announcements' THEN 'announcements' ELSE NULL END;
  IF feature_name IS NOT NULL AND NOT public.room_feature_enabled(p_room_id, feature_name) THEN RETURN false; END IF;
  role_name := public.room_user_role(p_room_id, p_user_id);
  IF role_name IS NULL THEN RETURN false; END IF;
  IF role_name = 'owner' THEN RETURN true; END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.room_role_permissions p
    WHERE p.room_id = p_room_id AND p.role = role_name
      AND p.capability = p_capability AND p.allowed
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.room_can_join(p_room_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public AS $$
  SELECT (auth.uid() = p_user_id OR COALESCE(current_setting('request.jwt.claim.role', true), '') = 'service_role')
    AND public.room_has_active_access(p_room_id)
    AND NOT public.room_user_is_restricted(p_room_id, p_user_id)
    AND NOT COALESCE((SELECT is_locked FROM public.room_control_settings WHERE room_id = p_room_id), false);
$$;

CREATE OR REPLACE FUNCTION public.seed_room_controls(p_room_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public AS $$
BEGIN
  INSERT INTO public.room_control_settings (room_id) VALUES (p_room_id) ON CONFLICT (room_id) DO NOTHING;
  INSERT INTO public.room_role_permissions (room_id, role, capability, allowed)
  SELECT p_room_id, values.role, values.capability, values.allowed
  FROM (VALUES
    ('admin','manage_members',true), ('admin','manage_invites',true), ('admin','manage_settings',true), ('admin','manage_announcements',true), ('admin','chat',true), ('admin','watch',true), ('admin','watch_control',true), ('admin','files',true), ('admin','study',true),
    ('member','manage_members',false), ('member','manage_invites',false), ('member','manage_settings',false), ('member','manage_announcements',false), ('member','chat',true), ('member','watch',true), ('member','watch_control',false), ('member','files',true), ('member','study',true),
    ('guest','manage_members',false), ('guest','manage_invites',false), ('guest','manage_settings',false), ('guest','manage_announcements',false), ('guest','chat',true), ('guest','watch',true), ('guest','watch_control',false), ('guest','files',false), ('guest','study',false)
  ) AS values(role, capability, allowed)
  ON CONFLICT (room_id, role, capability) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.seed_room_controls_after_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public AS $$
BEGIN
  PERFORM public.seed_room_controls(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS seed_room_controls_after_insert ON public.rooms;
CREATE TRIGGER seed_room_controls_after_insert AFTER INSERT ON public.rooms
FOR EACH ROW EXECUTE FUNCTION public.seed_room_controls_after_insert();

SELECT public.seed_room_controls(id) FROM public.rooms;

CREATE OR REPLACE FUNCTION public.record_room_control_event(p_room_id uuid, p_event_type text, p_subject_user_id uuid DEFAULT NULL, p_payload jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public AS $$
BEGIN
  INSERT INTO public.room_control_events(room_id, event_type, actor_id, subject_user_id, payload)
  VALUES (p_room_id, p_event_type, auth.uid(), p_subject_user_id, p_payload);
END;
$$;

CREATE OR REPLACE FUNCTION public.request_room_join(p_identifier text)
RETURNS TABLE(room_id uuid, status text) LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public AS $$
DECLARE room_row public.rooms; existing_status text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Unauthorized'; END IF;
  SELECT * INTO room_row FROM public.rooms r
  WHERE lower(r.username) = lower(trim(leading '@' from p_identifier)) OR r.id::text = trim(leading '@' from p_identifier)
  LIMIT 1;
  IF NOT FOUND OR NOT public.room_can_join(room_row.id, auth.uid()) THEN RAISE EXCEPTION 'Room is unavailable.'; END IF;
  SELECT join_status INTO existing_status FROM public.room_members WHERE room_id = room_row.id AND user_id = auth.uid();
  IF FOUND THEN RETURN QUERY SELECT room_row.id, existing_status; RETURN; END IF;
  INSERT INTO public.room_members(room_id, user_id, role, join_status) VALUES (room_row.id, auth.uid(), 'member', CASE WHEN room_row.is_private THEN 'pending' ELSE 'approved' END);
  PERFORM public.record_room_control_event(room_row.id, 'membership_changed', auth.uid(), jsonb_build_object('status', CASE WHEN room_row.is_private THEN 'pending' ELSE 'approved' END));
  RETURN QUERY SELECT room_row.id, CASE WHEN room_row.is_private THEN 'pending'::text ELSE 'approved'::text END;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_room_invite(p_room_id uuid, p_expires_at timestamptz DEFAULT NULL, p_max_uses integer DEFAULT NULL, p_guest_lifetime_minutes integer DEFAULT NULL)
RETURNS public.room_invites LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public AS $$
DECLARE invite_row public.room_invites;
BEGIN
  IF auth.uid() IS NULL OR NOT public.room_has_capability(p_room_id, auth.uid(), 'manage_invites') THEN RAISE EXCEPTION 'Not authorized to create room invites.'; END IF;
  IF p_expires_at IS NOT NULL AND p_expires_at <= now() THEN RAISE EXCEPTION 'Invite expiry must be in the future.'; END IF;
  IF p_max_uses IS NOT NULL AND p_max_uses < 1 THEN RAISE EXCEPTION 'Invite max uses must be positive.'; END IF;
  IF p_guest_lifetime_minutes IS NOT NULL AND p_guest_lifetime_minutes NOT BETWEEN 5 AND 10080 THEN RAISE EXCEPTION 'Guest duration is invalid.'; END IF;
  INSERT INTO public.room_invites(room_id, token, created_by, expires_at, max_uses, guest_lifetime_minutes)
  VALUES(p_room_id, encode(gen_random_bytes(24), 'hex'), auth.uid(), p_expires_at, p_max_uses, p_guest_lifetime_minutes)
  RETURNING * INTO invite_row;
  PERFORM public.record_room_control_event(p_room_id, 'invite_changed', NULL, jsonb_build_object('invite_id', invite_row.id, 'state', 'created'));
  RETURN invite_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_room_invite(p_invite_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public AS $$
DECLARE invite_row public.room_invites;
BEGIN
  SELECT * INTO invite_row FROM public.room_invites WHERE id = p_invite_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR NOT public.room_has_capability(invite_row.room_id, auth.uid(), 'manage_invites') THEN RAISE EXCEPTION 'Not authorized to revoke this invite.'; END IF;
  UPDATE public.room_invites SET revoked_at = now(), revoked_by = auth.uid() WHERE id = p_invite_id AND revoked_at IS NULL;
  PERFORM public.record_room_control_event(invite_row.room_id, 'invite_changed', NULL, jsonb_build_object('invite_id', p_invite_id, 'state', 'revoked'));
END;
$$;

CREATE OR REPLACE FUNCTION public.get_room_invite(p_token text)
RETURNS TABLE(room_id uuid, expires_at timestamptz, max_uses integer, uses_count integer, guest_lifetime_minutes integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public AS $$
  SELECT i.room_id, i.expires_at, i.max_uses, i.uses_count, i.guest_lifetime_minutes
  FROM public.room_invites i
  WHERE auth.uid() IS NOT NULL AND i.token = p_token AND i.revoked_at IS NULL
    AND (i.expires_at IS NULL OR i.expires_at > now()) AND (i.max_uses IS NULL OR i.uses_count < i.max_uses)
    AND public.room_can_join(i.room_id, auth.uid());
$$;

CREATE OR REPLACE FUNCTION public.join_room_with_invite(p_token text)
RETURNS TABLE(room_id uuid, status text, role text, guest_expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public AS $$
DECLARE invite_row public.room_invites; room_row public.rooms; existing public.room_members; expiry timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Unauthorized'; END IF;
  SELECT * INTO invite_row FROM public.room_invites WHERE token = p_token FOR UPDATE;
  IF NOT FOUND OR invite_row.revoked_at IS NOT NULL OR (invite_row.expires_at IS NOT NULL AND invite_row.expires_at <= now()) OR (invite_row.max_uses IS NOT NULL AND invite_row.uses_count >= invite_row.max_uses) THEN RAISE EXCEPTION 'Invite is invalid or expired.'; END IF;
  SELECT * INTO room_row FROM public.rooms WHERE id = invite_row.room_id;
  IF NOT FOUND OR NOT public.room_can_join(room_row.id, auth.uid()) THEN RAISE EXCEPTION 'Room is unavailable.'; END IF;
  SELECT * INTO existing FROM public.room_members WHERE room_id = room_row.id AND user_id = auth.uid();
  IF FOUND THEN RETURN QUERY SELECT room_row.id, existing.join_status, existing.role, existing.guest_expires_at; RETURN; END IF;
  expiry := CASE WHEN invite_row.guest_lifetime_minutes IS NULL THEN NULL ELSE now() + make_interval(mins => invite_row.guest_lifetime_minutes) END;
  INSERT INTO public.room_members(room_id, user_id, role, join_status, guest_expires_at)
  VALUES(room_row.id, auth.uid(), CASE WHEN expiry IS NULL THEN 'member' ELSE 'guest' END, 'approved', expiry);
  UPDATE public.room_invites SET uses_count = uses_count + 1 WHERE id = invite_row.id;
  PERFORM public.record_room_control_event(room_row.id, CASE WHEN expiry IS NULL THEN 'membership_changed' ELSE 'guest_changed' END, auth.uid(), jsonb_build_object('via', 'invite'));
  RETURN QUERY SELECT room_row.id, 'approved'::text, CASE WHEN expiry IS NULL THEN 'member'::text ELSE 'guest'::text END, expiry;
END;
$$;

CREATE OR REPLACE FUNCTION public.leave_room(p_room_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public AS $$
DECLARE member_row public.room_members;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Unauthorized'; END IF;
  SELECT * INTO member_row FROM public.room_members WHERE room_id = p_room_id AND user_id = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'You are not a room member.'; END IF;
  IF member_row.role = 'owner' THEN RAISE EXCEPTION 'Transfer ownership before leaving the room.'; END IF;
  DELETE FROM public.room_members WHERE room_id = p_room_id AND user_id = auth.uid();
  PERFORM public.record_room_control_event(p_room_id, 'membership_changed', auth.uid(), jsonb_build_object('state', 'left'));
END;
$$;

CREATE OR REPLACE FUNCTION public.review_room_member(p_room_id uuid, p_target_user_id uuid, p_action text, p_reason text DEFAULT '')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public AS $$
DECLARE actor_role text; target_role text;
BEGIN
  IF auth.uid() IS NULL OR p_action NOT IN ('approve','reject','kick','ban','block','unban','unblock') THEN RAISE EXCEPTION 'Invalid room moderation action.'; END IF;
  actor_role := public.room_user_role(p_room_id, auth.uid());
  IF actor_role IS NULL OR NOT public.room_has_capability(p_room_id, auth.uid(), 'manage_members') THEN RAISE EXCEPTION 'Not authorized to manage room members.'; END IF;
  IF p_target_user_id = auth.uid() THEN RAISE EXCEPTION 'You cannot moderate yourself.'; END IF;
  SELECT role INTO target_role FROM public.room_members WHERE room_id = p_room_id AND user_id = p_target_user_id;
  IF target_role = 'owner' OR (actor_role = 'admin' AND target_role = 'admin') THEN RAISE EXCEPTION 'You cannot manage this member.'; END IF;
  IF p_action = 'approve' THEN
    IF target_role IS NULL OR public.room_user_is_restricted(p_room_id, p_target_user_id) THEN RAISE EXCEPTION 'This member cannot be approved.'; END IF;
    UPDATE public.room_members SET join_status = 'approved' WHERE room_id = p_room_id AND user_id = p_target_user_id AND join_status = 'pending';
  ELSIF p_action = 'reject' THEN
    DELETE FROM public.room_members WHERE room_id = p_room_id AND user_id = p_target_user_id AND join_status = 'pending';
  ELSIF p_action = 'kick' THEN
    DELETE FROM public.room_members WHERE room_id = p_room_id AND user_id = p_target_user_id;
  ELSIF p_action IN ('ban','block') THEN
    INSERT INTO public.room_member_restrictions(room_id,user_id,restriction_type,reason,created_by)
    VALUES(p_room_id,p_target_user_id,p_action,p_reason,auth.uid()) ON CONFLICT (room_id,user_id,restriction_type) DO UPDATE SET reason = EXCLUDED.reason, created_by = EXCLUDED.created_by, expires_at = NULL, created_at = now();
    DELETE FROM public.room_members WHERE room_id = p_room_id AND user_id = p_target_user_id;
  ELSE
    DELETE FROM public.room_member_restrictions WHERE room_id = p_room_id AND user_id = p_target_user_id AND restriction_type = CASE WHEN p_action = 'unban' THEN 'ban' ELSE 'block' END;
  END IF;
  PERFORM public.record_room_control_event(p_room_id, CASE WHEN p_action IN ('ban','block','unban','unblock') THEN 'restriction_changed' ELSE 'membership_changed' END, p_target_user_id, jsonb_build_object('action', p_action));
END;
$$;

CREATE OR REPLACE FUNCTION public.transfer_room_ownership(p_room_id uuid, p_target_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public AS $$
DECLARE target_role text;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.rooms WHERE id = p_room_id AND created_by = auth.uid()) THEN RAISE EXCEPTION 'Only the room owner can transfer ownership.'; END IF;
  IF p_target_user_id = auth.uid() THEN RETURN; END IF;
  SELECT role INTO target_role FROM public.room_members WHERE room_id = p_room_id AND user_id = p_target_user_id AND join_status = 'approved' AND guest_expires_at IS NULL;
  IF target_role IS NULL OR public.room_user_is_restricted(p_room_id, p_target_user_id) THEN RAISE EXCEPTION 'The new owner must be an approved permanent member.'; END IF;
  PERFORM set_config('app.omnilume_room_control', 'ownership_transfer', true);
  UPDATE public.room_members SET role = 'admin' WHERE room_id = p_room_id AND user_id = auth.uid();
  UPDATE public.room_members SET role = 'owner' WHERE room_id = p_room_id AND user_id = p_target_user_id;
  UPDATE public.rooms SET created_by = p_target_user_id WHERE id = p_room_id;
  PERFORM public.record_room_control_event(p_room_id, 'ownership_changed', p_target_user_id, jsonb_build_object('previous_owner_id', auth.uid()));
END;
$$;

CREATE OR REPLACE FUNCTION public.set_room_member_role(p_room_id uuid, p_target_user_id uuid, p_role text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.rooms WHERE id = p_room_id AND created_by = auth.uid()) THEN RAISE EXCEPTION 'Only the room owner can change member roles.'; END IF;
  IF p_target_user_id = auth.uid() OR p_role NOT IN ('admin', 'member') THEN RAISE EXCEPTION 'Invalid room role change.'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.room_members
    WHERE room_id = p_room_id AND user_id = p_target_user_id
      AND join_status = 'approved' AND role <> 'guest' AND guest_expires_at IS NULL
  ) THEN RAISE EXCEPTION 'The member is not eligible for this role.'; END IF;
  PERFORM set_config('app.omnilume_room_control', 'role_change', true);
  UPDATE public.room_members SET role = p_role WHERE room_id = p_room_id AND user_id = p_target_user_id;
  PERFORM public.record_room_control_event(p_room_id, 'role_changed', p_target_user_id, jsonb_build_object('role', p_role));
END;
$$;

CREATE OR REPLACE FUNCTION public.update_room_controls(p_room_id uuid, p_rules text DEFAULT NULL, p_welcome_message text DEFAULT NULL, p_is_locked boolean DEFAULT NULL, p_feature_flags jsonb DEFAULT NULL)
RETURNS public.room_control_settings LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public AS $$
DECLARE settings_row public.room_control_settings;
BEGIN
  IF auth.uid() IS NULL OR NOT public.room_has_capability(p_room_id, auth.uid(), 'manage_settings') THEN RAISE EXCEPTION 'Not authorized to update room controls.'; END IF;
  IF p_rules IS NOT NULL AND char_length(p_rules) > 5000 THEN RAISE EXCEPTION 'Rules are too long.'; END IF;
  IF p_welcome_message IS NOT NULL AND char_length(p_welcome_message) > 1000 THEN RAISE EXCEPTION 'Welcome message is too long.'; END IF;
  IF p_feature_flags IS NOT NULL AND (jsonb_typeof(p_feature_flags) <> 'object' OR p_feature_flags - ARRAY['chat','watch','files','study','announcements'] <> '{}'::jsonb) THEN RAISE EXCEPTION 'Invalid feature flags.'; END IF;
  UPDATE public.room_control_settings SET rules = COALESCE(p_rules, rules), welcome_message = COALESCE(p_welcome_message, welcome_message), is_locked = COALESCE(p_is_locked, is_locked), feature_flags = COALESCE(feature_flags || p_feature_flags, feature_flags), updated_at = now(), updated_by = auth.uid() WHERE room_id = p_room_id RETURNING * INTO settings_row;
  PERFORM public.record_room_control_event(p_room_id, CASE WHEN p_is_locked IS NOT NULL THEN 'lock_changed' ELSE CASE WHEN p_feature_flags IS NOT NULL THEN 'feature_changed' ELSE 'settings_changed' END END, NULL, '{}'::jsonb);
  RETURN settings_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_room_role_permission(p_room_id uuid, p_role text, p_capability text, p_allowed boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.rooms WHERE id = p_room_id AND created_by = auth.uid()) THEN RAISE EXCEPTION 'Only the room owner can change granular permissions.'; END IF;
  IF p_role NOT IN ('admin','member','guest') OR p_capability NOT IN ('manage_members','manage_invites','manage_settings','manage_announcements','chat','watch','watch_control','files','study') THEN RAISE EXCEPTION 'Invalid room permission.'; END IF;
  UPDATE public.room_role_permissions SET allowed = p_allowed WHERE room_id = p_room_id AND role = p_role AND capability = p_capability;
  PERFORM public.record_room_control_event(p_room_id, 'settings_changed', NULL, jsonb_build_object('role', p_role, 'capability', p_capability));
END;
$$;

CREATE OR REPLACE FUNCTION public.upsert_room_member_profile(p_room_id uuid, p_display_name text DEFAULT NULL, p_avatar_url text DEFAULT NULL, p_bio text DEFAULT NULL)
RETURNS public.room_member_profiles LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public AS $$
DECLARE profile_row public.room_member_profiles;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_approved_room_member(p_room_id, auth.uid()) THEN RAISE EXCEPTION 'Not authorized to update a room profile.'; END IF;
  INSERT INTO public.room_member_profiles(room_id,user_id,display_name,avatar_url,bio) VALUES(p_room_id,auth.uid(),p_display_name,p_avatar_url,p_bio)
  ON CONFLICT(room_id,user_id) DO UPDATE SET display_name = EXCLUDED.display_name, avatar_url = EXCLUDED.avatar_url, bio = EXCLUDED.bio, updated_at = now()
  RETURNING * INTO profile_row;
  RETURN profile_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_room_announcement(p_room_id uuid, p_body text, p_is_pinned boolean DEFAULT false)
RETURNS public.room_announcements LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public AS $$
DECLARE announcement_row public.room_announcements;
BEGIN
  IF auth.uid() IS NULL OR NOT public.room_has_capability(p_room_id, auth.uid(), 'manage_announcements') THEN RAISE EXCEPTION 'Not authorized to create announcements.'; END IF;
  INSERT INTO public.room_announcements(room_id,author_id,body,is_pinned) VALUES(p_room_id,auth.uid(),p_body,p_is_pinned) RETURNING * INTO announcement_row;
  PERFORM public.record_room_control_event(p_room_id, 'announcement_changed', NULL, jsonb_build_object('announcement_id', announcement_row.id, 'state', 'created'));
  RETURN announcement_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_room_announcement(p_announcement_id uuid, p_body text, p_is_pinned boolean)
RETURNS public.room_announcements LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public AS $$
DECLARE announcement_row public.room_announcements;
BEGIN
  SELECT * INTO announcement_row FROM public.room_announcements WHERE id = p_announcement_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR NOT public.room_has_capability(announcement_row.room_id, auth.uid(), 'manage_announcements') THEN RAISE EXCEPTION 'Not authorized to update this announcement.'; END IF;
  UPDATE public.room_announcements SET body = p_body, is_pinned = p_is_pinned, updated_at = now() WHERE id = p_announcement_id RETURNING * INTO announcement_row;
  PERFORM public.record_room_control_event(announcement_row.room_id, 'announcement_changed', NULL, jsonb_build_object('announcement_id', p_announcement_id, 'state', 'updated'));
  RETURN announcement_row;
END;
$$;

-- Existing Action 04 deletion is the only former exception; Action 05 transfers
-- ownership exclusively inside the guarded RPC above.
CREATE OR REPLACE FUNCTION public.prevent_room_membership_escalation()
RETURNS trigger LANGUAGE plpgsql SET search_path TO public AS $$
BEGIN
  IF NEW.room_id IS DISTINCT FROM OLD.room_id OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN RAISE EXCEPTION 'Room membership identity cannot change.'; END IF;
  IF NEW.role IS DISTINCT FROM OLD.role
     AND COALESCE(current_setting('app.omnilume_account_deletion', true), '') <> 'true'
     AND COALESCE(current_setting('app.omnilume_room_control', true), '') NOT IN ('ownership_transfer', 'role_change') THEN RAISE EXCEPTION 'Room membership roles cannot be changed through this operation.'; END IF;
  IF NEW.join_status NOT IN ('pending', 'approved', 'rejected') THEN RAISE EXCEPTION 'Invalid room membership status.'; END IF;
  RETURN NEW;
END;
$$;

-- Account deletion predates temporary guests. Never transfer a shared room to
-- a guest because guest expiry would otherwise create an ownerless room later.
CREATE OR REPLACE FUNCTION public.prepare_account_deletion(p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public AS $$
DECLARE room_row record; replacement_user uuid;
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
    IF replacement_user IS NULL THEN
      DELETE FROM public.rooms WHERE id = room_row.id;
    ELSE
      UPDATE public.room_members SET role = 'owner'
      WHERE room_id = room_row.id AND user_id = replacement_user;
      UPDATE public.rooms SET created_by = replacement_user WHERE id = room_row.id;
    END IF;
  END LOOP;
END;
$$;

DROP POLICY IF EXISTS "Users can request to join active rooms" ON public.room_members;
CREATE POLICY "Users can request to join active rooms" ON public.room_members FOR INSERT TO authenticated WITH CHECK (
  auth.uid() = user_id AND public.room_has_active_access(room_id) AND public.room_can_join(room_id, auth.uid())
  AND (role = 'owner' AND join_status = 'approved' AND EXISTS (SELECT 1 FROM public.rooms r WHERE r.id = room_members.room_id AND r.created_by = auth.uid())
    OR role = 'member' AND join_status IN ('pending','approved') AND NOT COALESCE((SELECT is_locked FROM public.room_control_settings s WHERE s.room_id = room_members.room_id), false)
      AND (join_status = 'pending' OR EXISTS (SELECT 1 FROM public.rooms r WHERE r.id = room_members.room_id AND NOT r.is_private)))
);
DROP POLICY IF EXISTS "Owners and admins manage active membership" ON public.room_members;
DROP POLICY IF EXISTS "Users can update own membership status" ON public.room_members;
DROP POLICY IF EXISTS "Owners and admins can remove active members" ON public.room_members;
DROP POLICY IF EXISTS "Users can leave active rooms" ON public.room_members;
CREATE POLICY "Non-owner users can leave active rooms" ON public.room_members FOR DELETE TO authenticated
USING (auth.uid() = user_id AND role <> 'owner' AND public.room_has_active_access(room_id));

DROP POLICY IF EXISTS "Approved members read active room messages" ON public.messages;
CREATE POLICY "Approved members read active room messages" ON public.messages FOR SELECT TO authenticated USING (
  room_id IS NOT NULL AND public.room_has_capability(room_id, auth.uid(), 'chat')
);
DROP POLICY IF EXISTS "Users can insert messages" ON public.messages;
CREATE POLICY "Users can insert messages" ON public.messages FOR INSERT TO authenticated WITH CHECK (
  (chat_id IS NOT NULL AND auth.uid() = sender_id AND EXISTS (SELECT 1 FROM public.private_chats pc WHERE pc.id = messages.chat_id AND (pc.user_one = auth.uid() OR pc.user_two = auth.uid())))
  OR (room_id IS NOT NULL AND auth.uid() = sender_id AND public.room_has_capability(room_id, auth.uid(), 'chat'))
);
DROP POLICY IF EXISTS "Approved senders can update active room messages" ON public.messages;
CREATE POLICY "Approved senders can update active room messages" ON public.messages FOR UPDATE TO authenticated USING (
  room_id IS NOT NULL AND sender_id = auth.uid() AND public.room_has_capability(room_id, auth.uid(), 'chat')
) WITH CHECK (room_id IS NOT NULL AND sender_id = auth.uid() AND public.room_has_capability(room_id, auth.uid(), 'chat'));

DROP POLICY IF EXISTS "Approved members read active room messages" ON public.room_messages;
CREATE POLICY "Approved members read active room messages" ON public.room_messages FOR SELECT TO authenticated USING (public.room_has_capability(room_id, auth.uid(), 'chat'));
DROP POLICY IF EXISTS "Approved members send active room messages" ON public.room_messages;
CREATE POLICY "Approved members send active room messages" ON public.room_messages FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id AND public.room_has_capability(room_id, auth.uid(), 'chat'));

DROP POLICY IF EXISTS "Approved members can view active temporary media" ON public.temporary_media;
CREATE POLICY "Approved members can view active temporary media" ON public.temporary_media FOR SELECT TO authenticated USING (expires_at > now() AND public.room_has_capability(room_id, auth.uid(), 'watch'));
DROP POLICY IF EXISTS "Approved members can upload active temporary media" ON public.temporary_media;
CREATE POLICY "Approved members can upload active temporary media" ON public.temporary_media FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id AND expires_at > now() AND public.room_has_capability(room_id, auth.uid(), 'watch_control'));

DROP POLICY IF EXISTS "Users manage study sessions in active rooms" ON public.study_sessions;
CREATE POLICY "Users manage study sessions in active rooms" ON public.study_sessions FOR ALL TO authenticated USING (auth.uid() = user_id AND (room_id IS NULL OR public.room_has_capability(room_id, auth.uid(), 'study'))) WITH CHECK (auth.uid() = user_id AND (room_id IS NULL OR public.room_has_capability(room_id, auth.uid(), 'study')));

DROP POLICY IF EXISTS "Members can read active room attachments" ON storage.objects;
CREATE POLICY "Members can read active room attachments" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'room_attachments' AND public.room_has_capability((storage.foldername(name))[1]::uuid, auth.uid(), 'files'));
DROP POLICY IF EXISTS "Members can upload active room attachments" ON storage.objects;
CREATE POLICY "Members can upload active room attachments" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'room_attachments' AND public.room_has_capability((storage.foldername(name))[1]::uuid, auth.uid(), 'files'));
DROP POLICY IF EXISTS "Members can delete active room attachments" ON storage.objects;
CREATE POLICY "Members can delete active room attachments" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'room_attachments' AND public.room_has_capability((storage.foldername(name))[1]::uuid, auth.uid(), 'files'));

CREATE POLICY "Room members read controls" ON public.room_control_settings FOR SELECT TO authenticated USING (public.is_approved_room_member(room_id, auth.uid()));
CREATE POLICY "Room members read permissions" ON public.room_role_permissions FOR SELECT TO authenticated USING (public.is_approved_room_member(room_id, auth.uid()));
CREATE POLICY "Managers read invites" ON public.room_invites FOR SELECT TO authenticated USING (public.room_has_capability(room_id, auth.uid(), 'manage_invites'));
CREATE POLICY "Managers read restrictions" ON public.room_member_restrictions FOR SELECT TO authenticated USING (public.room_has_capability(room_id, auth.uid(), 'manage_members'));
CREATE POLICY "Members read room profiles" ON public.room_member_profiles FOR SELECT TO authenticated USING (public.is_approved_room_member(room_id, auth.uid()));
CREATE POLICY "Members read announcements" ON public.room_announcements FOR SELECT TO authenticated USING (public.room_feature_enabled(room_id, 'announcements') AND public.is_approved_room_member(room_id, auth.uid()));
CREATE POLICY "Members read room control events" ON public.room_control_events FOR SELECT TO authenticated USING (public.is_approved_room_member(room_id, auth.uid()));

REVOKE ALL ON FUNCTION public.room_user_is_restricted(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.room_user_role(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.room_feature_enabled(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.room_has_capability(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.room_can_join(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_room_join(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_room_invite(uuid, timestamptz, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.revoke_room_invite(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_room_invite(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.join_room_with_invite(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.leave_room(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.review_room_member(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transfer_room_ownership(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_room_member_role(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_room_controls(uuid, text, text, boolean, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_room_role_permission(uuid, text, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_room_member_profile(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_room_announcement(uuid, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_room_announcement(uuid, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.room_feature_enabled(uuid, text), public.room_has_capability(uuid, uuid, text), public.room_can_join(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.request_room_join(text), public.create_room_invite(uuid, timestamptz, integer, integer), public.revoke_room_invite(uuid), public.get_room_invite(text), public.join_room_with_invite(text), public.leave_room(uuid), public.review_room_member(uuid, uuid, text, text), public.transfer_room_ownership(uuid, uuid), public.set_room_member_role(uuid, uuid, text), public.update_room_controls(uuid, text, text, boolean, jsonb), public.set_room_role_permission(uuid, text, text, boolean), public.upsert_room_member_profile(uuid, text, text, text), public.create_room_announcement(uuid, text, boolean), public.update_room_announcement(uuid, text, boolean) TO authenticated;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'room_control_events') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.room_control_events;
  END IF;
END $$;
