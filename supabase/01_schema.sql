--
-- PostgreSQL database dump
--

\restrict 2pemX3zymr8BfzXQubWyRlbSQZFodz71MGTaBKSsIGN3x0nJyv4092P4K1JOOIt

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.11

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: message_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    requester_id uuid NOT NULL,
    recipient_id uuid NOT NULL,
    message text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    responded_at timestamp with time zone,
    responded_by uuid,
    CONSTRAINT message_requests_message_length_check CHECK (((char_length(btrim(message)) >= 1) AND (char_length(btrim(message)) <= 200))),
    CONSTRAINT message_requests_not_self CHECK ((requester_id <> recipient_id)),
    CONSTRAINT message_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text, 'cancelled'::text])))
);


--
-- Name: accept_message_request(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.accept_message_request(p_request_id uuid) RETURNS public.message_requests
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  request_row public.message_requests;
  low_user uuid;
  high_user uuid;
  existing_chat_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  SELECT * INTO request_row FROM public.message_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR request_row.recipient_id <> auth.uid() OR request_row.status <> 'pending' THEN
    RAISE EXCEPTION 'Message request is not available.';
  END IF;

  UPDATE public.message_requests
  SET status = 'accepted', responded_at = now(), responded_by = auth.uid()
  WHERE id = request_row.id
  RETURNING * INTO request_row;

  low_user := LEAST(request_row.requester_id, request_row.recipient_id);
  high_user := GREATEST(request_row.requester_id, request_row.recipient_id);

  SELECT id INTO existing_chat_id
  FROM public.private_chats
  WHERE (user_one = low_user AND user_two = high_user)
     OR (user_one = high_user AND user_two = low_user)
  LIMIT 1;

  IF existing_chat_id IS NULL THEN
    PERFORM set_config('app.omnilume_message_accept', 'true', true);
    INSERT INTO public.private_chats (user_one, user_two)
    VALUES (low_user, high_user);
  END IF;

  RETURN request_row;
END;
$$;


--
-- Name: add_media_to_queue(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.add_media_to_queue(p_room_id uuid, p_media_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid;
BEGIN
  IF v_uid IS NULL OR NOT public.room_has_capability(p_room_id, v_uid, 'watch') THEN
    RAISE EXCEPTION 'You cannot add to this room''s queue.' USING ERRCODE = '42501';
  END IF;
  IF NOT public.room_media_is_live(p_room_id, p_media_id) THEN
    RAISE EXCEPTION 'That media is not available in this room.' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('room-media-queue:' || p_room_id::text, 0));
  IF (SELECT count(*) FROM public.room_media_queue q WHERE q.room_id = p_room_id) >= 50 THEN
    RAISE EXCEPTION 'The queue holds up to 50 items.' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.room_media_queue q WHERE q.room_id = p_room_id AND q.media_id = p_media_id) THEN
    RAISE EXCEPTION 'That media is already in the queue.' USING ERRCODE = '23505';
  END IF;
  INSERT INTO public.room_media_queue (room_id, media_id, added_by, position)
  VALUES (
    p_room_id, p_media_id, v_uid,
    COALESCE((SELECT max(q.position) + 1 FROM public.room_media_queue q WHERE q.room_id = p_room_id), 0)
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;


--
-- Name: add_resource_note(uuid, numeric, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.add_resource_note(p_resource_id uuid, p_at_seconds numeric, p_body text, p_scope text DEFAULT 'room'::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_room uuid;
  v_id uuid;
BEGIN
  SELECT r.room_id INTO v_room FROM public.room_study_resources r WHERE r.id = p_resource_id;
  IF v_room IS NULL OR auth.uid() IS NULL OR NOT public.room_has_capability(v_room, auth.uid(), 'study') THEN
    RAISE EXCEPTION 'Not authorized to add notes to this resource.' USING ERRCODE = '42501';
  END IF;
  IF p_at_seconds IS NULL OR p_at_seconds < 0 OR p_at_seconds > 86400 OR p_scope NOT IN ('room', 'personal')
     OR char_length(COALESCE(btrim(p_body), '')) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'A timestamped note needs text (2000 characters) and a valid time.' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM public.room_resource_notes n WHERE n.resource_id = p_resource_id) >= 1000 THEN
    RAISE EXCEPTION 'This resource already has 1000 notes.' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.room_resource_notes (resource_id, room_id, user_id, at_seconds, body, scope)
  VALUES (p_resource_id, v_room, auth.uid(), p_at_seconds, btrim(p_body), p_scope)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;


--
-- Name: add_study_resource(uuid, text, text, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.add_study_resource(p_room_id uuid, p_kind text, p_title text, p_url text DEFAULT NULL::text, p_media_id uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
DECLARE v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.room_has_capability(p_room_id, auth.uid(), 'study') THEN
    RAISE EXCEPTION 'Not authorized to add study resources in this room.' USING ERRCODE = '42501';
  END IF;
  IF p_kind NOT IN ('youtube', 'media', 'link') OR char_length(COALESCE(btrim(p_title), '')) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'A resource needs a type and a title (200 characters).' USING ERRCODE = '22023';
  END IF;
  IF p_kind = 'media' THEN
    IF p_media_id IS NULL OR NOT public.room_media_is_live(p_room_id, p_media_id) THEN
      RAISE EXCEPTION 'Choose lecture media that is still available in this room.' USING ERRCODE = 'P0002';
    END IF;
  ELSIF p_url IS NULL OR char_length(p_url) > 2000 OR p_url !~ '^https://[^[:space:]]+$'
        OR (p_kind = 'youtube' AND p_url !~* '^https://(www\.|m\.)?(youtube\.com|youtu\.be)/') THEN
    RAISE EXCEPTION 'Enter an https:// link (YouTube links for YouTube resources).' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM public.room_study_resources r WHERE r.room_id = p_room_id) >= 200 THEN
    RAISE EXCEPTION 'This room already has 200 study resources.' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.room_study_resources (room_id, added_by, kind, title, url, media_id)
  VALUES (p_room_id, auth.uid(), p_kind, btrim(p_title),
          CASE WHEN p_kind = 'media' THEN NULL ELSE p_url END,
          CASE WHEN p_kind = 'media' THEN p_media_id ELSE NULL END)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$_$;


--
-- Name: apply_room_template(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_room_template(p_room_id uuid, p_template_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_config jsonb;
  v_settings public.room_control_settings%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR public.room_user_role(p_room_id, v_uid) IS DISTINCT FROM 'owner'
     OR NOT public.room_has_active_access(p_room_id) THEN
    RAISE EXCEPTION 'Only the room owner can apply a template.' USING ERRCODE = '42501';
  END IF;
  SELECT t.config INTO v_config FROM public.room_templates t
  WHERE t.id = p_template_id AND (t.owner_id IS NULL OR t.owner_id = v_uid);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Template not found.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_settings FROM public.room_control_settings s WHERE s.room_id = p_room_id;
  PERFORM public.update_room_controls(
    p_room_id, COALESCE(v_config ->> 'rules', ''), COALESCE(v_config ->> 'welcome_message', ''),
    v_settings.is_locked, v_config -> 'feature_flags');
  PERFORM public.update_room_appearance(
    p_room_id, v_config ->> 'default_layout', v_settings.layout_locked, v_config ->> 'theme');
  RETURN jsonb_build_object('applied', true);
END;
$$;


--
-- Name: begin_music_upload_delete(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.begin_music_upload_delete(p_upload_id uuid) RETURNS text[]
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  row_in public.music_uploads%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO row_in FROM public.music_uploads u WHERE u.id = p_upload_id FOR UPDATE;
  IF NOT FOUND OR row_in.owner_id <> auth.uid() THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  IF row_in.state = 'deleted' THEN
    RETURN ARRAY[]::text[];
  END IF;
  UPDATE public.music_uploads
  SET state = 'delete_pending', delete_requested_at = COALESCE(delete_requested_at, now())
  WHERE id = p_upload_id;
  DELETE FROM public.music_upload_shares s WHERE s.upload_id = p_upload_id;
  RETURN array_remove(ARRAY[row_in.object_path, row_in.cover_path], NULL);
END;
$$;


--
-- Name: begin_room_file_delete(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.begin_room_file_delete(p_file_id uuid) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  file_row public.room_files%ROWTYPE;
BEGIN
  SELECT * INTO file_row FROM public.room_files rf WHERE rf.id = p_file_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL
     OR NOT (file_row.owner_id = auth.uid() OR public.is_room_admin_or_owner(file_row.room_id, auth.uid())) THEN
    RAISE EXCEPTION 'Not authorized to delete this room file.';
  END IF;

  IF file_row.deleted_at IS NOT NULL THEN
    RETURN NULL;
  END IF;

  UPDATE public.room_files
  SET retention_state = 'delete_pending',
      delete_requested_at = COALESCE(delete_requested_at, now()),
      cleanup_attempts = cleanup_attempts + 1,
      last_cleanup_error = NULL
  WHERE id = p_file_id;
  RETURN file_row.object_path;
END;
$$;


--
-- Name: block_user(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.block_user(p_user_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_me uuid := auth.uid();
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501'; END IF;
  IF p_user_id IS NULL OR p_user_id = v_me OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'Invalid member.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.user_blocks (blocker_id, blocked_id) VALUES (v_me, p_user_id) ON CONFLICT DO NOTHING;
  DELETE FROM public.friendships WHERE user_one = LEAST(v_me, p_user_id) AND user_two = GREATEST(v_me, p_user_id);
  DELETE FROM public.follows
  WHERE (follower_id = v_me AND following_id = p_user_id) OR (follower_id = p_user_id AND following_id = v_me);
  UPDATE public.message_requests SET status = 'rejected', responded_at = now(), responded_by = v_me
  WHERE status = 'pending'
    AND ((requester_id = v_me AND recipient_id = p_user_id) OR (requester_id = p_user_id AND recipient_id = v_me));
  UPDATE public.friend_requests SET status = 'rejected', responded_at = now(), responded_by = v_me
  WHERE status = 'pending'
    AND ((requester_id = v_me AND recipient_id = p_user_id) OR (requester_id = p_user_id AND recipient_id = v_me));
  RETURN true;
END;
$$;


--
-- Name: cache_temporary_media_metadata(uuid, uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cache_temporary_media_metadata(p_media_id uuid, p_room_id uuid, p_metadata jsonb) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF p_media_id IS NULL OR p_room_id IS NULL OR p_metadata IS NULL THEN
    RAISE EXCEPTION 'Invalid media metadata.' USING ERRCODE = '22023';
  END IF;
  UPDATE public.temporary_media
  SET metadata = p_metadata
  WHERE id = p_media_id AND room_id = p_room_id;
  RETURN FOUND;
END;
$$;


--
-- Name: can_receive_group_topic(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.can_receive_group_topic(p_topic text) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $_$
BEGIN
  IF auth.uid() IS NULL OR p_topic IS NULL
     OR p_topic !~ '^group_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  RETURN public.is_group_member(substring(p_topic FROM 7)::uuid, auth.uid());
END;
$_$;


--
-- Name: can_receive_music_listen_topic(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.can_receive_music_listen_topic(p_topic text) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $_$
BEGIN
  IF auth.uid() IS NULL OR p_topic IS NULL
     OR p_topic !~ '^music_listen_(room|group)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  RETURN public.music_listen_can_join(split_part(p_topic, '_', 3), split_part(p_topic, '_', 4)::uuid);
END;
$_$;


--
-- Name: can_receive_private_chat_topic(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.can_receive_private_chat_topic(p_topic text) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $_$
BEGIN
  IF auth.uid() IS NULL OR p_topic IS NULL
     OR p_topic !~ '^chat_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  RETURN public.private_chat_type(substring(p_topic FROM 6)::uuid) IS NOT NULL;
END;
$_$;


--
-- Name: can_request_room_recovery(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.can_request_room_recovery(p_room_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.rooms r
      WHERE r.id = p_room_id
        AND r.expiration_type = 'recoverable'
        AND r.expires_at IS NOT NULL
        AND r.expires_at <= now()
        AND now() <= r.expires_at + interval '7 days'
        AND (r.reopened_until IS NULL OR r.reopened_until <= now())
        AND public.room_lifecycle_state(r.id) = 'recovery-window'
    )
    AND public.room_user_role(p_room_id, auth.uid()) IN ('owner', 'admin', 'member');
$$;


--
-- Name: can_view_post(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.can_view_post(p_author_id uuid, p_visibility text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT public.can_view_profile(p_author_id)
    AND (
      p_visibility = 'profile'
      OR (
        p_visibility = 'public'
        AND EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = p_author_id AND p.is_private = false
        )
      )
      OR (
        p_visibility = 'followers'
        AND (
          public.is_current_friend(auth.uid(), p_author_id)
          OR public.is_accepted_follower(auth.uid(), p_author_id)
        )
      )
    );
$$;


--
-- Name: can_view_profile(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.can_view_profile(p_profile_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = p_profile_id
      AND (
        p.id = auth.uid()
        OR p.is_private = false
        OR public.is_current_friend(auth.uid(), p.id)
        OR public.is_accepted_follower(auth.uid(), p.id)
      )
  );
$$;


--
-- Name: can_view_room_in_recovery_window(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.can_view_room_in_recovery_window(p_room_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT auth.uid() IS NOT NULL
    AND public.room_in_recovery_window(p_room_id)
    AND public.room_user_role(p_room_id, auth.uid()) IN ('owner', 'admin', 'member');
$$;


--
-- Name: can_view_room_recording(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.can_view_room_recording(p_recording_id uuid) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_row public.room_recordings%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RETURN false; END IF;
  SELECT * INTO v_row FROM public.room_recordings r WHERE r.id = p_recording_id;
  IF NOT FOUND OR NOT public.room_has_capability(v_row.room_id, auth.uid(), 'chat') THEN RETURN false; END IF;
  RETURN auth.uid() = ANY (v_row.participants)
    OR public.room_has_capability(v_row.room_id, auth.uid(), 'manage_members');
END;
$$;


--
-- Name: cancel_follow_request(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cancel_follow_request(p_target_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  UPDATE public.follows
  SET status = 'cancelled', responded_at = now()
  WHERE follower_id = auth.uid() AND following_id = p_target_id AND status = 'pending';
  RETURN FOUND;
END;
$$;


--
-- Name: cancel_friend_request(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cancel_friend_request(p_request_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  UPDATE public.friend_requests
  SET status = 'cancelled', responded_at = now(), responded_by = auth.uid()
  WHERE id = p_request_id AND requester_id = auth.uid() AND status = 'pending';
  RETURN FOUND;
END;
$$;


--
-- Name: cancel_message_request(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cancel_message_request(p_request_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  UPDATE public.message_requests
  SET status = 'cancelled', responded_at = now(), responded_by = auth.uid()
  WHERE id = p_request_id AND requester_id = auth.uid() AND status = 'pending';
  RETURN FOUND;
END;
$$;


--
-- Name: cancel_room_countdown(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cancel_room_countdown(p_countdown_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_row public.room_countdowns%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.room_countdowns c WHERE c.id = p_countdown_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR NOT public.room_has_capability(v_row.room_id, auth.uid(), 'chat')
     OR (v_row.created_by <> auth.uid() AND NOT public.room_has_capability(v_row.room_id, auth.uid(), 'manage_members')) THEN
    RAISE EXCEPTION 'Only the creator or a room manager can cancel this countdown.' USING ERRCODE = '42501';
  END IF;
  UPDATE public.room_countdowns SET cancelled_at = COALESCE(cancelled_at, now()) WHERE id = p_countdown_id;
END;
$$;


--
-- Name: cancel_room_deletion(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cancel_room_deletion(p_room_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  room_row public.rooms;
  member_row record;
BEGIN
  IF auth.uid() IS NULL OR public.room_user_role(p_room_id, auth.uid()) IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Only the room owner can cancel deletion.' USING ERRCODE = '42501';
  END IF;

  SELECT r.* INTO room_row FROM public.rooms r WHERE r.id = p_room_id FOR UPDATE;
  IF NOT FOUND OR room_row.deletion_scheduled_at IS NULL THEN
    RAISE EXCEPTION 'No deletion is scheduled for this room.';
  END IF;
  IF room_row.deletion_scheduled_at <= now() THEN
    RAISE EXCEPTION 'The grace period has ended; the room is being deleted.';
  END IF;

  PERFORM set_config('app.omnilume_lifecycle_authorized', 'deletion_schedule', true);
  UPDATE public.rooms
  SET deletion_scheduled_at = NULL,
      deletion_scheduled_by = NULL
  WHERE id = p_room_id;

  FOR member_row IN
    SELECT rm.user_id FROM public.room_members rm
    WHERE rm.room_id = p_room_id AND rm.join_status = 'approved'
  LOOP
    PERFORM public.enqueue_room_notification(
      member_row.user_id, p_room_id, 'room_deletion',
      'The scheduled deletion of "' || room_row.name || '" was cancelled. The room stays available.',
      jsonb_build_object('action', 'cancelled'),
      auth.uid(), p_room_id,
      'room_deletion:cancelled:' || p_room_id::text || ':' || extract(epoch FROM now())::bigint::text
    );
  END LOOP;
END;
$$;


--
-- Name: cancel_room_event(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cancel_room_event(p_event_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_row public.room_events%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.room_events e WHERE e.id = p_event_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL
     OR (v_row.created_by <> auth.uid() AND NOT public.room_has_capability(v_row.room_id, auth.uid(), 'manage_announcements'))
     OR NOT public.room_has_capability(v_row.room_id, auth.uid(), 'chat') THEN
    RAISE EXCEPTION 'Only the organiser or an announcement manager can cancel this event.' USING ERRCODE = '42501';
  END IF;
  UPDATE public.room_events SET cancelled_at = COALESCE(cancelled_at, now()) WHERE id = p_event_id;
END;
$$;


--
-- Name: cancel_room_recording(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cancel_room_recording(p_recording_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_row public.room_recordings%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.room_recordings r WHERE r.id = p_recording_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL
     OR (v_row.requested_by <> auth.uid() AND NOT public.room_has_capability(v_row.room_id, auth.uid(), 'manage_members')) THEN
    RAISE EXCEPTION 'Only the requester or a room manager can cancel this recording.' USING ERRCODE = '42501';
  END IF;
  IF v_row.status IN ('consent', 'recording') THEN
    UPDATE public.room_recordings SET status = 'cancelled', stopped_at = now() WHERE id = p_recording_id;
  END IF;
END;
$$;


--
-- Name: capture_study_note_version(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.capture_study_note_version() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF NEW.title IS DISTINCT FROM OLD.title OR NEW.content IS DISTINCT FROM OLD.content THEN
    INSERT INTO public.study_note_versions (note_id, room_id, version, title, content, edited_by, saved_at)
    VALUES (OLD.id, OLD.room_id, OLD.version, OLD.title, OLD.content, OLD.last_edited_by, OLD.updated_at)
    ON CONFLICT (note_id, version) DO NOTHING;
    DELETE FROM public.study_note_versions v WHERE v.note_id = OLD.id AND v.version <= OLD.version - 50;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: clear_deleted_room_message_reactions(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.clear_deleted_room_message_reactions() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF NEW.room_id IS NOT NULL AND COALESCE(NEW.is_deleted, false) AND NOT COALESCE(OLD.is_deleted, false) THEN
    PERFORM set_config('app.omnilume_message_authorized', 'reactions', true);
    DELETE FROM public.room_message_reactions WHERE message_id = NEW.id;
    PERFORM set_config('app.omnilume_message_authorized', '', true);
  END IF;
  RETURN NULL;
END;
$$;


--
-- Name: close_room_poll(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.close_room_poll(p_poll_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_poll public.room_polls%ROWTYPE;
BEGIN
  SELECT * INTO v_poll FROM public.room_polls p WHERE p.id = p_poll_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR NOT public.room_has_capability(v_poll.room_id, auth.uid(), 'chat')
     OR (v_poll.created_by <> auth.uid() AND NOT public.room_has_capability(v_poll.room_id, auth.uid(), 'manage_members')) THEN
    RAISE EXCEPTION 'Only the poll creator or a room manager can close it.' USING ERRCODE = '42501';
  END IF;
  UPDATE public.room_polls SET closed_at = COALESCE(closed_at, now()), closed_by = COALESCE(closed_by, auth.uid())
  WHERE id = p_poll_id;
END;
$$;


--
-- Name: complete_music_upload_cleanup(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.complete_music_upload_cleanup(p_upload_id uuid, p_error text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF p_error IS NULL THEN
    UPDATE public.music_uploads
    SET state = 'deleted', deleted_at = COALESCE(deleted_at, now()), last_cleanup_error = NULL
    WHERE id = p_upload_id;
    DELETE FROM public.music_upload_shares s WHERE s.upload_id = p_upload_id;
  ELSE
    UPDATE public.music_uploads
    SET cleanup_attempts = cleanup_attempts + 1, last_cleanup_error = left(p_error, 1000),
        state = CASE WHEN state = 'active' THEN 'delete_pending' ELSE state END,
        delete_requested_at = COALESCE(delete_requested_at, now())
    WHERE id = p_upload_id AND state <> 'deleted';
  END IF;
END;
$$;


--
-- Name: complete_room_file_delete(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.complete_room_file_delete(p_file_id uuid, p_error text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  file_row public.room_files%ROWTYPE;
  caller_is_service boolean := COALESCE(current_setting('request.jwt.claim.role', true), '') = 'service_role';
BEGIN
  SELECT * INTO file_row FROM public.room_files rf WHERE rf.id = p_file_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT caller_is_service AND (auth.uid() IS NULL
     OR NOT (file_row.owner_id = auth.uid() OR public.is_room_admin_or_owner(file_row.room_id, auth.uid()))) THEN
    RAISE EXCEPTION 'Not authorized to finalize this room-file cleanup.';
  END IF;

  IF p_error IS NULL THEN
    UPDATE public.room_files
    SET retention_state = 'deleted', deleted_at = COALESCE(deleted_at, now()), last_cleanup_error = NULL
    WHERE id = p_file_id;
  ELSE
    UPDATE public.room_files
    SET retention_state = 'delete_pending',
        cleanup_attempts = cleanup_attempts + 1,
        last_cleanup_error = left(p_error, 1000)
    WHERE id = p_file_id;
  END IF;
END;
$$;


--
-- Name: rooms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rooms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    is_private boolean DEFAULT false,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    username text,
    expiration_type text DEFAULT 'permanent'::text,
    expires_at timestamp with time zone,
    is_anonymous boolean DEFAULT false,
    is_group boolean DEFAULT false,
    active_media_url text,
    media_timestamp numeric DEFAULT 0,
    reopened_until timestamp with time zone,
    scheduled_for timestamp with time zone,
    deletion_scheduled_at timestamp with time zone,
    deletion_scheduled_by uuid,
    nameplate text NOT NULL,
    CONSTRAINT rooms_deletion_schedule_permanent_only CHECK (((deletion_scheduled_at IS NULL) OR (expiration_type = 'permanent'::text))),
    CONSTRAINT rooms_expiration_type_check CHECK ((expiration_type = ANY (ARRAY['permanent'::text, 'recoverable'::text, 'irreversible'::text]))),
    CONSTRAINT rooms_nameplate_check CHECK (((nameplate ~ '^[A-Za-z0-9 -]{1,12}$'::text) AND (btrim(nameplate) <> ''::text)))
);


--
-- Name: COLUMN rooms.reopened_until; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.rooms.reopened_until IS 'Server-set end of the seven-day access period after approved recovery; NULL for normal temporary/permanent rooms.';


--
-- Name: convert_active_room_to_permanent(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.convert_active_room_to_permanent(p_room_id uuid, p_username text DEFAULT NULL::text) RETURNS public.rooms
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  room_row public.rooms;
  clean_username text;
  room_expiration_type text;
  recipient record;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_room_admin_or_owner(p_room_id, auth.uid()) THEN
    RAISE EXCEPTION 'Only an approved room owner or admin can convert this room.';
  END IF;

  IF NOT public.room_has_active_access(p_room_id) THEN
    RAISE EXCEPTION 'The room is not currently active.';
  END IF;

  SELECT expiration_type INTO room_expiration_type
  FROM public.rooms
  WHERE id = p_room_id;
  IF room_expiration_type IS DISTINCT FROM 'recoverable' THEN
    RAISE EXCEPTION 'Only recoverable rooms can be converted through this workflow.';
  END IF;

  clean_username := NULLIF(lower(regexp_replace(COALESCE(p_username, ''), '[^a-z0-9_.]', '', 'g')), '');
  PERFORM set_config('app.omnilume_lifecycle_authorized', 'permanent_conversion', true);

  UPDATE public.rooms
  SET is_group = true,
      expiration_type = 'permanent',
      expires_at = NULL,
      reopened_until = NULL,
      username = COALESCE(clean_username, username)
  WHERE id = p_room_id
  RETURNING * INTO room_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Room not found.';
  END IF;

  FOR recipient IN
    SELECT DISTINCT recipients.user_id
    FROM (
      SELECT rm.user_id FROM public.room_members rm WHERE rm.room_id = p_room_id AND rm.join_status = 'approved'
      UNION SELECT m.sender_id FROM public.messages m WHERE m.room_id = p_room_id
      UNION SELECT m.receiver_id FROM public.messages m WHERE m.room_id = p_room_id AND m.receiver_id IS NOT NULL
      UNION SELECT rm2.user_id FROM public.room_messages rm2 WHERE rm2.room_id = p_room_id
      UNION SELECT ss.user_id FROM public.study_sessions ss WHERE ss.room_id = p_room_id AND ss.user_id IS NOT NULL
      UNION SELECT tm.user_id FROM public.temporary_media tm WHERE tm.room_id = p_room_id AND tm.user_id IS NOT NULL
    ) recipients
    WHERE recipients.user_id IS NOT NULL
  LOOP
    PERFORM public.enqueue_room_notification(
      recipient.user_id, p_room_id, 'permanent_conversion',
      public.notification_user_label(auth.uid()) || ' converted this room to permanent. The room is now available indefinitely.',
      jsonb_build_object('requester_id', auth.uid(), 'status', 'permanent'),
      auth.uid(), p_room_id, 'permanent_conversion:' || p_room_id::text
    );
  END LOOP;

  RETURN room_row;
END;
$$;


--
-- Name: convert_room_to_group(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.convert_room_to_group(p_room_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
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


--
-- Name: create_media_clip(uuid, uuid, numeric, numeric, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_media_clip(p_room_id uuid, p_media_id uuid, p_start numeric, p_end numeric, p_label text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid;
BEGIN
  IF v_uid IS NULL OR NOT public.room_has_capability(p_room_id, v_uid, 'watch') THEN
    RAISE EXCEPTION 'You cannot save clips in this room.' USING ERRCODE = '42501';
  END IF;
  IF NOT public.room_media_is_live(p_room_id, p_media_id) THEN
    RAISE EXCEPTION 'That media is not available in this room.' USING ERRCODE = 'P0002';
  END IF;
  IF (SELECT count(*) FROM public.room_media_clips c WHERE c.media_id = p_media_id) >= 200 THEN
    RAISE EXCEPTION 'This media already has 200 clips.' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.room_media_clips (room_id, media_id, created_by, start_seconds, end_seconds, label)
  VALUES (p_room_id, p_media_id, v_uid, round(p_start, 2), CASE WHEN p_end IS NULL THEN NULL ELSE round(p_end, 2) END, btrim(p_label))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;


--
-- Name: pdf_annotations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pdf_annotations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    room_id uuid NOT NULL,
    file_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    page_number integer NOT NULL,
    "position" jsonb DEFAULT '{}'::jsonb NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pdf_annotations_content_check CHECK (((char_length(content) >= 1) AND (char_length(content) <= 10000))),
    CONSTRAINT pdf_annotations_page_number_check CHECK (((page_number > 0) AND (page_number <= 100000))),
    CONSTRAINT pdf_annotations_position_check CHECK (((jsonb_typeof("position") = 'object'::text) AND (octet_length(convert_to(("position")::text, 'UTF8'::name)) <= 10000)))
);


--
-- Name: create_pdf_annotation(uuid, integer, jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_pdf_annotation(p_file_id uuid, p_page_number integer, p_position jsonb, p_content text) RETURNS public.pdf_annotations
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE file_row public.room_files%ROWTYPE;
DECLARE annotation_row public.pdf_annotations%ROWTYPE;
BEGIN
  SELECT * INTO file_row FROM public.room_files rf WHERE rf.id = p_file_id AND rf.deleted_at IS NULL;
  IF NOT FOUND OR auth.uid() IS NULL
     OR file_row.mime_type <> 'application/pdf'
     OR NOT public.room_has_capability(file_row.room_id, auth.uid(), 'study')
     OR NOT public.room_has_capability(file_row.room_id, auth.uid(), 'files')
     OR p_page_number IS NULL OR p_page_number < 1 OR p_page_number > 100000
     OR p_position IS NULL OR jsonb_typeof(p_position) <> 'object' OR octet_length(convert_to(p_position::text, 'UTF8')) > 10000
     OR char_length(COALESCE(btrim(p_content), '')) NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'Invalid or unauthorized PDF annotation.';
  END IF;
  INSERT INTO public.pdf_annotations(room_id, file_id, owner_id, page_number, position, content)
  VALUES (file_row.room_id, p_file_id, auth.uid(), p_page_number, p_position, btrim(p_content))
  RETURNING * INTO annotation_row;
  RETURN annotation_row;
END;
$$;


--
-- Name: room_announcements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_announcements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    room_id uuid NOT NULL,
    author_id uuid NOT NULL,
    body text NOT NULL,
    is_pinned boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT room_announcements_body_check CHECK (((char_length(body) >= 1) AND (char_length(body) <= 2000)))
);


--
-- Name: create_room_announcement(uuid, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_room_announcement(p_room_id uuid, p_body text, p_is_pinned boolean DEFAULT false) RETURNS public.room_announcements
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE announcement_row public.room_announcements;
BEGIN
  IF auth.uid() IS NULL OR NOT public.room_has_capability(p_room_id, auth.uid(), 'manage_announcements') THEN RAISE EXCEPTION 'Not authorized to create announcements.'; END IF;
  INSERT INTO public.room_announcements(room_id,author_id,body,is_pinned) VALUES(p_room_id,auth.uid(),p_body,p_is_pinned) RETURNING * INTO announcement_row;
  PERFORM public.record_room_control_event(p_room_id, 'announcement_changed', NULL, jsonb_build_object('announcement_id', announcement_row.id, 'state', 'created'));
  RETURN announcement_row;
END;
$$;


--
-- Name: create_room_countdown(uuid, text, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_room_countdown(p_room_id uuid, p_label text, p_ends_at timestamp with time zone) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.room_has_capability(p_room_id, auth.uid(), 'chat') THEN
    RAISE EXCEPTION 'Not authorized to start a countdown in this room.' USING ERRCODE = '42501';
  END IF;
  IF char_length(COALESCE(btrim(p_label), '')) NOT BETWEEN 1 AND 120
     OR p_ends_at IS NULL OR p_ends_at < now() + interval '5 seconds' OR p_ends_at > now() + interval '30 days' THEN
    RAISE EXCEPTION 'A countdown needs a label and an end between 5 seconds and 30 days from now.' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM public.room_countdowns c
      WHERE c.room_id = p_room_id AND c.cancelled_at IS NULL AND c.ends_at > now()) >= 10 THEN
    RAISE EXCEPTION 'This room already has 10 running countdowns.' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.room_countdowns (room_id, created_by, label, ends_at)
  VALUES (p_room_id, auth.uid(), btrim(p_label), p_ends_at)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;


--
-- Name: create_room_event(uuid, text, text, timestamp with time zone, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_room_event(p_room_id uuid, p_title text, p_details text, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.room_has_capability(p_room_id, auth.uid(), 'manage_announcements') THEN
    RAISE EXCEPTION 'Only members who manage announcements can schedule room events.' USING ERRCODE = '42501';
  END IF;
  IF char_length(COALESCE(btrim(p_title), '')) NOT BETWEEN 1 AND 160 OR char_length(COALESCE(p_details, '')) > 2000
     OR p_starts_at IS NULL OR p_starts_at < now() - interval '1 hour' OR p_starts_at > now() + interval '366 days'
     OR (p_ends_at IS NOT NULL AND (p_ends_at < p_starts_at OR p_ends_at > p_starts_at + interval '7 days')) THEN
    RAISE EXCEPTION 'An event needs a title, a start within the next year and an end after the start.' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM public.room_events e
      WHERE e.room_id = p_room_id AND e.cancelled_at IS NULL AND e.starts_at > now()) >= 100 THEN
    RAISE EXCEPTION 'This room already has 100 upcoming events.' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.room_events (room_id, created_by, title, details, starts_at, ends_at)
  VALUES (p_room_id, auth.uid(), btrim(p_title), COALESCE(p_details, ''), p_starts_at, p_ends_at)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;


--
-- Name: room_invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_invites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    room_id uuid NOT NULL,
    token text NOT NULL,
    created_by uuid NOT NULL,
    expires_at timestamp with time zone,
    max_uses integer,
    uses_count integer DEFAULT 0 NOT NULL,
    guest_lifetime_minutes integer,
    revoked_at timestamp with time zone,
    revoked_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_door_key boolean DEFAULT false NOT NULL,
    CONSTRAINT room_invites_guest_lifetime_check CHECK (((guest_lifetime_minutes IS NULL) OR ((guest_lifetime_minutes >= 5) AND (guest_lifetime_minutes <= 10080)))),
    CONSTRAINT room_invites_usage_check CHECK (((max_uses IS NULL) OR (max_uses > 0))),
    CONSTRAINT room_invites_uses_count_check CHECK ((uses_count >= 0))
);


--
-- Name: create_room_invite(uuid, timestamp with time zone, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_room_invite(p_room_id uuid, p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_max_uses integer DEFAULT NULL::integer, p_guest_lifetime_minutes integer DEFAULT NULL::integer) RETURNS public.room_invites
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  invite_row public.room_invites;
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.room_has_capability(p_room_id, auth.uid(), 'manage_invites') THEN
    RAISE EXCEPTION 'Not authorized to create room invites.';
  END IF;

  IF p_expires_at IS NOT NULL AND p_expires_at <= now() THEN
    RAISE EXCEPTION 'Invite expiry must be in the future.';
  END IF;
  IF p_max_uses IS NOT NULL AND p_max_uses < 1 THEN
    RAISE EXCEPTION 'Invite max uses must be positive.';
  END IF;
  IF p_guest_lifetime_minutes IS NOT NULL
     AND p_guest_lifetime_minutes NOT BETWEEN 5 AND 10080 THEN
    RAISE EXCEPTION 'Guest duration is invalid.';
  END IF;

  INSERT INTO public.room_invites(room_id, token, created_by, expires_at, max_uses, guest_lifetime_minutes)
  VALUES (
    p_room_id,
    encode(extensions.gen_random_bytes(24), 'hex'),
    auth.uid(),
    p_expires_at,
    p_max_uses,
    p_guest_lifetime_minutes
  )
  RETURNING * INTO invite_row;

  PERFORM public.record_room_control_event(
    p_room_id,
    'invite_changed',
    NULL,
    jsonb_build_object('invite_id', invite_row.id, 'state', 'created')
  );

  RETURN invite_row;
END;
$$;


--
-- Name: create_room_poll(uuid, text, text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_room_poll(p_room_id uuid, p_question text, p_options text[]) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_options text[];
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.room_has_capability(p_room_id, auth.uid(), 'chat') THEN
    RAISE EXCEPTION 'Not authorized to create polls in this room.' USING ERRCODE = '42501';
  END IF;
  SELECT array_agg(btrim(o) ORDER BY ord) INTO v_options
  FROM unnest(COALESCE(p_options, ARRAY[]::text[])) WITH ORDINALITY AS t(o, ord)
  WHERE btrim(o) <> '';
  IF char_length(COALESCE(btrim(p_question), '')) NOT BETWEEN 1 AND 300
     OR COALESCE(cardinality(v_options), 0) NOT BETWEEN 2 AND 10
     OR EXISTS (SELECT 1 FROM unnest(v_options) o WHERE char_length(o) > 120)
     OR (SELECT count(DISTINCT lower(o)) FROM unnest(v_options) o) <> cardinality(v_options) THEN
    RAISE EXCEPTION 'A poll needs a question and 2 to 10 different options (120 characters each).' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM public.room_polls p WHERE p.room_id = p_room_id AND p.closed_at IS NULL) >= 20 THEN
    RAISE EXCEPTION 'This room already has 20 open polls.' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.room_polls (room_id, created_by, question, options)
  VALUES (p_room_id, auth.uid(), btrim(p_question), v_options)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;


--
-- Name: create_room_task(uuid, text, text, uuid, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_room_task(p_room_id uuid, p_title text, p_details text DEFAULT ''::text, p_assignee_id uuid DEFAULT NULL::uuid, p_due_at timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.room_has_capability(p_room_id, auth.uid(), 'study') THEN
    RAISE EXCEPTION 'Not authorized to add tasks in this room.' USING ERRCODE = '42501';
  END IF;
  IF char_length(COALESCE(btrim(p_title), '')) NOT BETWEEN 1 AND 200 OR char_length(COALESCE(p_details, '')) > 2000 THEN
    RAISE EXCEPTION 'A task needs a title (200 characters) and details up to 2000 characters.' USING ERRCODE = '22023';
  END IF;
  IF p_assignee_id IS NOT NULL AND NOT public.room_member_can(p_room_id, p_assignee_id, 'study') THEN
    RAISE EXCEPTION 'The assignee must be a member who can use Study.' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM public.room_tasks t WHERE t.room_id = p_room_id) >= 500 THEN
    RAISE EXCEPTION 'This room already has 500 tasks.' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.room_tasks (room_id, created_by, title, details, assignee_id, due_at)
  VALUES (p_room_id, auth.uid(), btrim(p_title), COALESCE(p_details, ''), p_assignee_id, p_due_at)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;


--
-- Name: study_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.study_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    room_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    scope text NOT NULL,
    title text DEFAULT 'Untitled note'::text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_edited_by uuid,
    locked boolean DEFAULT false NOT NULL,
    locked_by uuid,
    CONSTRAINT study_notes_content_check CHECK ((char_length(content) <= 100000)),
    CONSTRAINT study_notes_scope_check CHECK ((scope = ANY (ARRAY['room'::text, 'personal'::text]))),
    CONSTRAINT study_notes_title_check CHECK (((char_length(title) >= 1) AND (char_length(title) <= 160))),
    CONSTRAINT study_notes_version_check CHECK ((version > 0))
);


--
-- Name: create_study_note(uuid, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_study_note(p_room_id uuid, p_scope text, p_title text DEFAULT 'Untitled note'::text, p_content text DEFAULT ''::text) RETURNS public.study_notes
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE note_row public.study_notes%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.room_has_capability(p_room_id, auth.uid(), 'study')
     OR p_scope NOT IN ('room', 'personal')
     OR char_length(COALESCE(btrim(p_title), '')) NOT BETWEEN 1 AND 160
     OR char_length(COALESCE(p_content, '')) > 100000 THEN
    RAISE EXCEPTION 'Invalid or unauthorized study note.';
  END IF;

  INSERT INTO public.study_notes(room_id, owner_id, scope, title, content)
  VALUES (p_room_id, auth.uid(), p_scope, btrim(p_title), COALESCE(p_content, ''))
  RETURNING * INTO note_row;
  RETURN note_row;
END;
$$;


--
-- Name: delete_media_clip(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_media_clip(p_clip_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_clip public.room_media_clips%ROWTYPE;
BEGIN
  SELECT * INTO v_clip FROM public.room_media_clips c WHERE c.id = p_clip_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_uid IS NULL
     OR NOT (
       public.room_has_capability(v_clip.room_id, v_uid, 'watch_control')
       OR (v_clip.created_by = v_uid AND public.room_has_capability(v_clip.room_id, v_uid, 'watch'))
     ) THEN
    RAISE EXCEPTION 'You cannot delete this clip.' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.room_media_clips c WHERE c.id = p_clip_id;
  RETURN true;
END;
$$;


--
-- Name: delete_pdf_annotation(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_pdf_annotation(p_annotation_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE annotation_row public.pdf_annotations%ROWTYPE;
BEGIN
  SELECT * INTO annotation_row FROM public.pdf_annotations pa WHERE pa.id = p_annotation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF auth.uid() IS NULL
     OR NOT public.room_has_capability(annotation_row.room_id, auth.uid(), 'study')
     OR NOT public.room_has_capability(annotation_row.room_id, auth.uid(), 'files')
     OR NOT (annotation_row.owner_id = auth.uid() OR public.is_room_admin_or_owner(annotation_row.room_id, auth.uid())) THEN
    RAISE EXCEPTION 'Not authorized to delete this PDF annotation.';
  END IF;
  DELETE FROM public.pdf_annotations WHERE id = p_annotation_id;
END;
$$;


--
-- Name: delete_resource_note(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_resource_note(p_note_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_row public.room_resource_notes%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.room_resource_notes n WHERE n.id = p_note_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF auth.uid() IS NULL OR NOT public.room_has_capability(v_row.room_id, auth.uid(), 'study')
     OR (v_row.user_id <> auth.uid()
         AND (v_row.scope <> 'room' OR NOT public.room_has_capability(v_row.room_id, auth.uid(), 'manage_members'))) THEN
    RAISE EXCEPTION 'Only the author or a room manager can delete this note.' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.room_resource_notes WHERE id = p_note_id;
END;
$$;


--
-- Name: delete_room_poll(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_room_poll(p_poll_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_poll public.room_polls%ROWTYPE;
BEGIN
  SELECT * INTO v_poll FROM public.room_polls p WHERE p.id = p_poll_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF auth.uid() IS NULL OR NOT public.room_has_capability(v_poll.room_id, auth.uid(), 'chat')
     OR (v_poll.created_by <> auth.uid() AND NOT public.room_has_capability(v_poll.room_id, auth.uid(), 'manage_members')) THEN
    RAISE EXCEPTION 'Only the poll creator or a room manager can delete it.' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.room_polls WHERE id = p_poll_id;
END;
$$;


--
-- Name: delete_room_recording(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_room_recording(p_recording_id uuid) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_row public.room_recordings%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.room_recordings r WHERE r.id = p_recording_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL
     OR (v_row.requested_by <> auth.uid() AND NOT public.room_has_capability(v_row.room_id, auth.uid(), 'manage_members')) THEN
    RAISE EXCEPTION 'Only the requester or a room manager can delete this recording.' USING ERRCODE = '42501';
  END IF;
  UPDATE public.room_recordings SET status = 'deleted' WHERE id = p_recording_id;
  DELETE FROM public.room_recording_transcripts t WHERE t.recording_id = p_recording_id;
  RETURN v_row.storage_path;
END;
$$;


--
-- Name: delete_room_task(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_room_task(p_task_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_task public.room_tasks%ROWTYPE;
BEGIN
  SELECT * INTO v_task FROM public.room_tasks t WHERE t.id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF auth.uid() IS NULL OR NOT public.room_has_capability(v_task.room_id, auth.uid(), 'study')
     OR (v_task.created_by <> auth.uid() AND NOT public.room_has_capability(v_task.room_id, auth.uid(), 'manage_members')) THEN
    RAISE EXCEPTION 'Only the creator or a room manager can delete this task.' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.room_tasks WHERE id = p_task_id;
END;
$$;


--
-- Name: delete_room_template(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_room_template(p_template_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  DELETE FROM public.room_templates t WHERE t.id = p_template_id AND t.owner_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Template not found.' USING ERRCODE = '42501';
  END IF;
END;
$$;


--
-- Name: delete_study_note(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_study_note(p_note_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE note_row public.study_notes%ROWTYPE;
BEGIN
  SELECT * INTO note_row FROM public.study_notes sn WHERE sn.id = p_note_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF auth.uid() IS NULL
     OR NOT public.room_has_capability(note_row.room_id, auth.uid(), 'study')
     OR NOT (
       note_row.owner_id = auth.uid()
       OR (note_row.scope = 'room' AND public.is_room_admin_or_owner(note_row.room_id, auth.uid()))
     ) THEN
    RAISE EXCEPTION 'Not authorized to delete this study note.';
  END IF;
  DELETE FROM public.study_notes WHERE id = p_note_id;
END;
$$;


--
-- Name: delete_study_resource(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_study_resource(p_resource_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_row public.room_study_resources%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.room_study_resources r WHERE r.id = p_resource_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF auth.uid() IS NULL OR NOT public.room_has_capability(v_row.room_id, auth.uid(), 'study')
     OR (v_row.added_by <> auth.uid() AND NOT public.room_has_capability(v_row.room_id, auth.uid(), 'manage_members')) THEN
    RAISE EXCEPTION 'Only the member who added it or a room manager can remove this resource.' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.room_study_resources WHERE id = p_resource_id;
END;
$$;


--
-- Name: destroy_expired_room(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.destroy_expired_room(p_room_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
$$;


--
-- Name: discover_rooms(text, text, integer, text, text, text, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.discover_rooms(p_query text DEFAULT NULL::text, p_lifespan text DEFAULT NULL::text, p_min_members integer DEFAULT NULL::integer, p_feature text DEFAULT NULL::text, p_sort text DEFAULT 'newest'::text, p_scope text DEFAULT 'public'::text, p_limit integer DEFAULT 24, p_offset integer DEFAULT 0) RETURNS TABLE(id uuid, name text, description text, username text, expiration_type text, deletion_scheduled_at timestamp with time zone, created_at timestamp with time zone, member_count integer, is_private boolean, viewer_role text, last_activity_at timestamp with time zone, feature_flags jsonb, bookmarked boolean)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_uid uuid := auth.uid();
  v_query text := btrim(COALESCE(p_query, ''));
  v_pattern text;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 24), 1), 48);
  v_offset integer := LEAST(GREATEST(COALESCE(p_offset, 0), 0), 10000);
BEGIN
  IF p_lifespan IS NOT NULL AND p_lifespan NOT IN ('permanent', 'recoverable', 'irreversible') THEN
    RAISE EXCEPTION 'Unknown lifespan filter.' USING ERRCODE = '22023';
  END IF;
  IF p_feature IS NOT NULL AND p_feature NOT IN ('chat', 'watch', 'files', 'study', 'announcements') THEN
    RAISE EXCEPTION 'Unknown feature filter.' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_sort, 'newest') NOT IN ('newest', 'members', 'active') THEN
    RAISE EXCEPTION 'Unknown sort.' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_scope, 'public') NOT IN ('public', 'mine') THEN
    RAISE EXCEPTION 'Unknown scope.' USING ERRCODE = '22023';
  END IF;
  IF p_min_members IS NOT NULL AND (p_min_members < 0 OR p_min_members > 100000) THEN
    RAISE EXCEPTION 'Unknown member filter.' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_query) > 100 THEN
    RAISE EXCEPTION 'Search for up to 100 characters.' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_scope, 'public') = 'mine' AND v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to search your rooms.' USING ERRCODE = '42501';
  END IF;
  v_pattern := '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  RETURN QUERY
  WITH visible AS (
    SELECT r.*,
           s.feature_flags AS flags,
           COALESCE(s.is_locked, false) AS locked,
           public.room_user_role(r.id, v_uid) AS my_role
    FROM public.rooms r
    LEFT JOIN public.room_control_settings s ON s.room_id = r.id
    WHERE public.room_has_active_access(r.id)
      AND (
        (COALESCE(p_scope, 'public') = 'public'
          AND NOT r.is_private AND NOT r.is_group AND r.scheduled_for IS NULL
          AND r.deletion_scheduled_at IS NULL AND NOT COALESCE(s.is_locked, false)
          AND (v_uid IS NULL OR NOT public.room_user_is_restricted(r.id, v_uid)))
        OR
        (p_scope = 'mine' AND public.is_approved_room_member(r.id, v_uid))
      )
      AND (p_lifespan IS NULL OR r.expiration_type = p_lifespan)
      AND (v_query = '' OR r.name ILIKE v_pattern OR COALESCE(r.username, '') ILIKE v_pattern
           OR COALESCE(r.description, '') ILIKE v_pattern)
      AND (p_feature IS NULL OR COALESCE(s.feature_flags ->> p_feature, 'true') = 'true')
  ), counted AS (
    SELECT v.*,
           (SELECT count(*)::integer FROM public.room_members rm
            WHERE rm.room_id = v.id AND rm.join_status = 'approved' AND NOT rm.is_ghost_mode
              AND (rm.guest_expires_at IS NULL OR rm.guest_expires_at > now())) AS members,
           (SELECT max(a.created_at) FROM public.room_activity a WHERE a.room_id = v.id) AS last_act
    FROM visible v
  )
  SELECT c.id, c.name, c.description,
         CASE WHEN c.is_private AND c.my_role IS NULL THEN NULL ELSE c.username END,
         c.expiration_type, c.deletion_scheduled_at, c.created_at, c.members,
         c.is_private, c.my_role, c.last_act, c.flags,
         EXISTS (SELECT 1 FROM public.room_bookmarks b
                 WHERE b.user_id = v_uid AND b.kind = 'room' AND b.entity_id = c.id)
  FROM counted c
  WHERE p_min_members IS NULL OR c.members >= p_min_members
  ORDER BY
    CASE WHEN COALESCE(p_sort, 'newest') = 'members' THEN c.members END DESC NULLS LAST,
    CASE WHEN COALESCE(p_sort, 'newest') = 'active' THEN c.last_act END DESC NULLS LAST,
    c.created_at DESC, c.id
  LIMIT v_limit OFFSET v_offset;
END;
$$;


--
-- Name: enforce_profile_minimum_age(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_profile_minimum_age() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  IF NEW.date_of_birth IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.date_of_birth IS DISTINCT FROM OLD.date_of_birth)
     AND NEW.date_of_birth > (current_date - interval '13 years')::date THEN
    RAISE EXCEPTION 'You must be at least 13 years old to use OmniLume.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: enqueue_room_notification(uuid, uuid, text, text, jsonb, uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enqueue_room_notification(p_recipient_id uuid, p_room_id uuid, p_type text, p_message text, p_metadata jsonb DEFAULT '{}'::jsonb, p_actor_id uuid DEFAULT NULL::uuid, p_entity_id uuid DEFAULT NULL::uuid, p_dedupe_key text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_metadata jsonb := COALESCE(p_metadata, '{}'::jsonb);
BEGIN
  IF p_recipient_id IS NULL OR p_room_id IS NULL OR p_type IS NULL OR btrim(COALESCE(p_message, '')) = '' THEN
    RETURN false;
  END IF;

  IF p_actor_id IS NOT NULL
     AND p_actor_id = p_recipient_id
     AND p_type NOT IN ('recovery_decision', 'access', 'security', 'room_deletion') THEN
    RETURN false;
  END IF;

  IF p_type NOT IN ('recovery_request', 'recovery_decision', 'access', 'security', 'room_deletion')
     AND public.notifications_suppressed(p_recipient_id, p_room_id) THEN
    RETURN false;
  END IF;

  IF NOT v_metadata ? 'room_name' THEN
    v_metadata := v_metadata || jsonb_build_object('room_name', (SELECT r.name FROM public.rooms r WHERE r.id = p_room_id));
  END IF;

  INSERT INTO public.room_notifications (
    room_id, recipient_id, notification_type, message, metadata, actor_id, entity_id, dedupe_key
  )
  VALUES (
    p_room_id, p_recipient_id, p_type, left(btrim(p_message), 500),
    v_metadata, p_actor_id, p_entity_id, p_dedupe_key
  )
  ON CONFLICT (recipient_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;

  RETURN FOUND;
END;
$$;


--
-- Name: expire_room_recordings(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.expire_room_recordings() RETURNS TABLE(storage_path text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  RETURN QUERY
  UPDATE public.room_recordings r SET status = 'deleted'
  WHERE r.status = 'stopped' AND r.retention_until IS NOT NULL AND r.retention_until < now()
  RETURNING r.storage_path;
END;
$$;


--
-- Name: export_room_snapshot(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.export_room_snapshot(p_room_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_export uuid := gen_random_uuid();
  v_room jsonb; v_members jsonb; v_announcements jsonb; v_messages jsonb; v_notes jsonb;
  v_tasks jsonb; v_polls jsonb; v_events jsonb; v_files jsonb; v_clips jsonb;
  v_message_total integer; v_encrypted integer; v_truncated boolean;
  v_counts jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.room_has_active_access(p_room_id)
     OR NOT public.is_room_admin_or_owner(p_room_id, v_uid) THEN
    RAISE EXCEPTION 'Only a room owner or admin can export this room.' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.rooms r WHERE r.id = p_room_id FOR UPDATE;
  IF (SELECT count(*) FROM public.room_exports e
      WHERE e.room_id = p_room_id AND e.created_at > now() - interval '1 hour') >= 3
     OR (SELECT count(*) FROM public.room_exports e
         WHERE e.requested_by = v_uid AND e.created_at > now() - interval '1 day') >= 10 THEN
    RAISE EXCEPTION 'Export limit reached. Try again later.' USING ERRCODE = 'P0429';
  END IF;

  SELECT jsonb_build_object('id', r.id, 'name', r.name, 'description', r.description,
           'expiration_type', r.expiration_type, 'is_private', r.is_private, 'is_group', r.is_group,
           'created_at', r.created_at,
           'rules', s.rules, 'welcome_message', s.welcome_message, 'feature_flags', s.feature_flags,
           'default_layout', s.default_layout, 'theme', s.theme)
    INTO v_room
  FROM public.rooms r LEFT JOIN public.room_control_settings s ON s.room_id = r.id WHERE r.id = p_room_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id', rm.user_id, 'role', rm.role, 'joined_at', rm.joined_at,
           'display_name', COALESCE(NULLIF(btrim(mp.display_name), ''), pr.display_name)) ORDER BY rm.joined_at), '[]'::jsonb)
    INTO v_members
  FROM public.room_members rm
  LEFT JOIN public.profiles pr ON pr.id = rm.user_id
  LEFT JOIN public.room_member_profiles mp ON mp.room_id = rm.room_id AND mp.user_id = rm.user_id
  WHERE rm.room_id = p_room_id AND rm.join_status = 'approved';

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', a.id, 'author_id', a.author_id, 'body', a.body,
           'is_pinned', a.is_pinned, 'created_at', a.created_at) ORDER BY a.created_at), '[]'::jsonb)
    INTO v_announcements FROM public.room_announcements a WHERE a.room_id = p_room_id;

  -- Plaintext chat only: end-to-end encrypted rows (ciphertext) are counted,
  -- never exported, and no key material is read.
  SELECT count(*) FILTER (WHERE m.ciphertext IS NOT NULL), count(*) FILTER (WHERE m.ciphertext IS NULL AND m.content IS NOT NULL AND NOT COALESCE(m.is_deleted, false))
    INTO v_encrypted, v_message_total
  FROM public.messages m WHERE m.room_id = p_room_id;
  v_truncated := v_message_total > 5000;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', x.id, 'sender_id', x.sender_id, 'content', x.content,
           'created_at', x.created_at, 'reply_to_id', x.reply_to_id, 'pinned_at', x.pinned_at) ORDER BY x.created_at), '[]'::jsonb)
    INTO v_messages
  FROM (SELECT m.* FROM public.messages m
        WHERE m.room_id = p_room_id AND m.ciphertext IS NULL AND m.content IS NOT NULL AND NOT COALESCE(m.is_deleted, false)
        ORDER BY m.created_at DESC LIMIT 5000) x;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', n.id, 'title', n.title, 'content', n.content,
           'version', n.version, 'updated_at', n.updated_at) ORDER BY n.created_at), '[]'::jsonb)
    INTO v_notes FROM public.study_notes n WHERE n.room_id = p_room_id AND n.scope = 'room';
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'details', t.details,
           'assignee_id', t.assignee_id, 'due_at', t.due_at, 'status', t.status) ORDER BY t.created_at), '[]'::jsonb)
    INTO v_tasks FROM public.room_tasks t WHERE t.room_id = p_room_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', p.id, 'question', p.question, 'options', p.options,
           'closed_at', p.closed_at, 'created_at', p.created_at) ORDER BY p.created_at), '[]'::jsonb)
    INTO v_polls FROM public.room_polls p WHERE p.room_id = p_room_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', e.id, 'title', e.title, 'details', e.details,
           'starts_at', e.starts_at, 'ends_at', e.ends_at, 'cancelled_at', e.cancelled_at) ORDER BY e.starts_at), '[]'::jsonb)
    INTO v_events FROM public.room_events e WHERE e.room_id = p_room_id;
  -- File manifest only: no storage paths, URLs or signed links.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', f.id, 'name', f.original_name, 'mime_type', f.mime_type,
           'size_bytes', f.size_bytes, 'created_at', f.created_at) ORDER BY f.created_at), '[]'::jsonb)
    INTO v_files FROM public.room_files f WHERE f.room_id = p_room_id AND f.retention_state = 'active';
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', c.id, 'label', c.label, 'start_seconds', c.start_seconds,
           'end_seconds', c.end_seconds, 'created_at', c.created_at) ORDER BY c.created_at), '[]'::jsonb)
    INTO v_clips FROM public.room_media_clips c WHERE c.room_id = p_room_id;

  v_counts := jsonb_build_object('members', jsonb_array_length(v_members), 'messages', jsonb_array_length(v_messages),
    'encrypted_messages_excluded', v_encrypted, 'announcements', jsonb_array_length(v_announcements),
    'notes', jsonb_array_length(v_notes), 'tasks', jsonb_array_length(v_tasks), 'polls', jsonb_array_length(v_polls),
    'events', jsonb_array_length(v_events), 'files', jsonb_array_length(v_files), 'clips', jsonb_array_length(v_clips));

  INSERT INTO public.room_exports (id, room_id, requested_by, counts, truncated)
  VALUES (v_export, p_room_id, v_uid, v_counts, v_truncated);

  RETURN jsonb_build_object('export_id', v_export, 'format', 'omnilume-room-export-1', 'exported_at', now(),
    'truncated', v_truncated, 'counts', v_counts, 'room', v_room, 'members', v_members,
    'announcements', v_announcements, 'messages', v_messages, 'notes', v_notes, 'tasks', v_tasks,
    'polls', v_polls, 'events', v_events, 'files', v_files, 'clips', v_clips);
END;
$$;


--
-- Name: finish_room_recording(uuid, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finish_room_recording(p_recording_id uuid, p_storage_path text, p_duration_seconds integer) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
DECLARE v_row public.room_recordings%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.room_recordings r WHERE r.id = p_recording_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR v_row.requested_by <> auth.uid() THEN
    RAISE EXCEPTION 'Only the member who started this recording can finish it.' USING ERRCODE = '42501';
  END IF;
  IF v_row.status <> 'recording' THEN
    RAISE EXCEPTION 'This recording is not running.' USING ERRCODE = '23514';
  END IF;
  IF p_storage_path IS NULL OR p_storage_path !~ ('^' || v_row.room_id::text || '/' || v_row.id::text || '\.(webm|ogg|m4a)$')
     OR p_duration_seconds IS NULL OR p_duration_seconds NOT BETWEEN 0 AND 86400 THEN
    RAISE EXCEPTION 'Invalid recording file.' USING ERRCODE = '22023';
  END IF;
  UPDATE public.room_recordings
  SET status = 'stopped', stopped_at = now(), storage_path = p_storage_path,
      duration_seconds = p_duration_seconds, retention_until = now() + interval '7 days'
  WHERE id = p_recording_id;
END;
$_$;


--
-- Name: get_music_listen_session(text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_music_listen_session(p_kind text, p_target uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  s public.music_listen_sessions%ROWTYPE;
BEGIN
  IF NOT public.music_listen_can_join(p_kind, p_target) THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO s FROM public.music_listen_sessions x WHERE x.target_kind = p_kind AND x.target_id = p_target;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN public.music_listen_json(s);
END;
$$;


--
-- Name: get_music_playback(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_music_playback(p_upload_id uuid) RETURNS TABLE(object_path text, cover_path text, expires_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.music_can_play(p_upload_id, auth.uid()) THEN
    RAISE EXCEPTION 'This song is not available.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT u.object_path, u.cover_path, u.expires_at FROM public.music_uploads u WHERE u.id = p_upload_id;
END;
$$;


--
-- Name: get_my_conversations(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_my_conversations() RETURNS TABLE(conversation_id uuid, conversation_type text, peer_id uuid, title text, role text, last_message_at timestamp with time zone, unread_count integer)
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  SELECT pc.id, t.kind,
    CASE WHEN pc.user_one = auth.uid() THEN pc.user_two ELSE pc.user_one END,
    NULL::text, NULL::text,
    (SELECT max(m.created_at) FROM public.messages m WHERE m.chat_id = pc.id),
    (SELECT count(*)::integer FROM (
      SELECT 1 FROM public.messages m
      WHERE m.chat_id = pc.id AND m.sender_id <> auth.uid() AND m.created_at > COALESCE(r.last_read_at, '-infinity')
      LIMIT 100) u)
  FROM public.private_chats pc
  CROSS JOIN LATERAL (SELECT public.private_chat_type(pc.id) AS kind) t
  LEFT JOIN public.conversation_reads r ON r.user_id = auth.uid() AND r.chat_id = pc.id
  WHERE auth.uid() IN (pc.user_one, pc.user_two) AND t.kind IS NOT NULL
  UNION ALL
  SELECT g.id, 'group', NULL::uuid, g.name, gm.role,
    (SELECT max(m.created_at) FROM public.group_messages m WHERE m.group_id = g.id),
    (SELECT count(*)::integer FROM (
      SELECT 1 FROM public.group_messages m
      WHERE m.group_id = g.id AND m.sender_id <> auth.uid() AND m.created_at > COALESCE(r.last_read_at, '-infinity')
      LIMIT 100) u)
  FROM public.group_members gm
  JOIN public.groups g ON g.id = gm.group_id
  LEFT JOIN public.conversation_reads r ON r.user_id = auth.uid() AND r.group_id = g.id
  WHERE gm.user_id = auth.uid();
$$;


--
-- Name: get_my_room_join_eligibility(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_my_room_join_eligibility(p_room_id uuid) RETURNS TABLE(state text, can_join boolean, join_status text, role text, guest_expires_at timestamp with time zone, restriction_types text[])
    LANGUAGE plpgsql SECURITY DEFINER
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


--
-- Name: get_my_room_presence_mode(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_my_room_presence_mode(p_room_id uuid) RETURNS TABLE(is_ghost_mode boolean, can_view_ghost_presence boolean)
    LANGUAGE plpgsql SECURITY DEFINER
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


--
-- Name: get_profile_followers(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_profile_followers(p_profile_id uuid) RETURNS TABLE(user_id uuid, username text, display_name text, avatar_url text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT p.id, p.username, p.display_name, p.avatar_url
  FROM public.follows f
  JOIN public.profiles p ON p.id = f.follower_id
  WHERE f.following_id = p_profile_id
    AND f.status = 'accepted'
    AND public.can_view_profile(p_profile_id);
$$;


--
-- Name: get_profile_following(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_profile_following(p_profile_id uuid) RETURNS TABLE(user_id uuid, username text, display_name text, avatar_url text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT p.id, p.username, p.display_name, p.avatar_url
  FROM public.follows f
  JOIN public.profiles p ON p.id = f.following_id
  WHERE f.follower_id = p_profile_id
    AND f.status = 'accepted'
    AND public.can_view_profile(p_profile_id);
$$;


--
-- Name: get_room_by_identifier(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_room_by_identifier(identifier text) RETURNS SETOF public.rooms
    LANGUAGE sql STABLE SECURITY DEFINER
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
        AND public.room_user_role(r.id, auth.uid()) IN ('owner', 'admin', 'member')
      )
    )
  LIMIT 1;
$$;


--
-- Name: get_room_file_download_path(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_room_file_download_path(p_file_id uuid) RETURNS text
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  file_row public.room_files%ROWTYPE;
BEGIN
  SELECT * INTO file_row
  FROM public.room_files rf
  WHERE rf.id = p_file_id AND rf.deleted_at IS NULL;

  IF NOT FOUND OR auth.uid() IS NULL
     OR NOT public.room_has_capability(file_row.room_id, auth.uid(), 'files') THEN
    RAISE EXCEPTION 'Not authorized to download this room file.';
  END IF;
  RETURN file_row.object_path;
END;
$$;


--
-- Name: get_room_for_join(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_room_for_join(identifier text) RETURNS TABLE(id uuid, is_private boolean, expiration_type text, expires_at timestamp with time zone, reopened_until timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT r.id, r.is_private, r.expiration_type, r.expires_at, r.reopened_until
  FROM public.rooms r
  WHERE (lower(r.username) = lower(identifier) OR r.id::text = identifier)
    AND public.room_has_active_access(r.id)
  LIMIT 1;
$$;


--
-- Name: get_room_group(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_room_group(p_room_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
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


--
-- Name: get_room_invite(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_room_invite(p_token text) RETURNS TABLE(room_id uuid, expires_at timestamp with time zone, max_uses integer, uses_count integer, guest_lifetime_minutes integer)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT i.room_id, i.expires_at, i.max_uses, i.uses_count, i.guest_lifetime_minutes
  FROM public.room_invites i
  WHERE auth.uid() IS NOT NULL AND i.token = p_token AND i.revoked_at IS NULL
    AND (i.expires_at IS NULL OR i.expires_at > now()) AND (i.max_uses IS NULL OR i.uses_count < i.max_uses)
    AND public.room_can_join(i.room_id, auth.uid());
$$;


--
-- Name: get_room_invite_preview(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_room_invite_preview(p_token text) RETURNS TABLE(room_id uuid, room_name text, is_private boolean, expiration_type text, room_expires_at timestamp with time zone, reopened_until timestamp with time zone, deletion_scheduled_at timestamp with time zone, guest_lifetime_minutes integer)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT r.id, r.name, r.is_private, r.expiration_type, r.expires_at, r.reopened_until, r.deletion_scheduled_at, i.guest_lifetime_minutes
  FROM public.room_invites i
  JOIN public.rooms r ON r.id = i.room_id
  WHERE auth.uid() IS NOT NULL
    AND i.token = p_token
    AND i.revoked_at IS NULL
    AND (i.expires_at IS NULL OR i.expires_at > now())
    AND (i.max_uses IS NULL OR i.uses_count < i.max_uses)
    AND public.room_can_join(i.room_id, auth.uid());
$$;


--
-- Name: get_room_member_control_states(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_room_member_control_states(p_room_id uuid) RETURNS TABLE(user_id uuid, role text, join_status text, guest_expires_at timestamp with time zone, restriction_types text[])
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  can_manage boolean;
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.room_has_active_access(p_room_id)
     OR NOT public.is_approved_room_member(p_room_id, auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized to view room member state.';
  END IF;

  can_manage := public.room_has_capability(p_room_id, auth.uid(), 'manage_members');

  RETURN QUERY
  WITH scoped_users AS (
    SELECT rm.user_id
    FROM public.room_members rm
    WHERE rm.room_id = p_room_id
      AND (can_manage OR rm.user_id = auth.uid())
    UNION
    SELECT r.user_id
    FROM public.room_member_restrictions r
    WHERE r.room_id = p_room_id AND can_manage
  )
  SELECT su.user_id,
         rm.role,
         rm.join_status,
         rm.guest_expires_at,
         COALESCE(array_agg(r.restriction_type ORDER BY r.restriction_type) FILTER (WHERE r.restriction_type IS NOT NULL), ARRAY[]::text[])
  FROM scoped_users su
  LEFT JOIN public.room_members rm
    ON rm.room_id = p_room_id AND rm.user_id = su.user_id
  LEFT JOIN public.room_member_restrictions r
    ON r.room_id = p_room_id AND r.user_id = su.user_id
   AND (r.expires_at IS NULL OR r.expires_at > now())
  GROUP BY su.user_id, rm.role, rm.join_status, rm.guest_expires_at
  ORDER BY su.user_id;
END;
$$;


--
-- Name: get_room_member_identities(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_room_member_identities(p_room_id uuid) RETURNS TABLE(user_id uuid, username text, account_display_name text, room_display_name text)
    LANGUAGE plpgsql SECURITY DEFINER
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


--
-- Name: get_room_member_presence_modes(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_room_member_presence_modes(p_room_id uuid) RETURNS TABLE(user_id uuid, is_ghost_mode boolean)
    LANGUAGE plpgsql SECURITY DEFINER
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


--
-- Name: get_room_member_profile(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_room_member_profile(p_room_id uuid, p_user_id uuid DEFAULT NULL::uuid) RETURNS TABLE(user_id uuid, display_name text, avatar_url text, bio text, updated_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  target_user_id uuid := COALESCE(p_user_id, auth.uid());
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.room_has_active_access(p_room_id)
     OR NOT public.is_approved_room_member(p_room_id, auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized to view room profiles.';
  END IF;

  IF target_user_id IS NULL
     OR NOT public.is_approved_room_member(p_room_id, target_user_id) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT p.user_id, p.display_name, p.avatar_url, p.bio, p.updated_at
  FROM public.room_member_profiles p
  WHERE p.room_id = p_room_id AND p.user_id = target_user_id;
END;
$$;


--
-- Name: get_room_poll_results(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_room_poll_results(p_room_id uuid) RETURNS TABLE(poll_id uuid, counts integer[], total integer, my_vote smallint)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.room_has_capability(p_room_id, auth.uid(), 'chat') THEN
    RAISE EXCEPTION 'Not authorized to view polls in this room.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT p.id,
    ARRAY(
      SELECT count(v.user_id)::integer
      FROM generate_series(0, cardinality(p.options) - 1) AS g(i)
      LEFT JOIN public.room_poll_votes v ON v.poll_id = p.id AND v.option_index = g.i
      GROUP BY g.i ORDER BY g.i
    ),
    (SELECT count(*)::integer FROM public.room_poll_votes v WHERE v.poll_id = p.id),
    (SELECT v.option_index FROM public.room_poll_votes v WHERE v.poll_id = p.id AND v.user_id = auth.uid())
  FROM public.room_polls p
  WHERE p.room_id = p_room_id;
END;
$$;


--
-- Name: get_room_pulse(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_room_pulse(p_room_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_chat boolean; v_study boolean;
BEGIN
  IF v_uid IS NULL OR NOT public.room_has_active_access(p_room_id)
     OR NOT public.is_approved_room_member(p_room_id, v_uid) THEN
    RAISE EXCEPTION 'Not authorized to view this room.' USING ERRCODE = '42501';
  END IF;
  v_chat := public.room_has_capability(p_room_id, v_uid, 'chat');
  v_study := public.room_has_capability(p_room_id, v_uid, 'study');
  RETURN jsonb_build_object(
    'members', (SELECT count(*) FROM public.room_members rm
                WHERE rm.room_id = p_room_id AND rm.join_status = 'approved' AND NOT rm.is_ghost_mode
                  AND (rm.guest_expires_at IS NULL OR rm.guest_expires_at > now())),
    'chat_15m', CASE WHEN v_chat THEN (SELECT count(*) FROM public.messages m
                WHERE m.room_id = p_room_id AND m.created_at > now() - interval '15 minutes'
                  AND NOT COALESCE(m.is_deleted, false)) END,
    'activity_1h', (SELECT count(*) FROM public.room_activity a
                    WHERE a.room_id = p_room_id AND a.created_at > now() - interval '1 hour'),
    'next_event', CASE WHEN v_chat THEN (SELECT jsonb_build_object('id', e.id, 'title', e.title, 'starts_at', e.starts_at)
                  FROM public.room_events e
                  WHERE e.room_id = p_room_id AND e.cancelled_at IS NULL
                    AND COALESCE(e.ends_at, e.starts_at + interval '1 hour') > now()
                  ORDER BY e.starts_at LIMIT 1) END,
    'open_tasks_mine', CASE WHEN v_study THEN (SELECT count(*) FROM public.room_tasks t
                  WHERE t.room_id = p_room_id AND t.assignee_id = v_uid AND t.status = 'open') END
  );
END;
$$;


--
-- Name: get_room_realtime_snapshots(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_room_realtime_snapshots(p_room_id uuid) RETURNS TABLE(snapshot_type text, state_version bigint, payload jsonb, updated_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
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


--
-- Name: get_room_trust_levels(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_room_trust_levels(p_room_id uuid) RETURNS TABLE(user_id uuid, level text, tenure_days integer, contributions integer)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_uid uuid := auth.uid();
  v_manager boolean;
BEGIN
  IF v_uid IS NULL OR NOT public.room_has_active_access(p_room_id)
     OR NOT public.is_approved_room_member(p_room_id, v_uid) THEN
    RAISE EXCEPTION 'Not authorized to view this room.' USING ERRCODE = '42501';
  END IF;
  v_manager := public.room_has_capability(p_room_id, v_uid, 'manage_members');
  RETURN QUERY
  SELECT m.user_id,
         CASE
           WHEN m.role IN ('owner', 'admin') THEN 'steward'
           WHEN m.role = 'guest' THEN 'new'
           WHEN m.days >= 7 AND m.contrib >= 25 THEN 'trusted'
           WHEN m.days < 1 OR m.contrib < 3 THEN 'new'
           ELSE 'member'
         END,
         m.days, m.contrib
  FROM (
    SELECT rm.user_id, rm.role,
           GREATEST(0, floor(extract(epoch FROM (now() - rm.joined_at)) / 86400))::integer AS days,
           ((SELECT count(*) FROM public.messages x
             WHERE x.room_id = rm.room_id AND x.sender_id = rm.user_id AND NOT COALESCE(x.is_deleted, false))
            + (SELECT count(*) FROM public.room_activity a
               WHERE a.room_id = rm.room_id AND a.actor_id = rm.user_id
                 AND a.kind IN ('file_shared', 'poll_created', 'event_scheduled', 'task_created', 'task_done', 'note_created', 'clip_saved', 'queue_added')))::integer AS contrib
    FROM public.room_members rm
    WHERE rm.room_id = p_room_id AND rm.join_status = 'approved'
      AND (rm.guest_expires_at IS NULL OR rm.guest_expires_at > now())
      AND NOT public.room_user_is_restricted(rm.room_id, rm.user_id)
      AND (v_manager OR rm.user_id = v_uid)
  ) m;
END;
$$;


--
-- Name: get_room_unread_counts(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_room_unread_counts(p_room_ids uuid[] DEFAULT NULL::uuid[]) RETURNS TABLE(room_id uuid, unread_count integer, last_read_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to see unread messages.' USING ERRCODE = '42501';
  END IF;
  IF p_room_ids IS NOT NULL AND cardinality(p_room_ids) > 200 THEN
    RAISE EXCEPTION 'Too many rooms requested.' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT rm.room_id,
         (SELECT count(*)::integer FROM (
            SELECT 1 FROM public.messages m
            WHERE m.room_id = rm.room_id
              AND m.created_at > COALESCE(rs.last_read_at, rm.joined_at)
              AND m.sender_id <> v_uid
              AND NOT COALESCE(m.is_deleted, false)
            LIMIT 100) capped),
         rs.last_read_at
  FROM public.room_members rm
  LEFT JOIN public.room_read_states rs ON rs.room_id = rm.room_id AND rs.user_id = v_uid
  WHERE rm.user_id = v_uid
    AND rm.join_status = 'approved'
    AND (p_room_ids IS NULL OR rm.room_id = ANY (p_room_ids))
    AND public.room_has_capability(rm.room_id, v_uid, 'chat');
END;
$$;


--
-- Name: room_whiteboards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_whiteboards (
    room_id uuid NOT NULL,
    state jsonb DEFAULT '{"dataUrl": null}'::jsonb NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    updated_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT room_whiteboards_state_check CHECK (((jsonb_typeof(state) = 'object'::text) AND (octet_length(convert_to((state)::text, 'UTF8'::name)) <= 524288))),
    CONSTRAINT room_whiteboards_version_check CHECK ((version > 0))
);


--
-- Name: get_room_whiteboard(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_room_whiteboard(p_room_id uuid) RETURNS public.room_whiteboards
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE board_row public.room_whiteboards%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.room_has_capability(p_room_id, auth.uid(), 'study') THEN
    RAISE EXCEPTION 'Not authorized to view this whiteboard.';
  END IF;
  SELECT * INTO board_row FROM public.room_whiteboards rw WHERE rw.room_id = p_room_id;
  RETURN board_row;
END;
$$;


--
-- Name: guard_room_message_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_room_message_update() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
  v_authorized text := COALESCE(current_setting('app.omnilume_message_authorized', true), '');
BEGIN
  IF NEW.reply_to_id IS DISTINCT FROM OLD.reply_to_id AND NEW.reply_to_id IS NOT NULL THEN
    RAISE EXCEPTION 'A reply target cannot change.' USING ERRCODE = '42501';
  END IF;

  IF COALESCE(OLD.is_deleted, false)
     AND (NOT COALESCE(NEW.is_deleted, false) OR NEW.content IS DISTINCT FROM OLD.content) THEN
    RAISE EXCEPTION 'Deleted messages cannot be changed.' USING ERRCODE = '42501';
  END IF;

  IF NEW.pinned_at IS DISTINCT FROM OLD.pinned_at
     OR (NEW.pinned_by IS DISTINCT FROM OLD.pinned_by AND NEW.pinned_by IS NOT NULL) THEN
    IF v_authorized <> 'pin' THEN
      RAISE EXCEPTION 'Pins change only through set_room_message_pin.' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.reaction_summary IS DISTINCT FROM OLD.reaction_summary AND v_authorized <> 'reactions' THEN
    RAISE EXCEPTION 'Reactions change only through toggle_room_message_reaction.' USING ERRCODE = '42501';
  END IF;

  NEW.edited_at := OLD.edited_at;
  IF NEW.room_id IS NOT NULL THEN
    IF COALESCE(NEW.is_deleted, false) AND NOT COALESCE(OLD.is_deleted, false) THEN
      NEW.pinned_at := NULL;
      NEW.pinned_by := NULL;
      NEW.reaction_summary := '{}'::jsonb;
    ELSIF NEW.content IS DISTINCT FROM OLD.content THEN
      NEW.edited_at := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: is_accepted_follower(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_accepted_follower(p_follower_id uuid, p_following_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.follows f
    WHERE f.follower_id = p_follower_id
      AND f.following_id = p_following_id
      AND f.status = 'accepted'
  );
$$;


--
-- Name: is_approved_room_member(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_approved_room_member(p_room_id uuid, p_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT public.room_user_role(p_room_id, p_user_id) IS NOT NULL;
$$;


--
-- Name: is_current_friend(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_current_friend(p_user_one uuid, p_user_two uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.friendships f
    WHERE f.user_one = LEAST(p_user_one, p_user_two)
      AND f.user_two = GREATEST(p_user_one, p_user_two)
  );
$$;


--
-- Name: is_group_manager(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_group_manager(p_group_id uuid, p_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT p_user_id IS NOT NULL AND p_user_id = auth.uid() AND EXISTS (
    SELECT 1 FROM public.group_members gm
    WHERE gm.group_id = p_group_id AND gm.user_id = p_user_id AND gm.role IN ('owner', 'admin')
  );
$$;


--
-- Name: is_group_member(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_group_member(p_group_id uuid, p_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT p_user_id IS NOT NULL AND p_user_id = auth.uid() AND EXISTS (
    SELECT 1 FROM public.group_members gm WHERE gm.group_id = p_group_id AND gm.user_id = p_user_id
  );
$$;


--
-- Name: is_room_admin_or_owner(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_room_admin_or_owner(p_room_id uuid, p_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.room_members rm
    WHERE rm.room_id = p_room_id
      AND rm.user_id = p_user_id
      AND rm.join_status = 'approved'
      AND rm.role IN ('owner', 'admin')
  );
$$;


--
-- Name: is_site_owner(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_site_owner(p_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT p_user_id IS NOT NULL
    AND p_user_id = auth.uid()
    AND EXISTS (SELECT 1 FROM public.site_owners so WHERE so.user_id = p_user_id);
$$;


--
-- Name: join_room_with_invite(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.join_room_with_invite(p_token text) RETURNS TABLE(room_id uuid, status text, role text, guest_expires_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  invite_row public.room_invites;
  room_row public.rooms;
  existing_membership public.room_members;
  expiry timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT i.*
  INTO invite_row
  FROM public.room_invites AS i
  WHERE i.token = p_token
  FOR UPDATE;

  IF NOT FOUND
     OR invite_row.revoked_at IS NOT NULL
     OR (invite_row.expires_at IS NOT NULL AND invite_row.expires_at <= now())
     OR (invite_row.max_uses IS NOT NULL AND invite_row.uses_count >= invite_row.max_uses) THEN
    RAISE EXCEPTION 'Invite is invalid or expired.';
  END IF;

  SELECT r.*
  INTO room_row
  FROM public.rooms AS r
  WHERE r.id = invite_row.room_id;

  IF NOT FOUND OR NOT public.room_can_join(room_row.id, auth.uid()) THEN
    RAISE EXCEPTION 'Room is unavailable.';
  END IF;

  SELECT rm.*
  INTO existing_membership
  FROM public.room_members AS rm
  WHERE rm.room_id = room_row.id
    AND rm.user_id = auth.uid();

  IF FOUND THEN
    RETURN QUERY
    SELECT room_row.id,
           existing_membership.join_status,
           existing_membership.role,
           existing_membership.guest_expires_at;
    RETURN;
  END IF;

  expiry := CASE
    WHEN invite_row.guest_lifetime_minutes IS NULL THEN NULL
    ELSE now() + make_interval(mins => invite_row.guest_lifetime_minutes)
  END;

  INSERT INTO public.room_members(room_id, user_id, role, join_status, guest_expires_at)
  VALUES (
    room_row.id,
    auth.uid(),
    CASE WHEN expiry IS NULL THEN 'member' ELSE 'guest' END,
    'approved',
    expiry
  );

  UPDATE public.room_invites
  SET uses_count = uses_count + 1
  WHERE id = invite_row.id;

  PERFORM public.record_room_control_event(
    room_row.id,
    CASE WHEN expiry IS NULL THEN 'membership_changed' ELSE 'guest_changed' END,
    auth.uid(),
    jsonb_build_object('via', 'invite')
  );

  RETURN QUERY
  SELECT room_row.id,
         'approved'::text,
         CASE WHEN expiry IS NULL THEN 'member'::text ELSE 'guest'::text END,
         expiry;
END;
$$;


--
-- Name: leave_group(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.leave_group(p_group_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_role text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501'; END IF;
  SELECT role INTO v_role FROM public.group_members WHERE group_id = p_group_id AND user_id = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_role = 'owner' THEN
    RAISE EXCEPTION 'The group owner cannot leave the group.' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.group_members WHERE group_id = p_group_id AND user_id = auth.uid();
  RETURN true;
END;
$$;


--
-- Name: leave_room(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.leave_room(p_room_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: list_event_rsvp_counts(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_event_rsvp_counts(p_room_id uuid) RETURNS TABLE(event_id uuid, going integer, maybe integer, declined integer, my_response text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT public.room_has_capability(p_room_id, v_uid, 'chat') THEN
    RAISE EXCEPTION 'Not authorized to view these events.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT e.id,
         (SELECT count(*)::integer FROM public.room_event_rsvps r WHERE r.event_id = e.id AND r.response = 'going'),
         (SELECT count(*)::integer FROM public.room_event_rsvps r WHERE r.event_id = e.id AND r.response = 'maybe'),
         (SELECT count(*)::integer FROM public.room_event_rsvps r WHERE r.event_id = e.id AND r.response = 'declined'),
         (SELECT r.response FROM public.room_event_rsvps r WHERE r.event_id = e.id AND r.user_id = v_uid)
  FROM public.room_events e
  WHERE e.room_id = p_room_id;
END;
$$;


--
-- Name: list_friends_listening(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_friends_listening() RETURNS TABLE(user_id uuid, display_name text, username text, avatar_url text, title text, artist text, updated_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT np.user_id, p.display_name, p.username, p.avatar_url, np.title, np.artist, np.updated_at
  FROM public.music_now_playing np
  JOIN public.friendships f ON f.user_one = LEAST(uid, np.user_id) AND f.user_two = GREATEST(uid, np.user_id)
  LEFT JOIN public.profiles p ON p.id = np.user_id
  WHERE np.user_id <> uid
    AND np.updated_at > now() - interval '5 minutes'
    AND NOT EXISTS (SELECT 1 FROM public.music_settings s WHERE s.user_id = np.user_id AND s.presence = 'nobody')
    AND NOT EXISTS (
      SELECT 1 FROM public.user_blocks b
      WHERE (b.blocker_id = uid AND b.blocked_id = np.user_id) OR (b.blocker_id = np.user_id AND b.blocked_id = uid)
    )
  ORDER BY np.updated_at DESC
  LIMIT 200;
END;
$$;


--
-- Name: list_music_listen_tracks(text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_music_listen_tracks(p_kind text, p_target uuid) RETURNS TABLE(upload_id uuid, owner_name text, title text, artist text, album text, duration_ms integer, hue smallint, has_cover boolean, lyrics text, expires_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF NOT public.music_listen_can_join(p_kind, p_target) THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT u.id, COALESCE((SELECT p.display_name FROM public.profiles p WHERE p.id = u.owner_id), 'A member'),
    u.title, u.artist, u.album, u.duration_ms, u.hue, u.cover_path IS NOT NULL, u.lyrics, u.expires_at
  FROM public.music_upload_shares s
  JOIN public.music_uploads u ON u.id = s.upload_id
  WHERE s.target_kind = p_kind AND s.target_id = p_target AND u.state = 'active' AND u.expires_at > now()
  ORDER BY s.created_at DESC
  LIMIT 200;
END;
$$;


--
-- Name: list_music_orphan_objects(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_music_orphan_objects(p_limit integer DEFAULT 200) RETURNS TABLE(name text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT o.name
  FROM storage.objects o
  WHERE o.bucket_id = 'music_uploads'
    AND o.created_at < now() - interval '1 hour'
    AND NOT EXISTS (
      SELECT 1 FROM public.music_uploads u WHERE u.object_path = o.name OR u.cover_path = o.name
    )
  ORDER BY o.created_at
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
$$;


--
-- Name: list_music_share_targets(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_music_share_targets() RETURNS TABLE(target_kind text, target_id uuid, name text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT 'room'::text, r.id, r.name
  FROM public.room_members rm
  JOIN public.rooms r ON r.id = rm.room_id
  WHERE rm.user_id = uid
    AND NOT EXISTS (SELECT 1 FROM public.groups g WHERE g.source_room_id = r.id)
    AND public.room_has_capability(r.id, uid, 'watch')
  UNION ALL
  SELECT 'group'::text, g.id, g.name
  FROM public.group_members gm
  JOIN public.groups g ON g.id = gm.group_id
  WHERE gm.user_id = uid
  ORDER BY 3
  LIMIT 200;
END;
$$;


--
-- Name: list_music_shared_with_me(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_music_shared_with_me() RETURNS TABLE(share_id uuid, upload_id uuid, target_kind text, target_id uuid, target_name text, owner_name text, title text, artist text, album text, duration_ms integer, hue smallint, has_cover boolean, lyrics text, expires_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT s.id, u.id, s.target_kind, s.target_id,
    CASE s.target_kind
      WHEN 'room' THEN (SELECT r.name FROM public.rooms r WHERE r.id = s.target_id)
      ELSE (SELECT g.name FROM public.groups g WHERE g.id = s.target_id) END,
    COALESCE((SELECT p.display_name FROM public.profiles p WHERE p.id = u.owner_id), 'A member'),
    u.title, u.artist, u.album, u.duration_ms, u.hue, u.cover_path IS NOT NULL, u.lyrics, u.expires_at
  FROM public.music_upload_shares s
  JOIN public.music_uploads u ON u.id = s.upload_id
  WHERE u.owner_id <> uid AND u.state = 'active' AND u.expires_at > now()
    AND (
      (s.target_kind = 'room' AND public.room_has_capability(s.target_id, uid, 'watch'))
      OR (s.target_kind = 'group' AND public.is_group_member(s.target_id, uid))
    )
  ORDER BY s.created_at DESC
  LIMIT 200;
END;
$$;


--
-- Name: list_music_shares(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_music_shares(p_upload_id uuid) RETURNS TABLE(share_id uuid, target_kind text, target_id uuid, target_name text, created_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT s.id, s.target_kind, s.target_id,
    COALESCE(CASE s.target_kind
      WHEN 'room' THEN (SELECT r.name FROM public.rooms r WHERE r.id = s.target_id)
      ELSE (SELECT g.name FROM public.groups g WHERE g.id = s.target_id) END, 'Unavailable'),
    s.created_at
  FROM public.music_upload_shares s
  WHERE s.upload_id = p_upload_id AND s.owner_id = auth.uid()
  ORDER BY s.created_at;
END;
$$;


--
-- Name: list_music_uploads_due_for_cleanup(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_music_uploads_due_for_cleanup(p_limit integer DEFAULT 200) RETURNS TABLE(id uuid, object_path text, cover_path text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT u.id, u.object_path, u.cover_path
  FROM public.music_uploads u
  WHERE u.state = 'delete_pending' OR (u.state = 'active' AND u.expires_at <= now())
  ORDER BY u.expires_at
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
$$;


--
-- Name: list_my_bookmarks(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_my_bookmarks(p_limit integer DEFAULT 50) RETURNS TABLE(id uuid, kind text, room_id uuid, room_name text, entity_id uuid, label text, note text, created_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to see saved items.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT b.id, b.kind, b.room_id, r.name, b.entity_id, l.label, b.note, b.created_at
  FROM public.room_bookmarks b
  JOIN public.rooms r ON r.id = b.room_id
  CROSS JOIN LATERAL (
    SELECT CASE b.kind
      WHEN 'room' THEN r.name
      WHEN 'message' THEN (SELECT left(m.content, 120) FROM public.messages m
        WHERE m.id = b.entity_id AND m.room_id = b.room_id AND NOT COALESCE(m.is_deleted, false)
          AND public.room_has_capability(b.room_id, v_uid, 'chat'))
      ELSE (SELECT f.original_name FROM public.room_files f
        WHERE f.id = b.entity_id AND f.room_id = b.room_id AND f.retention_state = 'active'
          AND public.room_has_capability(b.room_id, v_uid, 'files'))
    END AS label
  ) l
  WHERE b.user_id = v_uid
    AND l.label IS NOT NULL
    AND public.room_has_active_access(b.room_id)
    AND NOT public.room_user_is_restricted(b.room_id, v_uid)
    AND (public.is_approved_room_member(b.room_id, v_uid)
         OR (b.kind = 'room' AND NOT r.is_private AND NOT r.is_group))
  ORDER BY b.created_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
END;
$$;


--
-- Name: list_my_music_history(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_my_music_history(p_limit integer DEFAULT 100) RETURNS TABLE(id bigint, upload_id uuid, played_at timestamp with time zone, title text, artist text, album text, duration_ms integer, hue smallint, has_cover boolean, owned boolean, playable boolean)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT h.id, u.id, h.played_at, u.title, u.artist, u.album, u.duration_ms, u.hue,
    u.cover_path IS NOT NULL AND u.state = 'active', u.owner_id = uid, public.music_can_play(u.id, uid)
  FROM public.music_listening_history h
  JOIN public.music_uploads u ON u.id = h.upload_id
  WHERE h.user_id = uid
  ORDER BY h.played_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
END;
$$;


--
-- Name: list_my_open_tasks(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_my_open_tasks(p_limit integer DEFAULT 10) RETURNS TABLE(task_id uuid, room_id uuid, room_name text, title text, due_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to see your tasks.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT t.id, t.room_id, r.name, t.title, t.due_at
  FROM public.room_tasks t
  JOIN public.rooms r ON r.id = t.room_id
  WHERE t.assignee_id = v_uid AND t.status = 'open'
    AND public.room_has_capability(t.room_id, v_uid, 'study')
  ORDER BY t.due_at NULLS LAST, t.created_at
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
END;
$$;


--
-- Name: list_my_room_overview(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_my_room_overview() RETURNS TABLE(room_id uuid, name text, role text, expiration_type text, expires_at timestamp with time zone, is_group boolean, member_count integer, unread_count integer, last_activity_at timestamp with time zone, next_event_at timestamp with time zone, open_tasks integer, bookmarked boolean)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to see your rooms.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT r.id, r.name, rm.role, r.expiration_type, r.expires_at, r.is_group,
         (SELECT count(*)::integer FROM public.room_members x
          WHERE x.room_id = r.id AND x.join_status = 'approved' AND NOT x.is_ghost_mode
            AND (x.guest_expires_at IS NULL OR x.guest_expires_at > now())),
         CASE WHEN public.room_has_capability(r.id, v_uid, 'chat') THEN
           (SELECT count(*)::integer FROM (
              SELECT 1 FROM public.messages m
              WHERE m.room_id = r.id AND m.created_at > COALESCE(rs.last_read_at, rm.joined_at)
                AND m.sender_id <> v_uid AND NOT COALESCE(m.is_deleted, false)
              LIMIT 100) capped)
         ELSE 0 END,
         (SELECT max(a.created_at) FROM public.room_activity a WHERE a.room_id = r.id),
         CASE WHEN public.room_has_capability(r.id, v_uid, 'chat') THEN
           (SELECT min(e.starts_at) FROM public.room_events e
            WHERE e.room_id = r.id AND e.cancelled_at IS NULL AND COALESCE(e.ends_at, e.starts_at + interval '1 hour') > now())
         END,
         CASE WHEN public.room_has_capability(r.id, v_uid, 'study') THEN
           (SELECT count(*)::integer FROM public.room_tasks t
            WHERE t.room_id = r.id AND t.assignee_id = v_uid AND t.status = 'open')
         ELSE 0 END,
         EXISTS (SELECT 1 FROM public.room_bookmarks b WHERE b.user_id = v_uid AND b.kind = 'room' AND b.entity_id = r.id)
  FROM public.room_members rm
  JOIN public.rooms r ON r.id = rm.room_id
  LEFT JOIN public.room_read_states rs ON rs.room_id = r.id AND rs.user_id = v_uid
  WHERE rm.user_id = v_uid AND rm.join_status = 'approved'
    AND public.room_has_active_access(r.id)
    AND public.room_user_role(r.id, v_uid) IS NOT NULL
  ORDER BY r.created_at DESC
  LIMIT 200;
END;
$$;


--
-- Name: list_my_upcoming_events(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_my_upcoming_events(p_limit integer DEFAULT 10) RETURNS TABLE(event_id uuid, room_id uuid, room_name text, title text, starts_at timestamp with time zone, my_response text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to see your events.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT e.id, e.room_id, r.name, e.title, e.starts_at,
         (SELECT s.response FROM public.room_event_rsvps s WHERE s.event_id = e.id AND s.user_id = v_uid)
  FROM public.room_events e
  JOIN public.rooms r ON r.id = e.room_id
  WHERE e.cancelled_at IS NULL
    AND COALESCE(e.ends_at, e.starts_at + interval '1 hour') > now()
    AND e.starts_at < now() + interval '30 days'
    AND public.room_has_capability(e.room_id, v_uid, 'chat')
  ORDER BY e.starts_at
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
END;
$$;


--
-- Name: list_pdf_annotations(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_pdf_annotations(p_file_id uuid) RETURNS SETOF public.pdf_annotations
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE file_row public.room_files%ROWTYPE;
BEGIN
  SELECT * INTO file_row FROM public.room_files rf WHERE rf.id = p_file_id AND rf.deleted_at IS NULL;
  IF NOT FOUND OR auth.uid() IS NULL
     OR NOT public.room_has_capability(file_row.room_id, auth.uid(), 'study')
     OR NOT public.room_has_capability(file_row.room_id, auth.uid(), 'files') THEN
    RAISE EXCEPTION 'Not authorized to view PDF annotations.';
  END IF;
  RETURN QUERY SELECT pa.* FROM public.pdf_annotations pa WHERE pa.file_id = p_file_id ORDER BY pa.page_number, pa.created_at;
END;
$$;


--
-- Name: list_recovery_review_queue(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_recovery_review_queue() RETURNS TABLE(request_id uuid, room_id uuid, room_name text, room_expired_at timestamp with time zone, window_ends_at timestamp with time zone, requester_id uuid, requester_label text, requested_at timestamp with time zone, other_pending integer)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF NOT public.is_site_owner(auth.uid()) THEN
    RAISE EXCEPTION 'Only a site owner can review recovery requests.' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    rr.id,
    r.id,
    r.name,
    r.expires_at,
    r.expires_at + interval '7 days',
    rr.requester_id,
    public.notification_user_label(rr.requester_id),
    rr.created_at,
    (SELECT count(*)::integer
     FROM public.recovery_requests other
     WHERE other.room_id = rr.room_id
       AND other.status = 'pending'
       AND other.created_at > now() - interval '7 days'
       AND other.id <> rr.id)
  FROM public.recovery_requests rr
  JOIN public.rooms r ON r.id = rr.room_id
  WHERE rr.status = 'pending'
    AND rr.created_at > now() - interval '7 days'
  ORDER BY rr.created_at ASC;
END;
$$;


--
-- Name: list_room_activity(uuid, integer, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_room_activity(p_room_id uuid, p_limit integer DEFAULT 40, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS TABLE(id bigint, kind text, actor_id uuid, actor_name text, entity_id uuid, detail text, label text, created_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
#variable_conflict use_column
DECLARE
  v_uid uuid := auth.uid();
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 40), 1), 100);
  v_chat boolean; v_files boolean; v_study boolean; v_watch boolean; v_ann boolean;
BEGIN
  IF v_uid IS NULL OR NOT public.room_has_active_access(p_room_id)
     OR NOT public.is_approved_room_member(p_room_id, v_uid) THEN
    RAISE EXCEPTION 'Not authorized to view this room''s activity.' USING ERRCODE = '42501';
  END IF;
  v_chat := public.room_has_capability(p_room_id, v_uid, 'chat');
  v_files := public.room_has_capability(p_room_id, v_uid, 'files');
  v_study := public.room_has_capability(p_room_id, v_uid, 'study');
  v_watch := public.room_has_capability(p_room_id, v_uid, 'watch');
  v_ann := public.room_feature_enabled(p_room_id, 'announcements');

  RETURN QUERY
  SELECT a.id, a.kind, a.actor_id,
         COALESCE(NULLIF(btrim(mp.display_name), ''), NULLIF(btrim(pr.display_name), ''), 'A member'),
         a.entity_id, a.detail,
         CASE a.kind
           WHEN 'announcement' THEN (SELECT left(x.body, 120) FROM public.room_announcements x WHERE v_ann AND x.id = a.entity_id AND x.room_id = a.room_id)
           WHEN 'file_shared' THEN (SELECT f.original_name FROM public.room_files f WHERE v_files AND f.id = a.entity_id AND f.room_id = a.room_id AND f.retention_state = 'active')
           WHEN 'poll_created' THEN (SELECT x.question FROM public.room_polls x WHERE v_chat AND x.id = a.entity_id AND x.room_id = a.room_id)
           WHEN 'event_scheduled' THEN (SELECT x.title FROM public.room_events x WHERE v_chat AND x.id = a.entity_id AND x.room_id = a.room_id)
           WHEN 'task_created' THEN (SELECT x.title FROM public.room_tasks x WHERE v_study AND x.id = a.entity_id AND x.room_id = a.room_id)
           WHEN 'task_done' THEN (SELECT x.title FROM public.room_tasks x WHERE v_study AND x.id = a.entity_id AND x.room_id = a.room_id)
           WHEN 'note_created' THEN (SELECT x.title FROM public.study_notes x WHERE v_study AND x.id = a.entity_id AND x.room_id = a.room_id AND x.scope = 'room')
           WHEN 'queue_added' THEN (SELECT tm.file_name FROM public.room_media_queue q JOIN public.temporary_media tm ON tm.id = q.media_id WHERE v_watch AND q.id = a.entity_id AND q.room_id = a.room_id)
           WHEN 'clip_saved' THEN (SELECT x.label FROM public.room_media_clips x WHERE v_watch AND x.id = a.entity_id AND x.room_id = a.room_id)
           WHEN 'group_converted' THEN (SELECT r.name FROM public.rooms r WHERE r.id = a.room_id)
           ELSE NULL
         END,
         a.created_at
  FROM public.room_activity a
  LEFT JOIN public.profiles pr ON pr.id = a.actor_id
  LEFT JOIN public.room_member_profiles mp ON mp.room_id = a.room_id AND mp.user_id = a.actor_id
  WHERE a.room_id = p_room_id AND (p_before IS NULL OR a.created_at < p_before)
  ORDER BY a.created_at DESC, a.id DESC
  LIMIT v_limit;
END;
$$;


--
-- Name: room_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_files (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    room_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    storage_provider text DEFAULT 'supabase'::text NOT NULL,
    storage_bucket text DEFAULT 'room_attachments'::text NOT NULL,
    object_path text NOT NULL,
    original_name text NOT NULL,
    normalized_name text NOT NULL,
    mime_type text NOT NULL,
    size_bytes bigint NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    retention_state text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    delete_requested_at timestamp with time zone,
    deleted_at timestamp with time zone,
    last_cleanup_error text,
    cleanup_attempts integer DEFAULT 0 NOT NULL,
    CONSTRAINT room_files_cleanup_attempts_check CHECK ((cleanup_attempts >= 0)),
    CONSTRAINT room_files_metadata_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT room_files_mime_type_flac_check CHECK ((mime_type = ANY (ARRAY['application/pdf'::text, 'application/x-subrip'::text, 'text/plain'::text, 'text/markdown'::text, 'text/vtt'::text, 'image/gif'::text, 'image/jpeg'::text, 'image/png'::text, 'image/webp'::text, 'audio/mpeg'::text, 'audio/flac'::text, 'audio/ogg'::text, 'audio/wav'::text, 'audio/webm'::text, 'video/mp4'::text, 'video/ogg'::text, 'video/webm'::text]))),
    CONSTRAINT room_files_normalized_name_check CHECK (((char_length(normalized_name) >= 1) AND (char_length(normalized_name) <= 180))),
    CONSTRAINT room_files_object_path_check CHECK (((char_length(object_path) >= 1) AND (char_length(object_path) <= 512))),
    CONSTRAINT room_files_original_name_check CHECK (((char_length(original_name) >= 1) AND (char_length(original_name) <= 180))),
    CONSTRAINT room_files_retention_state_check CHECK ((retention_state = ANY (ARRAY['active'::text, 'delete_pending'::text, 'deleted'::text]))),
    CONSTRAINT room_files_size_bytes_check CHECK (((size_bytes > 0) AND (size_bytes <= 52428800))),
    CONSTRAINT room_files_storage_bucket_check CHECK ((storage_bucket = 'room_attachments'::text)),
    CONSTRAINT room_files_storage_provider_check CHECK ((storage_provider = 'supabase'::text))
);


--
-- Name: list_room_files(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_room_files(p_room_id uuid) RETURNS SETOF public.room_files
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.room_has_capability(p_room_id, auth.uid(), 'files') THEN
    RAISE EXCEPTION 'Not authorized to view room files.';
  END IF;

  RETURN QUERY
  SELECT rf.*
  FROM public.room_files rf
  WHERE rf.room_id = p_room_id AND rf.deleted_at IS NULL
  ORDER BY rf.created_at DESC;
END;
$$;


--
-- Name: list_room_invite_history(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_room_invite_history(p_room_id uuid) RETURNS TABLE(id uuid, expires_at timestamp with time zone, max_uses integer, uses_count integer, guest_lifetime_minutes integer, revoked_at timestamp with time zone, created_at timestamp with time zone, status text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.room_has_capability(p_room_id, auth.uid(), 'manage_invites') THEN
    RAISE EXCEPTION 'Not authorized to view room invite history.';
  END IF;

  RETURN QUERY
  SELECT i.id,
         i.expires_at,
         i.max_uses,
         i.uses_count,
         i.guest_lifetime_minutes,
         i.revoked_at,
         i.created_at,
         CASE
           WHEN i.revoked_at IS NOT NULL THEN 'revoked'
           WHEN i.expires_at IS NOT NULL AND i.expires_at <= now() THEN 'expired'
           WHEN i.max_uses IS NOT NULL AND i.uses_count >= i.max_uses THEN 'exhausted'
           ELSE 'active'
         END
  FROM public.room_invites i
  WHERE i.room_id = p_room_id
  ORDER BY i.created_at DESC;
END;
$$;


--
-- Name: list_rooms_due_for_destruction(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_rooms_due_for_destruction(p_limit integer DEFAULT 100) RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
$$;


--
-- Name: list_study_note_versions(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_study_note_versions(p_note_id uuid) RETURNS TABLE(version bigint, title text, content text, edited_by uuid, saved_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE note_row public.study_notes%ROWTYPE;
BEGIN
  SELECT * INTO note_row FROM public.study_notes sn WHERE sn.id = p_note_id;
  IF NOT FOUND OR auth.uid() IS NULL
     OR NOT public.room_has_capability(note_row.room_id, auth.uid(), 'study')
     OR (note_row.scope = 'personal' AND note_row.owner_id <> auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized to view this note history.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT v.version, v.title, v.content, v.edited_by, v.saved_at
  FROM public.study_note_versions v WHERE v.note_id = p_note_id
  ORDER BY v.version DESC;
END;
$$;


--
-- Name: list_study_notes(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_study_notes(p_room_id uuid) RETURNS SETOF public.study_notes
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.room_has_capability(p_room_id, auth.uid(), 'study') THEN
    RAISE EXCEPTION 'Not authorized to view study notes.';
  END IF;

  RETURN QUERY
  SELECT sn.* FROM public.study_notes sn
  WHERE sn.room_id = p_room_id AND (sn.scope = 'room' OR sn.owner_id = auth.uid())
  ORDER BY sn.updated_at DESC;
END;
$$;


--
-- Name: log_room_activity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.log_room_activity() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_room uuid;
  v_kind text;
  v_actor uuid;
  v_entity uuid;
  v_detail text;
  v_key text;
BEGIN
  IF TG_TABLE_NAME = 'room_members' THEN
    IF TG_OP = 'DELETE' THEN
      IF OLD.join_status <> 'approved' OR OLD.is_ghost_mode
         OR NOT EXISTS (SELECT 1 FROM public.rooms r WHERE r.id = OLD.room_id) THEN
        RETURN NULL;
      END IF;
      v_room := OLD.room_id; v_kind := 'member_left'; v_actor := OLD.user_id; v_entity := OLD.user_id;
      v_key := 'member_left:' || OLD.user_id::text || ':' || floor(extract(epoch FROM clock_timestamp()))::bigint::text;
    ELSIF TG_OP = 'INSERT' THEN
      IF NEW.join_status <> 'approved' OR NEW.is_ghost_mode OR NEW.role = 'owner' THEN RETURN NULL; END IF;
      v_room := NEW.room_id; v_kind := 'member_joined'; v_actor := NEW.user_id; v_entity := NEW.user_id; v_detail := NEW.role;
      v_key := 'member_joined:' || NEW.user_id::text || ':' || floor(extract(epoch FROM NEW.joined_at))::bigint::text;
    ELSE
      IF NEW.is_ghost_mode THEN RETURN NULL; END IF;
      IF OLD.join_status <> 'approved' AND NEW.join_status = 'approved' THEN
        v_room := NEW.room_id; v_kind := 'member_joined'; v_actor := NEW.user_id; v_entity := NEW.user_id; v_detail := NEW.role;
        v_key := 'member_joined:' || NEW.user_id::text || ':' || floor(extract(epoch FROM clock_timestamp()))::bigint::text;
      ELSIF NEW.join_status = 'approved' AND OLD.role IS DISTINCT FROM NEW.role THEN
        v_room := NEW.room_id; v_kind := 'role_changed'; v_actor := auth.uid(); v_entity := NEW.user_id; v_detail := NEW.role;
        v_key := 'role_changed:' || NEW.user_id::text || ':' || NEW.role || ':' || floor(extract(epoch FROM clock_timestamp()))::bigint::text;
      ELSE
        RETURN NULL;
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'room_announcements' THEN
    v_room := NEW.room_id; v_kind := 'announcement'; v_actor := NEW.author_id; v_entity := NEW.id;
    v_key := 'announcement:' || NEW.id::text;
  ELSIF TG_TABLE_NAME = 'room_files' THEN
    IF NEW.retention_state <> 'active' THEN RETURN NULL; END IF;
    v_room := NEW.room_id; v_kind := 'file_shared'; v_actor := NEW.owner_id; v_entity := NEW.id;
    v_key := 'file_shared:' || NEW.id::text;
  ELSIF TG_TABLE_NAME = 'room_polls' THEN
    v_room := NEW.room_id; v_kind := 'poll_created'; v_actor := NEW.created_by; v_entity := NEW.id;
    v_key := 'poll_created:' || NEW.id::text;
  ELSIF TG_TABLE_NAME = 'room_events' THEN
    v_room := NEW.room_id; v_kind := 'event_scheduled'; v_actor := NEW.created_by; v_entity := NEW.id;
    v_key := 'event_scheduled:' || NEW.id::text;
  ELSIF TG_TABLE_NAME = 'room_tasks' THEN
    IF TG_OP = 'INSERT' THEN
      v_room := NEW.room_id; v_kind := 'task_created'; v_actor := NEW.created_by; v_entity := NEW.id;
      v_key := 'task_created:' || NEW.id::text;
    ELSIF NEW.status = 'done' AND OLD.status <> 'done' THEN
      v_room := NEW.room_id; v_kind := 'task_done'; v_actor := NEW.completed_by; v_entity := NEW.id;
      v_key := 'task_done:' || NEW.id::text || ':' || floor(extract(epoch FROM COALESCE(NEW.completed_at, now())))::bigint::text;
    ELSE
      RETURN NULL;
    END IF;
  ELSIF TG_TABLE_NAME = 'study_notes' THEN
    IF NEW.scope <> 'room' THEN RETURN NULL; END IF;
    v_room := NEW.room_id; v_kind := 'note_created'; v_actor := NEW.owner_id; v_entity := NEW.id;
    v_key := 'note_created:' || NEW.id::text;
  ELSIF TG_TABLE_NAME = 'room_media_queue' THEN
    v_room := NEW.room_id; v_kind := 'queue_added'; v_actor := NEW.added_by; v_entity := NEW.id;
    v_key := 'queue_added:' || NEW.id::text;
  ELSIF TG_TABLE_NAME = 'room_media_clips' THEN
    v_room := NEW.room_id; v_kind := 'clip_saved'; v_actor := NEW.created_by; v_entity := NEW.id;
    v_key := 'clip_saved:' || NEW.id::text;
  ELSE
    RETURN NULL;
  END IF;

  IF v_actor IS NOT NULL AND TG_TABLE_NAME <> 'room_members' AND EXISTS (
    SELECT 1 FROM public.room_members rm
    WHERE rm.room_id = v_room AND rm.user_id = v_actor AND rm.is_ghost_mode
  ) THEN
    v_actor := NULL;
  END IF;

  BEGIN
    INSERT INTO public.room_activity (room_id, kind, actor_id, entity_id, detail, dedupe_key)
    VALUES (v_room, v_kind, v_actor, v_entity, v_detail, v_key)
    ON CONFLICT (room_id, dedupe_key) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'room activity skipped (%)', SQLSTATE;
  END;
  RETURN NULL;
END;
$$;


--
-- Name: lower_room_hand(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lower_room_hand(p_room_id uuid, p_user_id uuid DEFAULT NULL::uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_target uuid := COALESCE(p_user_id, auth.uid());
BEGIN
  IF auth.uid() IS NULL OR NOT public.room_has_capability(p_room_id, auth.uid(), 'chat')
     OR (v_target <> auth.uid() AND NOT public.room_has_capability(p_room_id, auth.uid(), 'manage_members')) THEN
    RAISE EXCEPTION 'Not authorized to lower this hand.' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.room_hand_raises h WHERE h.room_id = p_room_id AND h.user_id = v_target;
END;
$$;


--
-- Name: mark_conversation_read(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_conversation_read(p_conversation_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501'; END IF;
  IF public.private_chat_type(p_conversation_id) IS NOT NULL THEN
    INSERT INTO public.conversation_reads (user_id, chat_id) VALUES (auth.uid(), p_conversation_id)
    ON CONFLICT (user_id, chat_id) WHERE chat_id IS NOT NULL DO UPDATE SET last_read_at = now();
  ELSIF public.is_group_member(p_conversation_id, auth.uid()) THEN
    INSERT INTO public.conversation_reads (user_id, group_id) VALUES (auth.uid(), p_conversation_id)
    ON CONFLICT (user_id, group_id) WHERE group_id IS NOT NULL DO UPDATE SET last_read_at = now();
  ELSE
    RAISE EXCEPTION 'Conversation is not available.' USING ERRCODE = '42501';
  END IF;
  RETURN true;
END;
$$;


--
-- Name: mark_room_notifications_read(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_room_notifications_read(p_ids uuid[] DEFAULT NULL::uuid[]) RETURNS integer
    LANGUAGE sql
    SET search_path TO ''
    AS $$
  WITH updated AS (
    UPDATE public.room_notifications n
    SET read_at = now()
    WHERE n.recipient_id = auth.uid()
      AND n.read_at IS NULL
      AND (p_ids IS NULL OR n.id = ANY (p_ids))
    RETURNING 1
  )
  SELECT count(*)::integer FROM updated;
$$;


--
-- Name: mark_room_read(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_room_read(p_room_id uuid) RETURNS timestamp with time zone
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_read_at timestamptz;
BEGIN
  IF v_uid IS NULL OR NOT public.room_has_capability(p_room_id, v_uid, 'chat') THEN
    RAISE EXCEPTION 'You cannot read this room''s chat.' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.room_read_states AS state (room_id, user_id, last_read_at)
  VALUES (p_room_id, v_uid, now())
  ON CONFLICT (room_id, user_id) DO UPDATE
  SET last_read_at = GREATEST(state.last_read_at, EXCLUDED.last_read_at)
  RETURNING state.last_read_at INTO v_read_at;
  RETURN v_read_at;
END;
$$;


--
-- Name: move_media_in_queue(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.move_media_in_queue(p_item_id uuid, p_to_index integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_item public.room_media_queue%ROWTYPE;
  v_count integer;
  v_target integer;
BEGIN
  SELECT * INTO v_item FROM public.room_media_queue q WHERE q.id = p_item_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_uid IS NULL OR NOT public.room_has_capability(v_item.room_id, v_uid, 'watch_control') THEN
    RAISE EXCEPTION 'Only members who control Watch can reorder the queue.' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('room-media-queue:' || v_item.room_id::text, 0));
  SELECT count(*) INTO v_count FROM public.room_media_queue q WHERE q.room_id = v_item.room_id;
  v_target := GREATEST(0, LEAST(v_count - 1, COALESCE(p_to_index, 0)));
  WITH ordered AS (
    SELECT q.id, row_number() OVER (ORDER BY q.position, q.created_at) - 1 AS idx
    FROM public.room_media_queue q WHERE q.room_id = v_item.room_id AND q.id <> p_item_id
  ), placed AS (
    SELECT ordered.id, (CASE WHEN ordered.idx >= v_target THEN ordered.idx + 1 ELSE ordered.idx END)::integer AS new_position FROM ordered
    UNION ALL
    SELECT p_item_id, v_target
  )
  UPDATE public.room_media_queue q SET position = placed.new_position
  FROM placed WHERE q.id = placed.id;
  RETURN true;
END;
$$;


--
-- Name: music_can_play(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.music_can_play(p_upload_id uuid, p_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT p_user_id IS NOT NULL AND p_user_id = auth.uid() AND EXISTS (
    SELECT 1 FROM public.music_uploads u
    WHERE u.id = p_upload_id AND u.state = 'active' AND u.expires_at > now()
      AND (
        u.owner_id = p_user_id
        OR EXISTS (
          SELECT 1 FROM public.music_upload_shares s
          WHERE s.upload_id = u.id
            AND (
              (s.target_kind = 'room' AND public.room_has_capability(s.target_id, p_user_id, 'watch'))
              OR (s.target_kind = 'group' AND public.is_group_member(s.target_id, p_user_id))
            )
        )
      )
  );
$$;


--
-- Name: music_custom_sources_limit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.music_custom_sources_limit() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  IF (SELECT count(*) FROM public.music_custom_sources s WHERE s.owner_id = NEW.owner_id) >= 10 THEN
    RAISE EXCEPTION 'You can add up to 10 sources.' USING ERRCODE = '54000';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: music_listen_can_join(text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.music_listen_can_join(p_kind text, p_target uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT COALESCE(auth.uid() IS NOT NULL AND p_target IS NOT NULL AND CASE p_kind
    WHEN 'room' THEN public.room_has_capability(p_target, auth.uid(), 'watch')
      AND NOT EXISTS (SELECT 1 FROM public.groups g WHERE g.source_room_id = p_target)
    WHEN 'group' THEN public.is_group_member(p_target, auth.uid())
    ELSE false END, false);
$$;


--
-- Name: music_listen_control(text, uuid, text, uuid, integer, integer, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.music_listen_control(p_kind text, p_target uuid, p_action text, p_upload_id uuid DEFAULT NULL::uuid, p_position_ms integer DEFAULT NULL::integer, p_index integer DEFAULT NULL::integer, p_flag boolean DEFAULT NULL::boolean) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  uid uuid := auth.uid();
  s public.music_listen_sessions%ROWTYPE;
  host_gone boolean;
  pos integer;
  shared_ok boolean;
  out_json jsonb;
BEGIN
  IF uid IS NULL OR NOT public.music_listen_can_join(p_kind, p_target) THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('start', 'play', 'pause', 'seek', 'load', 'enqueue', 'remove', 'next', 'host_only', 'end') THEN
    RAISE EXCEPTION 'Invalid action.' USING ERRCODE = '22023';
  END IF;
  IF p_position_ms IS NOT NULL AND (p_position_ms < 0 OR p_position_ms > 86400000) THEN
    RAISE EXCEPTION 'Invalid position.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.music_listen_sessions (target_kind, target_id, host_id, ended_at)
  VALUES (p_kind, p_target, uid, now())
  ON CONFLICT (target_kind, target_id) DO NOTHING;
  SELECT * INTO s FROM public.music_listen_sessions x WHERE x.target_kind = p_kind AND x.target_id = p_target FOR UPDATE;

  host_gone := s.host_id IS NULL OR NOT CASE s.target_kind
    WHEN 'room' THEN EXISTS (
      SELECT 1 FROM public.room_members rm
      WHERE rm.room_id = s.target_id AND rm.user_id = s.host_id AND rm.join_status = 'approved')
    ELSE EXISTS (SELECT 1 FROM public.group_members gm WHERE gm.group_id = s.target_id AND gm.user_id = s.host_id) END;

  IF p_action = 'start' THEN
    -- Join a live session; take over an ended, abandoned (host left) or idle (> 6 h) one.
    IF s.ended_at IS NULL AND NOT host_gone AND s.updated_at > now() - interval '6 hours' THEN
      RETURN public.music_listen_json(s);
    END IF;
    UPDATE public.music_listen_sessions x
    SET host_id = uid, host_only = COALESCE(p_flag, false), upload_id = NULL, position_ms = 0, is_playing = false,
        anchor_at = now(), queue = '{}', seq = x.seq + 1, ended_at = NULL, updated_at = now()
    WHERE x.id = s.id RETURNING * INTO s;
  ELSE
    IF s.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'No one is listening here right now.' USING ERRCODE = 'P0002';
    END IF;
    IF p_action IN ('host_only', 'end') AND s.host_id IS DISTINCT FROM uid AND NOT (p_action = 'end' AND host_gone) THEN
      RAISE EXCEPTION 'Only the host can do that.' USING ERRCODE = '42501';
    END IF;
    IF s.host_only AND s.host_id IS DISTINCT FROM uid AND NOT (p_action = 'end' AND host_gone) THEN
      RAISE EXCEPTION 'Only the host can control playback.' USING ERRCODE = '42501';
    END IF;
    IF p_action IN ('load', 'enqueue') THEN
      SELECT EXISTS (
        SELECT 1 FROM public.music_upload_shares sh JOIN public.music_uploads u ON u.id = sh.upload_id
        WHERE sh.upload_id = p_upload_id AND sh.target_kind = p_kind AND sh.target_id = p_target
          AND u.state = 'active' AND u.expires_at > now()
      ) INTO shared_ok;
      IF shared_ok IS NOT TRUE THEN
        RAISE EXCEPTION 'Share this song to the room or group first.' USING ERRCODE = '22023';
      END IF;
    END IF;

    -- Where the shared playhead is right now (anchor maths), then apply the change.
    pos := LEAST(86400000, s.position_ms + CASE WHEN s.is_playing
      THEN GREATEST(0, (extract(epoch FROM now() - s.anchor_at) * 1000)::integer) ELSE 0 END);
    IF p_action = 'next' AND s.upload_id IS DISTINCT FROM p_upload_id THEN
      -- Several listeners finish the same song at once: only the first advance applies.
      RETURN public.music_listen_json(s);
    END IF;
    IF p_action IN ('play', 'pause', 'seek') AND s.upload_id IS NULL THEN
      RAISE EXCEPTION 'Pick a song first.' USING ERRCODE = '22023';
    END IF;
    IF p_action = 'seek' AND p_position_ms IS NULL THEN
      RAISE EXCEPTION 'Invalid position.' USING ERRCODE = '22023';
    END IF;
    IF p_action = 'enqueue' AND cardinality(s.queue) >= 100 THEN
      RAISE EXCEPTION 'The queue holds up to 100 songs.' USING ERRCODE = '54000';
    END IF;
    IF p_action = 'remove' AND (p_index IS NULL OR p_index < 0 OR p_index >= cardinality(s.queue) OR s.queue[p_index + 1] IS DISTINCT FROM p_upload_id) THEN
      RAISE EXCEPTION 'The queue changed. Try again.' USING ERRCODE = '55000';
    END IF;

    UPDATE public.music_listen_sessions x SET
      upload_id = CASE p_action
        WHEN 'load' THEN p_upload_id
        WHEN 'next' THEN COALESCE(x.queue[1], x.upload_id)
        ELSE x.upload_id END,
      queue = CASE p_action
        WHEN 'enqueue' THEN x.queue || p_upload_id
        WHEN 'remove' THEN x.queue[1:p_index] || x.queue[p_index + 2:cardinality(x.queue)]
        WHEN 'next' THEN COALESCE(x.queue[2:cardinality(x.queue)], '{}')
        ELSE x.queue END,
      is_playing = CASE p_action
        WHEN 'play' THEN true WHEN 'load' THEN true WHEN 'pause' THEN false WHEN 'end' THEN false
        WHEN 'next' THEN cardinality(x.queue) > 0
        ELSE x.is_playing END,
      position_ms = CASE
        WHEN p_action IN ('load', 'next') THEN 0
        WHEN p_action IN ('play', 'pause', 'seek') THEN COALESCE(p_position_ms, pos)
        ELSE pos END,
      host_only = CASE WHEN p_action = 'host_only' THEN COALESCE(p_flag, false) ELSE x.host_only END,
      ended_at = CASE WHEN p_action = 'end' THEN now() ELSE NULL END,
      anchor_at = now(), seq = x.seq + 1, updated_at = now()
    WHERE x.id = s.id RETURNING * INTO s;
  END IF;

  out_json := public.music_listen_json(s);
  PERFORM realtime.send(out_json, 'state', 'music_listen_' || p_kind || '_' || p_target::text, true);
  RETURN out_json;
END;
$$;


--
-- Name: music_listen_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.music_listen_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    target_kind text NOT NULL,
    target_id uuid NOT NULL,
    host_id uuid,
    host_only boolean DEFAULT false NOT NULL,
    upload_id uuid,
    position_ms integer DEFAULT 0 NOT NULL,
    is_playing boolean DEFAULT false NOT NULL,
    anchor_at timestamp with time zone DEFAULT now() NOT NULL,
    queue uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    seq bigint DEFAULT 0 NOT NULL,
    ended_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT music_listen_position CHECK (((position_ms >= 0) AND (position_ms <= 86400000))),
    CONSTRAINT music_listen_queue_size CHECK ((cardinality(queue) <= 100)),
    CONSTRAINT music_listen_target_kind CHECK ((target_kind = ANY (ARRAY['room'::text, 'group'::text])))
);


--
-- Name: music_listen_json(public.music_listen_sessions); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.music_listen_json(s public.music_listen_sessions) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT jsonb_build_object(
    'target_kind', s.target_kind, 'target_id', s.target_id,
    'host_id', s.host_id,
    'host_name', COALESCE((SELECT p.display_name FROM public.profiles p WHERE p.id = s.host_id), 'A member'),
    'host_only', s.host_only, 'upload_id', s.upload_id, 'position_ms', s.position_ms,
    'is_playing', s.is_playing, 'anchor_at', s.anchor_at, 'queue', to_jsonb(s.queue), 'seq', s.seq,
    'ended', s.ended_at IS NOT NULL, 'server_now', now()
  );
$$;


--
-- Name: music_object_insert_ok(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.music_object_insert_ok(p_name text) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $_$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL OR p_name IS NULL
     OR p_name !~ ('^' || uid::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(mp3|flac|ogg|oga|opus|wav|m4a|aac|webm|cover\.jpg)$') THEN
    RETURN false;
  END IF;
  RETURN (
    SELECT count(*) FROM storage.objects o
    WHERE o.bucket_id = 'music_uploads' AND o.name LIKE uid::text || '/%'
  ) < 100;
END;
$_$;


--
-- Name: music_object_readable(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.music_object_readable(p_name text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT auth.uid() IS NOT NULL AND (
    EXISTS (
      SELECT 1 FROM public.music_uploads u
      WHERE u.owner_id = auth.uid() AND u.state = 'active' AND u.expires_at > now()
        AND (u.object_path = p_name OR u.cover_path = p_name)
    )
    OR (
      split_part(p_name, '/', 1) = auth.uid()::text
      AND NOT EXISTS (SELECT 1 FROM public.music_uploads u WHERE u.object_path = p_name OR u.cover_path = p_name)
    )
  );
$$;


--
-- Name: music_playlists_limit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.music_playlists_limit() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  IF (SELECT count(*) FROM public.music_playlists p WHERE p.owner_id = NEW.owner_id) >= 100 THEN
    RAISE EXCEPTION 'You can have up to 100 playlists.' USING ERRCODE = '54000';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: music_upload_ttl(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.music_upload_ttl() RETURNS interval
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$ SELECT interval '7 days' $$;


--
-- Name: notification_user_label(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notification_user_label(p_user_id uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT COALESCE(
    (SELECT COALESCE(NULLIF(btrim(p.display_name), ''), CASE WHEN p.username IS NOT NULL THEN '@' || p.username END)
     FROM public.profiles p WHERE p.id = p_user_id),
    'A member'
  );
$$;


--
-- Name: notifications_suppressed(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notifications_suppressed(p_user_id uuid, p_room_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.notification_preferences np
    WHERE np.user_id = p_user_id
      AND (np.room_id IS NULL OR np.room_id = p_room_id)
      AND (np.muted_until IS NULL OR np.muted_until > now())
  );
$$;


--
-- Name: notify_member_access_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_member_access_change() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_room_name text;
  v_action text := NEW.payload ->> 'action';
  v_message text;
BEGIN
  IF NEW.subject_user_id IS NULL OR NEW.subject_user_id IS NOT DISTINCT FROM NEW.actor_id THEN
    RETURN NEW;
  END IF;

  SELECT r.name INTO v_room_name FROM public.rooms r WHERE r.id = NEW.room_id;
  v_room_name := COALESCE(v_room_name, 'a room');

  v_message := CASE
    WHEN NEW.event_type = 'role_changed' AND (NEW.payload ->> 'role') IS NOT NULL
      THEN 'Your role in "' || v_room_name || '" is now ' || (NEW.payload ->> 'role') || '.'
    WHEN NEW.event_type = 'membership_changed' AND v_action = 'approve'
      THEN 'Your request to join "' || v_room_name || '" was approved.'
    WHEN NEW.event_type = 'membership_changed' AND v_action = 'reject'
      THEN 'Your request to join "' || v_room_name || '" was declined.'
    WHEN NEW.event_type = 'membership_changed' AND v_action = 'kick'
      THEN 'You were removed from "' || v_room_name || '".'
    WHEN NEW.event_type = 'restriction_changed' AND v_action IN ('ban', 'block')
      THEN 'You were ' || CASE v_action WHEN 'ban' THEN 'banned' ELSE 'blocked' END || ' from "' || v_room_name || '".'
    WHEN NEW.event_type = 'restriction_changed' AND v_action IN ('unban', 'unblock')
      THEN 'Your restriction in "' || v_room_name || '" was lifted.'
    WHEN NEW.event_type = 'ownership_changed'
      THEN 'You are now the owner of "' || v_room_name || '".'
    ELSE NULL
  END;

  IF v_message IS NOT NULL THEN
    PERFORM public.enqueue_room_notification(
      NEW.subject_user_id, NEW.room_id, 'access', v_message,
      jsonb_build_object('event_type', NEW.event_type, 'action', v_action, 'room_name', v_room_name),
      NEW.actor_id, NULL, 'access:' || NEW.id::text
    );
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: notify_room_announcement(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_room_announcement() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_member uuid;
  v_text text;
BEGIN
  BEGIN
    v_text := left(public.notification_user_label(NEW.author_id), 80) || ' posted an announcement: '
      || left(regexp_replace(btrim(NEW.body), '\s+', ' ', 'g'), 160);
    FOR v_member IN
      SELECT rm.user_id FROM public.room_members rm
      WHERE rm.room_id = NEW.room_id AND rm.join_status = 'approved' AND rm.user_id <> NEW.author_id
    LOOP
      IF public.room_user_role(NEW.room_id, v_member) IS NOT NULL THEN
        PERFORM public.enqueue_room_notification(
          v_member, NEW.room_id, 'announcement', v_text,
          jsonb_build_object('announcement_id', NEW.id), NEW.author_id, NEW.id, 'announcement:' || NEW.id::text);
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'announcement notification skipped (%)', SQLSTATE;
  END;
  RETURN NULL;
END;
$$;


--
-- Name: notify_room_event_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_room_event_change() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_member uuid;
  v_text text;
  v_kind text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_kind := 'scheduled';
    v_text := left(public.notification_user_label(NEW.created_by), 80) || ' scheduled "' || left(NEW.title, 120)
      || '" for ' || to_char(NEW.starts_at AT TIME ZONE 'UTC', 'Mon DD, HH24:MI') || ' UTC';
  ELSIF NEW.cancelled_at IS NOT NULL AND OLD.cancelled_at IS NULL THEN
    v_kind := 'cancelled';
    v_text := 'Cancelled: "' || left(NEW.title, 120) || '"';
  ELSE
    RETURN NULL;
  END IF;
  BEGIN
    FOR v_member IN
      SELECT rm.user_id FROM public.room_members rm
      WHERE rm.room_id = NEW.room_id AND rm.join_status = 'approved'
    LOOP
      IF public.room_member_can(NEW.room_id, v_member, 'chat') THEN
        PERFORM public.enqueue_room_notification(
          v_member, NEW.room_id, 'room_event', v_text,
          jsonb_build_object('event_id', NEW.id, 'starts_at', NEW.starts_at),
          COALESCE(auth.uid(), NEW.created_by), NEW.id,
          'room-event-' || v_kind || ':' || NEW.id::text);
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'room event notification skipped (%)', SQLSTATE;
  END;
  RETURN NULL;
END;
$$;


--
-- Name: notify_room_message_activity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_room_message_activity() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_label text;
  v_target_sender uuid;
  v_mentioned uuid;
BEGIN
  IF NEW.room_id IS NULL OR COALESCE(NEW.is_deleted, false) OR NEW.content IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.content IS NOT DISTINCT FROM OLD.content THEN
    RETURN NULL;
  END IF;

  BEGIN
    v_label := public.notification_user_label(NEW.sender_id);

    IF TG_OP = 'INSERT' AND NEW.reply_to_id IS NOT NULL THEN
      SELECT m.sender_id INTO v_target_sender FROM public.messages m WHERE m.id = NEW.reply_to_id;
      IF v_target_sender IS NOT NULL AND v_target_sender <> NEW.sender_id
         AND public.room_member_can(NEW.room_id, v_target_sender, 'chat') THEN
        PERFORM public.enqueue_room_notification(
          v_target_sender, NEW.room_id, 'reply', left(v_label, 80) || ' replied to your message.',
          jsonb_build_object('message_id', NEW.id), NEW.sender_id, NEW.id, 'reply:' || NEW.id::text);
      END IF;
    END IF;

    IF NEW.content !~ '^\[gif:' THEN
      FOR v_mentioned IN
        SELECT DISTINCT p.id
        FROM (
          SELECT lower(matched.parts[1]) AS token
          FROM regexp_matches(NEW.content, '(?:^|[^A-Za-z0-9_.@])@([A-Za-z0-9][A-Za-z0-9_.]{2,29})', 'g') AS matched(parts)
          LIMIT 20
        ) tokens
        JOIN public.profiles p ON lower(p.username) IN (tokens.token, rtrim(tokens.token, '.'))
        WHERE p.id <> NEW.sender_id
        LIMIT 10
      LOOP
        IF public.room_member_can(NEW.room_id, v_mentioned, 'chat') THEN
          PERFORM public.enqueue_room_notification(
            v_mentioned, NEW.room_id, 'mention', left(v_label, 80) || ' mentioned you.',
            jsonb_build_object('message_id', NEW.id), NEW.sender_id, NEW.id,
            'mention:' || NEW.id::text || ':' || v_mentioned::text);
        END IF;
      END LOOP;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'room message notification skipped (%)', SQLSTATE;
  END;
  RETURN NULL;
END;
$$;


--
-- Name: notify_room_pdf_shared(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_room_pdf_shared() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_member uuid;
  v_text text;
BEGIN
  IF NEW.mime_type <> 'application/pdf' OR NEW.retention_state <> 'active' THEN
    RETURN NULL;
  END IF;
  BEGIN
    v_text := left(public.notification_user_label(NEW.owner_id), 80) || ' shared a PDF: ' || left(NEW.original_name, 160);
    FOR v_member IN
      SELECT rm.user_id FROM public.room_members rm
      WHERE rm.room_id = NEW.room_id AND rm.join_status = 'approved' AND rm.user_id <> NEW.owner_id
    LOOP
      IF public.room_member_can(NEW.room_id, v_member, 'files') THEN
        PERFORM public.enqueue_room_notification(
          v_member, NEW.room_id, 'pdf_shared', v_text,
          jsonb_build_object('file_id', NEW.id), NEW.owner_id, NEW.id, 'pdf_shared:' || NEW.id::text);
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'shared PDF notification skipped (%)', SQLSTATE;
  END;
  RETURN NULL;
END;
$$;


--
-- Name: notify_room_recovery_decision(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_room_recovery_decision() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_room_name text;
  member_row record;
BEGIN
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('approved', 'rejected') THEN
    RETURN NEW;
  END IF;

  SELECT r.name INTO v_room_name FROM public.rooms r WHERE r.id = NEW.room_id;

  PERFORM public.enqueue_room_notification(
    NEW.requester_id, NEW.room_id, 'recovery_decision',
    CASE NEW.status
      WHEN 'approved' THEN 'Your recovery request for "' || COALESCE(v_room_name, 'the room') || '" was approved. The room is open again for 7 days.'
      ELSE 'Your recovery request for "' || COALESCE(v_room_name, 'the room') || '" was rejected. The room stays unavailable and is deleted when its recovery window ends.'
    END,
    jsonb_build_object('request_id', NEW.id, 'decision', NEW.status, 'room_name', v_room_name),
    NEW.reviewed_by, NEW.id, 'recovery_decision:' || NEW.id::text
  );

  IF NEW.status = 'approved' THEN
    FOR member_row IN
      SELECT rm.user_id
      FROM public.room_members rm
      WHERE rm.room_id = NEW.room_id
        AND rm.join_status = 'approved'
        AND rm.user_id <> NEW.requester_id
    LOOP
      PERFORM public.enqueue_room_notification(
        member_row.user_id, NEW.room_id, 'recovery_decision',
        '"' || COALESCE(v_room_name, 'A room') || '" was recovered and is open again for 7 days.',
        jsonb_build_object('request_id', NEW.id, 'decision', 'approved', 'room_name', v_room_name),
        NEW.reviewed_by, NEW.room_id,
        'room_recovered:' || NEW.room_id::text || ':' || extract(epoch FROM NEW.reviewed_at)::bigint::text
      );
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: FUNCTION notify_room_recovery_decision(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.notify_room_recovery_decision() IS 'Creates private recovery outcome notifications for the requester and approved room members.';


--
-- Name: notify_room_task_assignment(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_room_task_assignment() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF NEW.assignee_id IS NULL OR (TG_OP = 'UPDATE' AND NEW.assignee_id IS NOT DISTINCT FROM OLD.assignee_id) THEN
    RETURN NULL;
  END IF;
  BEGIN
    PERFORM public.enqueue_room_notification(
      NEW.assignee_id, NEW.room_id, 'task',
      left(public.notification_user_label(COALESCE(auth.uid(), NEW.created_by)), 80) || ' assigned you a task: ' || left(NEW.title, 160),
      jsonb_build_object('task_id', NEW.id),
      COALESCE(auth.uid(), NEW.created_by), NEW.id,
      'task-assigned:' || NEW.id::text || ':' || NEW.assignee_id::text);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'task notification skipped (%)', SQLSTATE;
  END;
  RETURN NULL;
END;
$$;


--
-- Name: notify_room_timer_activity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_room_timer_activity() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
DECLARE
  v_event text := NEW.payload ->> 'eventType';
  v_wire jsonb := NEW.payload -> 'payload';
  v_session text;
  v_duration_text text;
  v_duration integer;
  v_owner uuid;
  v_starter uuid;
BEGIN
  IF NEW.snapshot_type <> 'timer' OR jsonb_typeof(v_wire) IS DISTINCT FROM 'object' THEN
    RETURN NULL;
  END IF;
  v_session := v_wire ->> 'sessionId';
  IF v_session IS NULL OR v_session !~ '^[A-Za-z0-9-]{8,80}$' THEN
    RETURN NULL;
  END IF;

  BEGIN
    IF v_event = 'timer_start' THEN
      v_duration_text := v_wire ->> 'duration';
      IF v_duration_text IS NULL OR v_duration_text !~ '^[0-9]{1,6}(\.[0-9]+)?$' THEN
        RETURN NULL;
      END IF;
      v_duration := round(v_duration_text::numeric)::integer;
      IF v_duration < 1 OR v_duration > 359999 THEN
        RETURN NULL;
      END IF;

      INSERT INTO public.room_timer_sessions (room_id, session_id, started_by, duration_seconds)
      VALUES (NEW.room_id, v_session, NEW.updated_by, v_duration)
      ON CONFLICT (room_id, session_id) DO NOTHING;
      IF NOT FOUND THEN
        RETURN NULL; -- resuming a known session
      END IF;

      SELECT rm.user_id INTO v_owner FROM public.room_members rm
      WHERE rm.room_id = NEW.room_id AND rm.role = 'owner' AND rm.join_status = 'approved'
      LIMIT 1;
      IF v_owner IS NOT NULL THEN
        PERFORM public.enqueue_room_notification(
          v_owner, NEW.room_id, 'timer',
          left(public.notification_user_label(NEW.updated_by), 80) || ' started a '
            || GREATEST(1, round(v_duration / 60.0))::integer || '-minute study timer.',
          jsonb_build_object('session_id', v_session, 'duration_seconds', v_duration),
          NEW.updated_by, NULL, 'timer-start:' || NEW.room_id::text || ':' || v_session);
      END IF;
    ELSIF v_event = 'timer_pause' AND (v_wire ->> 'completed') = 'true' THEN
      UPDATE public.room_timer_sessions s
      SET completed_at = now()
      WHERE s.room_id = NEW.room_id AND s.session_id = v_session AND s.completed_at IS NULL
        AND now() >= s.started_at + make_interval(secs => s.duration_seconds) - interval '15 seconds'
      RETURNING s.started_by, s.duration_seconds INTO v_starter, v_duration;
      IF FOUND THEN
        PERFORM public.enqueue_room_notification(
          v_starter, NEW.room_id, 'timer',
          'Your ' || GREATEST(1, round(v_duration / 60.0))::integer || '-minute study timer finished.',
          jsonb_build_object('session_id', v_session, 'duration_seconds', v_duration),
          NULL, NULL, 'timer-done:' || NEW.room_id::text || ':' || v_session);
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'timer notification skipped (%)', SQLSTATE;
  END;
  RETURN NULL;
END;
$_$;


--
-- Name: notify_site_owners_of_recovery_request(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_site_owners_of_recovery_request() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_room_name text;
  owner_row record;
BEGIN
  SELECT r.name INTO v_room_name FROM public.rooms r WHERE r.id = NEW.room_id;
  FOR owner_row IN SELECT so.user_id FROM public.site_owners so LOOP
    PERFORM public.enqueue_room_notification(
      owner_row.user_id, NEW.room_id, 'recovery_request',
      public.notification_user_label(NEW.requester_id) || ' asked to recover "' || COALESCE(v_room_name, 'a room') || '".',
      jsonb_build_object('request_id', NEW.id, 'room_name', v_room_name),
      NEW.requester_id, NEW.id, 'recovery_request:' || NEW.id::text
    );
  END LOOP;
  RETURN NEW;
END;
$$;


--
-- Name: prepare_account_deletion(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prepare_account_deletion(p_user_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;


--
-- Name: prepare_room_message_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prepare_room_message_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  NEW.edited_at := NULL;
  NEW.pinned_at := NULL;
  NEW.pinned_by := NULL;
  NEW.reaction_summary := '{}'::jsonb;

  IF NEW.reply_to_id IS NOT NULL AND (
    NEW.room_id IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM public.messages target
      WHERE target.id = NEW.reply_to_id
        AND target.room_id = NEW.room_id
        AND NOT COALESCE(target.is_deleted, false)
    )
  ) THEN
    RAISE EXCEPTION 'You can only reply to a message in this room.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: prevent_message_request_tampering(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_message_request_tampering() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.requester_id IS DISTINCT FROM OLD.requester_id
     OR NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Message request identity cannot change.';
  END IF;
  IF OLD.status <> 'pending' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'Completed message requests cannot change.';
  END IF;
  IF NEW.status NOT IN ('pending', 'accepted', 'rejected', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid message request status.';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: prevent_message_scope_changes(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_message_scope_changes() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.sender_id IS DISTINCT FROM OLD.sender_id
     OR NEW.room_id IS DISTINCT FROM OLD.room_id
     OR NEW.chat_id IS DISTINCT FROM OLD.chat_id THEN
    RAISE EXCEPTION 'Message ownership and scope cannot change.';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: prevent_permanent_request_tampering(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_permanent_request_tampering() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.room_id IS DISTINCT FROM OLD.room_id
     OR NEW.requester_id IS DISTINCT FROM OLD.requester_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Permanent-room request identity cannot change.';
  END IF;

  IF OLD.status <> 'pending' OR NEW.status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Permanent-room requests only allow pending to approved or rejected.';
  END IF;

  IF NEW.reviewed_at IS NULL OR NEW.reviewed_by IS NULL THEN
    RAISE EXCEPTION 'Reviewed permanent-room requests require reviewer audit fields.';
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: prevent_recovery_request_tampering(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_recovery_request_tampering() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.room_id IS DISTINCT FROM OLD.room_id
     OR NEW.requester_id IS DISTINCT FROM OLD.requester_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Recovery request identity cannot change.';
  END IF;

  IF OLD.status <> 'pending' OR NEW.status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Recovery requests only allow pending to approved or rejected.';
  END IF;

  IF NEW.reviewed_at IS NULL OR NEW.reviewed_by IS NULL THEN
    RAISE EXCEPTION 'Reviewed recovery requests require reviewer audit fields.';
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: prevent_room_membership_escalation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_room_membership_escalation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.room_id IS DISTINCT FROM OLD.room_id OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN RAISE EXCEPTION 'Room membership identity cannot change.'; END IF;
  IF NEW.role IS DISTINCT FROM OLD.role
     AND COALESCE(current_setting('app.omnilume_account_deletion', true), '') <> 'true'
     AND COALESCE(current_setting('app.omnilume_room_control', true), '') NOT IN ('ownership_transfer', 'role_change') THEN RAISE EXCEPTION 'Room membership roles cannot be changed through this operation.'; END IF;
  IF NEW.join_status NOT IN ('pending', 'approved', 'rejected') THEN RAISE EXCEPTION 'Invalid room membership status.'; END IF;
  RETURN NEW;
END;
$$;


--
-- Name: prevent_social_request_tampering(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_social_request_tampering() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF TG_TABLE_NAME = 'follows' THEN
    IF NEW.follower_id IS DISTINCT FROM OLD.follower_id
       OR NEW.following_id IS DISTINCT FROM OLD.following_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Follow identity cannot change.';
    END IF;
    IF OLD.status NOT IN ('pending', 'accepted', 'rejected', 'cancelled')
       OR NEW.status NOT IN ('pending', 'accepted', 'rejected', 'cancelled') THEN
      RAISE EXCEPTION 'Invalid follow status.';
    END IF;
    IF OLD.status = 'accepted' AND NEW.status <> 'accepted' THEN
      RAISE EXCEPTION 'Accepted follows cannot be changed through this operation.';
    END IF;
  ELSE
    IF NEW.requester_id IS DISTINCT FROM OLD.requester_id
       OR NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Friend request identity cannot change.';
    END IF;
    IF OLD.status <> 'pending' AND NEW.status <> OLD.status THEN
      RAISE EXCEPTION 'Completed friend requests cannot change.';
    END IF;
    IF NEW.status NOT IN ('pending', 'accepted', 'rejected', 'cancelled') THEN
      RAISE EXCEPTION 'Invalid friend request status.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: prevent_unauthorized_deletion_schedule(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_unauthorized_deletion_schedule() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.deletion_scheduled_at IS NOT NULL OR NEW.deletion_scheduled_by IS NOT NULL THEN
      RAISE EXCEPTION 'Room deletion can only be scheduled through the deletion workflow.';
    END IF;
  ELSIF (NEW.deletion_scheduled_at IS DISTINCT FROM OLD.deletion_scheduled_at
         OR NEW.deletion_scheduled_by IS DISTINCT FROM OLD.deletion_scheduled_by)
        AND COALESCE(current_setting('app.omnilume_lifecycle_authorized', true), '') <> 'deletion_schedule' THEN
    RAISE EXCEPTION 'Room deletion can only be scheduled through the deletion workflow.';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: prevent_unauthorized_expired_conversion(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_unauthorized_expired_conversion() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF OLD.expiration_type <> 'permanent'
     AND NEW.expiration_type = 'permanent'
     AND OLD.expires_at IS NOT NULL
     AND OLD.expires_at <= now()
     AND current_setting('app.omnilume_lifecycle_authorized', true) <> 'permanent_conversion' THEN
    RAISE EXCEPTION 'Expired rooms can only become permanent through an approved conversion.';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: prevent_unauthorized_reopen(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_unauthorized_reopen() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.reopened_until IS DISTINCT FROM OLD.reopened_until
     AND current_setting('app.omnilume_lifecycle_authorized', true) NOT IN ('recovery_approval', 'permanent_conversion') THEN
    RAISE EXCEPTION 'Room reopen dates can only be set by approved recovery.';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: private_chat_type(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.private_chat_type(p_chat_id uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM public.user_blocks ub
      WHERE (ub.blocker_id = pc.user_one AND ub.blocked_id = pc.user_two)
         OR (ub.blocker_id = pc.user_two AND ub.blocked_id = pc.user_one)
    ) THEN NULL
    WHEN EXISTS (
      SELECT 1 FROM public.friendships f
      WHERE f.user_one = LEAST(pc.user_one, pc.user_two) AND f.user_two = GREATEST(pc.user_one, pc.user_two)
    ) THEN 'personal'
    WHEN EXISTS (
      SELECT 1 FROM public.message_requests mr
      WHERE mr.status = 'accepted'
        AND ((mr.requester_id = pc.user_one AND mr.recipient_id = pc.user_two)
          OR (mr.requester_id = pc.user_two AND mr.recipient_id = pc.user_one))
    ) THEN 'general'
  END
  FROM public.private_chats pc
  WHERE pc.id = p_chat_id AND auth.uid() IS NOT NULL AND auth.uid() IN (pc.user_one, pc.user_two);
$$;


--
-- Name: raise_room_hand(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.raise_room_hand(p_room_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.room_has_capability(p_room_id, auth.uid(), 'chat') THEN
    RAISE EXCEPTION 'Not authorized to raise a hand in this room.' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.room_hand_raises (room_id, user_id) VALUES (p_room_id, auth.uid())
  ON CONFLICT (room_id, user_id) DO NOTHING;
END;
$$;


--
-- Name: record_music_play(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_music_play(p_upload_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL OR NOT public.music_can_play(p_upload_id, uid) THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.music_listening_history h
    WHERE h.user_id = uid AND h.upload_id = p_upload_id AND h.played_at > now() - interval '30 seconds'
  ) THEN
    RETURN;
  END IF;
  INSERT INTO public.music_listening_history (user_id, upload_id) VALUES (uid, p_upload_id);
  -- Keep the newest 500 plays per listener.
  DELETE FROM public.music_listening_history h
  WHERE h.user_id = uid AND h.id < (
    SELECT min(k.id) FROM (
      SELECT x.id FROM public.music_listening_history x WHERE x.user_id = uid ORDER BY x.id DESC LIMIT 500
    ) k
  );
END;
$$;


--
-- Name: record_room_control_event(uuid, text, uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_room_control_event(p_room_id uuid, p_event_type text, p_subject_user_id uuid DEFAULT NULL::uuid, p_payload jsonb DEFAULT '{}'::jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  INSERT INTO public.room_control_events(room_id, event_type, actor_id, subject_user_id, payload)
  VALUES (p_room_id, p_event_type, auth.uid(), p_subject_user_id, p_payload);
END;
$$;


--
-- Name: record_room_export_digest(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_room_export_digest(p_export_id uuid, p_sha256 text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
BEGIN
  IF p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid digest.' USING ERRCODE = '22023';
  END IF;
  UPDATE public.room_exports e SET sha256 = p_sha256
  WHERE e.id = p_export_id AND e.requested_by = auth.uid() AND e.sha256 IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Export not found.' USING ERRCODE = '42501';
  END IF;
END;
$_$;


--
-- Name: refresh_room_message_reaction_summary(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refresh_room_message_reaction_summary() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF COALESCE(current_setting('app.omnilume_message_authorized', true), '') = 'reactions' THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('app.omnilume_message_authorized', 'reactions', true);
  UPDATE public.messages m
  SET reaction_summary = public.room_message_reaction_summary(m.id)
  WHERE m.id IN (SELECT DISTINCT removed.message_id FROM removed_rows removed)
    AND NOT COALESCE(m.is_deleted, false);
  PERFORM set_config('app.omnilume_message_authorized', '', true);
  RETURN NULL;
END;
$$;


--
-- Name: music_uploads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.music_uploads (
    id uuid NOT NULL,
    owner_id uuid NOT NULL,
    object_path text NOT NULL,
    cover_path text,
    mime_type text NOT NULL,
    size_bytes bigint NOT NULL,
    original_name text NOT NULL,
    title text NOT NULL,
    artist text DEFAULT ''::text NOT NULL,
    album text DEFAULT ''::text NOT NULL,
    album_artist text DEFAULT ''::text NOT NULL,
    track_no integer,
    year integer,
    genre text DEFAULT ''::text NOT NULL,
    duration_ms integer,
    hue smallint DEFAULT 260 NOT NULL,
    lyrics text,
    state text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    delete_requested_at timestamp with time zone,
    deleted_at timestamp with time zone,
    cleanup_attempts integer DEFAULT 0 NOT NULL,
    last_cleanup_error text,
    CONSTRAINT music_uploads_album_artist_check CHECK ((char_length(album_artist) <= 200)),
    CONSTRAINT music_uploads_album_check CHECK ((char_length(album) <= 200)),
    CONSTRAINT music_uploads_artist_check CHECK ((char_length(artist) <= 200)),
    CONSTRAINT music_uploads_cover_path CHECK (((cover_path IS NULL) OR (cover_path = ((((owner_id)::text || '/'::text) || (id)::text) || '.cover.jpg'::text)))),
    CONSTRAINT music_uploads_duration_ms_check CHECK (((duration_ms >= 0) AND (duration_ms <= 86400000))),
    CONSTRAINT music_uploads_genre_check CHECK ((char_length(genre) <= 80)),
    CONSTRAINT music_uploads_hue_check CHECK (((hue >= 0) AND (hue <= 359))),
    CONSTRAINT music_uploads_last_cleanup_error_check CHECK ((char_length(last_cleanup_error) <= 1000)),
    CONSTRAINT music_uploads_lyrics_check CHECK ((char_length(lyrics) <= 20000)),
    CONSTRAINT music_uploads_mime_type_check CHECK ((mime_type = ANY (ARRAY['audio/mpeg'::text, 'audio/flac'::text, 'audio/ogg'::text, 'audio/wav'::text, 'audio/mp4'::text, 'audio/aac'::text, 'audio/webm'::text]))),
    CONSTRAINT music_uploads_object_path CHECK ((object_path ~ (((('^'::text || (owner_id)::text) || '/'::text) || (id)::text) || '\.(mp3|flac|ogg|oga|opus|wav|m4a|aac|webm)$'::text))),
    CONSTRAINT music_uploads_original_name_check CHECK (((char_length(original_name) >= 1) AND (char_length(original_name) <= 180))),
    CONSTRAINT music_uploads_size_bytes_check CHECK (((size_bytes >= 1) AND (size_bytes <= 52428800))),
    CONSTRAINT music_uploads_state_check CHECK ((state = ANY (ARRAY['active'::text, 'delete_pending'::text, 'deleted'::text]))),
    CONSTRAINT music_uploads_title_check CHECK (((char_length(title) >= 1) AND (char_length(title) <= 200))),
    CONSTRAINT music_uploads_track_no_check CHECK (((track_no >= 1) AND (track_no <= 999))),
    CONSTRAINT music_uploads_ttl CHECK ((expires_at = (created_at + public.music_upload_ttl()))),
    CONSTRAINT music_uploads_year_check CHECK (((year >= 1000) AND (year <= 9999)))
);


--
-- Name: register_music_upload(uuid, uuid, text, text, text, text, text, text, text, integer, integer, text, integer, integer, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.register_music_upload(p_owner_id uuid, p_upload_id uuid, p_ext text, p_mime_type text, p_original_name text, p_title text, p_artist text, p_album text, p_album_artist text, p_track_no integer, p_year integer, p_genre text, p_duration_ms integer, p_hue integer, p_lyrics text, p_has_cover boolean) RETURNS public.music_uploads
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  object_path text;
  cover_path text;
  audio_meta jsonb;
  cover_meta jsonb;
  audio_size bigint;
  active_count integer;
  active_bytes bigint;
  row_out public.music_uploads%ROWTYPE;
BEGIN
  IF p_owner_id IS NULL OR p_upload_id IS NULL THEN
    RAISE EXCEPTION 'Invalid music upload.' USING ERRCODE = '22023';
  END IF;
  IF p_mime_type IS DISTINCT FROM (CASE p_ext
       WHEN 'mp3' THEN 'audio/mpeg' WHEN 'flac' THEN 'audio/flac'
       WHEN 'ogg' THEN 'audio/ogg' WHEN 'oga' THEN 'audio/ogg' WHEN 'opus' THEN 'audio/ogg'
       WHEN 'wav' THEN 'audio/wav' WHEN 'm4a' THEN 'audio/mp4' WHEN 'aac' THEN 'audio/aac'
       WHEN 'webm' THEN 'audio/webm' END)
     OR char_length(COALESCE(btrim(p_title), '')) NOT BETWEEN 1 AND 200
     OR char_length(COALESCE(p_original_name, '')) NOT BETWEEN 1 AND 180
     OR char_length(COALESCE(p_artist, '')) > 200 OR char_length(COALESCE(p_album, '')) > 200
     OR char_length(COALESCE(p_album_artist, '')) > 200 OR char_length(COALESCE(p_genre, '')) > 80
     OR char_length(COALESCE(p_lyrics, '')) > 20000
     OR (p_track_no IS NOT NULL AND p_track_no NOT BETWEEN 1 AND 999)
     OR (p_year IS NOT NULL AND p_year NOT BETWEEN 1000 AND 9999)
     OR (p_duration_ms IS NOT NULL AND p_duration_ms NOT BETWEEN 0 AND 86400000)
     OR p_hue IS NULL OR p_hue NOT BETWEEN 0 AND 359 THEN
    RAISE EXCEPTION 'Invalid music upload.' USING ERRCODE = '22023';
  END IF;

  object_path := p_owner_id::text || '/' || p_upload_id::text || '.' || p_ext;
  cover_path := CASE WHEN p_has_cover THEN p_owner_id::text || '/' || p_upload_id::text || '.cover.jpg' END;

  SELECT o.metadata INTO audio_meta FROM storage.objects o
  WHERE o.bucket_id = 'music_uploads' AND o.name = object_path AND o.owner_id = p_owner_id::text;
  audio_size := (audio_meta ->> 'size')::bigint;
  IF audio_meta IS NULL OR audio_meta ->> 'mimetype' IS DISTINCT FROM p_mime_type
     OR audio_size IS NULL OR audio_size NOT BETWEEN 1 AND 52428800 THEN
    RAISE EXCEPTION 'The uploaded file was not found or does not match.' USING ERRCODE = '22023';
  END IF;
  IF cover_path IS NOT NULL THEN
    SELECT o.metadata INTO cover_meta FROM storage.objects o
    WHERE o.bucket_id = 'music_uploads' AND o.name = cover_path AND o.owner_id = p_owner_id::text;
    IF cover_meta IS NULL OR cover_meta ->> 'mimetype' IS DISTINCT FROM 'image/jpeg'
       OR COALESCE((cover_meta ->> 'size')::bigint, 0) NOT BETWEEN 1 AND 2097152 THEN
      RAISE EXCEPTION 'The uploaded artwork was not found or does not match.' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Serialise one owner's registrations so the caps cannot be raced.
  PERFORM pg_advisory_xact_lock(hashtextextended('music_uploads:' || p_owner_id::text, 0));
  SELECT count(*), COALESCE(sum(u.size_bytes), 0) INTO active_count, active_bytes
  FROM public.music_uploads u
  WHERE u.owner_id = p_owner_id AND u.state = 'active' AND u.expires_at > now();
  IF active_count >= 40 THEN
    RAISE EXCEPTION 'You can keep up to 40 uploads at a time.' USING ERRCODE = '54000';
  END IF;
  IF active_bytes + audio_size > 314572800 THEN
    RAISE EXCEPTION 'Uploads are limited to 300 MB in total.' USING ERRCODE = '54000';
  END IF;

  INSERT INTO public.music_uploads (
    id, owner_id, object_path, cover_path, mime_type, size_bytes, original_name, title, artist, album,
    album_artist, track_no, year, genre, duration_ms, hue, lyrics, created_at, expires_at
  ) VALUES (
    p_upload_id, p_owner_id, object_path, cover_path, p_mime_type, audio_size, p_original_name, btrim(p_title),
    COALESCE(p_artist, ''), COALESCE(p_album, ''), COALESCE(p_album_artist, ''), p_track_no, p_year,
    COALESCE(p_genre, ''), p_duration_ms, p_hue, NULLIF(p_lyrics, ''), now(), now() + public.music_upload_ttl()
  )
  RETURNING * INTO row_out;
  RETURN row_out;
END;
$$;


--
-- Name: register_room_file(uuid, text, text, text, text, bigint, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.register_room_file(p_room_id uuid, p_object_path text, p_original_name text, p_normalized_name text, p_mime_type text, p_size_bytes bigint, p_metadata jsonb DEFAULT '{}'::jsonb) RETURNS public.room_files
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
DECLARE
  file_row public.room_files%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.room_has_capability(p_room_id, auth.uid(), 'files')
     OR p_object_path !~* ('^' || p_room_id::text || '/files/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]{1,16}$')
     OR char_length(COALESCE(p_original_name, '')) NOT BETWEEN 1 AND 180
     OR char_length(COALESCE(p_normalized_name, '')) NOT BETWEEN 1 AND 180
     OR p_mime_type NOT IN (
       'application/pdf', 'application/x-subrip', 'text/plain', 'text/markdown', 'text/vtt',
       'image/gif', 'image/jpeg', 'image/png', 'image/webp',
       'audio/mpeg', 'audio/flac', 'audio/ogg', 'audio/wav', 'audio/webm',
       'video/mp4', 'video/ogg', 'video/webm'
     )
     OR (
       p_mime_type = 'audio/flac'
       AND (
         p_original_name !~* '\.flac$'
         OR p_normalized_name !~* '\.flac$'
         OR p_object_path !~* '\.flac$'
       )
     )
     OR (
       p_mime_type <> 'audio/flac'
       AND (
         p_original_name ~* '\.flac$'
         OR p_normalized_name ~* '\.flac$'
         OR p_object_path ~* '\.flac$'
       )
     )
     OR p_size_bytes IS NULL OR p_size_bytes <= 0 OR p_size_bytes > 52428800
     OR p_metadata IS NULL OR jsonb_typeof(p_metadata) <> 'object' THEN
    RAISE EXCEPTION 'Invalid or unauthorized room file.';
  END IF;

  INSERT INTO public.room_files (
    room_id, owner_id, object_path, original_name, normalized_name, mime_type, size_bytes, metadata
  ) VALUES (
    p_room_id, auth.uid(), p_object_path, p_original_name, p_normalized_name, p_mime_type, p_size_bytes, p_metadata
  )
  RETURNING * INTO file_row;

  RETURN file_row;
END;
$_$;


--
-- Name: temporary_media; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.temporary_media (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    room_id uuid,
    user_id uuid,
    file_name text NOT NULL,
    file_url text NOT NULL,
    media_type text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()),
    storage_bucket text,
    storage_path text,
    mime_type text,
    file_size bigint,
    subtitle_path text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT temporary_media_metadata_shape_check CHECK (((jsonb_typeof(metadata) = 'object'::text) AND (octet_length((metadata)::text) <= 409600) AND ((metadata - ARRAY['title'::text, 'artist'::text, 'album'::text, 'year'::text, 'duration_seconds'::text, 'source'::text, 'artwork'::text, 'extracted_at'::text]) = '{}'::jsonb) AND ((NOT (metadata ? 'source'::text)) OR ((metadata ->> 'source'::text) = ANY (ARRAY['tags'::text, 'filename'::text]))) AND ((NOT (metadata ? 'artwork'::text)) OR ((jsonb_typeof((metadata -> 'artwork'::text)) = 'object'::text) AND (((metadata -> 'artwork'::text) ->> 'mime_type'::text) = ANY (ARRAY['image/jpeg'::text, 'image/png'::text])) AND (((metadata -> 'artwork'::text) ->> 'data'::text) ~ '^[A-Za-z0-9+/]+={0,2}$'::text)))))
);


--
-- Name: register_temporary_media(uuid, text, text, text, text, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.register_temporary_media(p_room_id uuid, p_file_name text, p_file_path text, p_media_type text, p_mime_type text DEFAULT NULL::text, p_file_size bigint DEFAULT NULL::bigint) RETURNS public.temporary_media
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
DECLARE
  room_row public.rooms%ROWTYPE;
  media_row public.temporary_media%ROWTYPE;
  active_deadline timestamptz;
  media_expires_at timestamptz;
BEGIN
  IF auth.uid() IS NULL
     OR p_media_type NOT IN ('audio', 'video', 'url')
     OR char_length(COALESCE(p_file_name, '')) NOT BETWEEN 1 AND 512
     OR NOT public.room_has_capability(p_room_id, auth.uid(), 'watch_control') THEN
    RAISE EXCEPTION 'Invalid or unauthorized temporary media.';
  END IF;

  IF p_media_type = 'url' THEN
    IF p_file_path !~* '^https?://' OR p_mime_type IS NOT NULL OR p_file_size IS NOT NULL THEN
      RAISE EXCEPTION 'Invalid cast URL.';
    END IF;
  ELSIF p_file_path !~* ('^' || p_room_id::text || '/media/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]{1,16}$')
     OR p_mime_type NOT IN ('audio/mpeg', 'audio/flac', 'audio/ogg', 'audio/wav', 'audio/webm', 'video/mp4', 'video/ogg', 'video/webm')
     OR (p_mime_type = 'audio/flac' AND (p_media_type <> 'audio' OR p_file_name !~* '\.flac$' OR p_file_path !~* '\.flac$'))
     OR (p_mime_type <> 'audio/flac' AND (p_file_name ~* '\.flac$' OR p_file_path ~* '\.flac$'))
     OR p_file_size IS NULL OR p_file_size <= 0 OR p_file_size > 52428800 THEN
    RAISE EXCEPTION 'Invalid temporary-media object.';
  END IF;

  SELECT * INTO room_row FROM public.rooms r WHERE r.id = p_room_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Room not found.'; END IF;
  active_deadline := CASE
    WHEN room_row.expiration_type = 'permanent' THEN now() + interval '24 hours'
    WHEN room_row.reopened_until IS NOT NULL AND room_row.reopened_until > now() THEN room_row.reopened_until
    ELSE room_row.expires_at
  END;
  media_expires_at := LEAST(now() + interval '24 hours', active_deadline);
  IF media_expires_at IS NULL OR media_expires_at <= now() THEN
    RAISE EXCEPTION 'This room is not open for temporary media.';
  END IF;

  INSERT INTO public.temporary_media (
    room_id, user_id, file_name, file_url, media_type, expires_at,
    storage_bucket, storage_path, mime_type, file_size
  ) VALUES (
    p_room_id, auth.uid(), p_file_name, p_file_path, p_media_type, media_expires_at,
    CASE WHEN p_media_type = 'url' THEN NULL ELSE 'room_attachments' END,
    CASE WHEN p_media_type = 'url' THEN NULL ELSE p_file_path END,
    p_mime_type, p_file_size
  )
  RETURNING * INTO media_row;
  RETURN media_row;
END;
$_$;


--
-- Name: reject_blocked_pair(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reject_blocked_pair() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_a uuid := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
  v_b uuid := (to_jsonb(NEW) ->> TG_ARGV[1])::uuid;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.user_blocks ub
    WHERE (ub.blocker_id = v_a AND ub.blocked_id = v_b) OR (ub.blocker_id = v_b AND ub.blocked_id = v_a)
  ) THEN
    RAISE EXCEPTION 'This member is not available.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: reject_message_request(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reject_message_request(p_request_id uuid) RETURNS public.message_requests
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  request_row public.message_requests;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  SELECT * INTO request_row FROM public.message_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR request_row.recipient_id <> auth.uid() OR request_row.status <> 'pending' THEN
    RAISE EXCEPTION 'Message request is not available.';
  END IF;
  UPDATE public.message_requests
  SET status = 'rejected', responded_at = now(), responded_by = auth.uid()
  WHERE id = request_row.id
  RETURNING * INTO request_row;
  RETURN request_row;
END;
$$;


--
-- Name: remove_follower(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.remove_follower(p_follower_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  DELETE FROM public.follows
  WHERE follower_id = p_follower_id AND following_id = auth.uid();
  RETURN FOUND;
END;
$$;


--
-- Name: remove_friend(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.remove_friend(p_other_user_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  DELETE FROM public.friendships
  WHERE user_one = LEAST(auth.uid(), p_other_user_id)
    AND user_two = GREATEST(auth.uid(), p_other_user_id);
  RETURN FOUND;
END;
$$;


--
-- Name: remove_group_member(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.remove_group_member(p_group_id uuid, p_user_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_actor text;
  v_target text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501'; END IF;
  SELECT role INTO v_actor FROM public.group_members WHERE group_id = p_group_id AND user_id = auth.uid();
  SELECT role INTO v_target FROM public.group_members WHERE group_id = p_group_id AND user_id = p_user_id FOR UPDATE;
  IF v_actor IS NULL OR v_target IS NULL OR p_user_id = auth.uid() OR v_target = 'owner'
     OR v_actor = 'member' OR (v_actor = 'admin' AND v_target <> 'member') THEN
    RAISE EXCEPTION 'You cannot remove this member.' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.group_members WHERE group_id = p_group_id AND user_id = p_user_id;
  RETURN true;
END;
$$;


--
-- Name: remove_media_from_queue(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.remove_media_from_queue(p_item_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_item public.room_media_queue%ROWTYPE;
BEGIN
  SELECT * INTO v_item FROM public.room_media_queue q WHERE q.id = p_item_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_uid IS NULL
     OR NOT (
       public.room_has_capability(v_item.room_id, v_uid, 'watch_control')
       OR (v_item.added_by = v_uid AND public.room_has_capability(v_item.room_id, v_uid, 'watch'))
     ) THEN
    RAISE EXCEPTION 'You cannot remove this queue item.' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('room-media-queue:' || v_item.room_id::text, 0));
  DELETE FROM public.room_media_queue q WHERE q.id = p_item_id;
  -- Keep positions dense.
  UPDATE public.room_media_queue q
  SET position = ordered.new_position
  FROM (
    SELECT q2.id, (row_number() OVER (ORDER BY q2.position, q2.created_at) - 1)::integer AS new_position
    FROM public.room_media_queue q2 WHERE q2.room_id = v_item.room_id
  ) ordered
  WHERE q.id = ordered.id AND q.position <> ordered.new_position;
  RETURN true;
END;
$$;


--
-- Name: follows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.follows (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    follower_id uuid NOT NULL,
    following_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    responded_at timestamp with time zone,
    accepted_at timestamp with time zone,
    CONSTRAINT follows_not_self CHECK ((follower_id <> following_id)),
    CONSTRAINT follows_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text, 'cancelled'::text])))
);


--
-- Name: request_follow(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.request_follow(p_target_id uuid) RETURNS public.follows
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  current_user_id uuid := auth.uid();
  target_private boolean;
  follow_row public.follows;
  next_status text;
BEGIN
  IF current_user_id IS NULL OR current_user_id = p_target_id THEN
    RAISE EXCEPTION 'Invalid follow target.';
  END IF;

  SELECT is_private INTO target_private FROM public.profiles WHERE id = p_target_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile not found.'; END IF;

  next_status := CASE WHEN target_private THEN 'pending' ELSE 'accepted' END;
  SELECT * INTO follow_row
  FROM public.follows
  WHERE follower_id = current_user_id AND following_id = p_target_id
  FOR UPDATE;

  IF FOUND AND follow_row.status = 'accepted' THEN RETURN follow_row; END IF;

  IF FOUND THEN
    UPDATE public.follows
    SET status = next_status,
        responded_at = CASE WHEN next_status = 'pending' THEN NULL ELSE now() END,
        accepted_at = CASE WHEN next_status = 'accepted' THEN COALESCE(accepted_at, now()) ELSE NULL END
    WHERE id = follow_row.id
    RETURNING * INTO follow_row;
  ELSE
    INSERT INTO public.follows (follower_id, following_id, status, responded_at, accepted_at)
    VALUES (
      current_user_id,
      p_target_id,
      next_status,
      CASE WHEN next_status = 'pending' THEN NULL ELSE now() END,
      CASE WHEN next_status = 'accepted' THEN now() ELSE NULL END
    )
    RETURNING * INTO follow_row;
  END IF;
  RETURN follow_row;
END;
$$;


--
-- Name: friend_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.friend_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    requester_id uuid NOT NULL,
    recipient_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    responded_at timestamp with time zone,
    responded_by uuid,
    CONSTRAINT friend_requests_not_self CHECK ((requester_id <> recipient_id)),
    CONSTRAINT friend_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text, 'cancelled'::text])))
);


--
-- Name: request_friend(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.request_friend(p_recipient_id uuid) RETURNS public.friend_requests
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE request_row public.friend_requests;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() = p_recipient_id THEN
    RAISE EXCEPTION 'Invalid friend request target.';
  END IF;
  IF public.is_current_friend(auth.uid(), p_recipient_id) THEN
    RAISE EXCEPTION 'You are already friends.';
  END IF;
  SELECT * INTO request_row
  FROM public.friend_requests
  WHERE status = 'pending'
    AND ((requester_id = auth.uid() AND recipient_id = p_recipient_id)
      OR (requester_id = p_recipient_id AND recipient_id = auth.uid()))
  LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'A friend request is already pending.'; END IF;

  INSERT INTO public.friend_requests (requester_id, recipient_id)
  VALUES (auth.uid(), p_recipient_id)
  RETURNING * INTO request_row;
  RETURN request_row;
END;
$$;


--
-- Name: request_room_join(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.request_room_join(p_identifier text) RETURNS TABLE(room_id uuid, status text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  room_row public.rooms;
  existing_status text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT r.*
  INTO room_row
  FROM public.rooms AS r
  WHERE lower(r.username) = lower(trim(leading '@' FROM p_identifier))
     OR r.id::text = trim(leading '@' FROM p_identifier)
  LIMIT 1;

  IF NOT FOUND OR NOT public.room_can_join(room_row.id, auth.uid()) THEN
    RAISE EXCEPTION 'Room is unavailable.';
  END IF;

  SELECT rm.join_status
  INTO existing_status
  FROM public.room_members AS rm
  WHERE rm.room_id = room_row.id
    AND rm.user_id = auth.uid();

  IF FOUND THEN
    RETURN QUERY SELECT room_row.id, existing_status;
    RETURN;
  END IF;

  INSERT INTO public.room_members(room_id, user_id, role, join_status)
  VALUES (
    room_row.id,
    auth.uid(),
    'member',
    CASE WHEN room_row.is_private THEN 'pending' ELSE 'approved' END
  );

  PERFORM public.record_room_control_event(
    room_row.id,
    'membership_changed',
    auth.uid(),
    jsonb_build_object('status', CASE WHEN room_row.is_private THEN 'pending' ELSE 'approved' END)
  );

  RETURN QUERY
  SELECT room_row.id,
         CASE WHEN room_row.is_private THEN 'pending'::text ELSE 'approved'::text END;
END;
$$;


--
-- Name: request_room_recording(uuid, uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.request_room_recording(p_room_id uuid, p_participants uuid[]) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_participants uuid[];
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.room_has_capability(p_room_id, auth.uid(), 'manage_members')
     OR NOT public.room_has_capability(p_room_id, auth.uid(), 'chat') THEN
    RAISE EXCEPTION 'Only the owner or a member manager can ask to record.' USING ERRCODE = '42501';
  END IF;
  SELECT array_agg(DISTINCT u) INTO v_participants
  FROM unnest(array_append(COALESCE(p_participants, ARRAY[]::uuid[]), auth.uid())) AS t(u)
  WHERE u IS NOT NULL;
  IF cardinality(v_participants) > 12 THEN
    RAISE EXCEPTION 'A recording can include at most 12 participants.' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_participants) u WHERE NOT public.room_member_can(p_room_id, u, 'chat')) THEN
    RAISE EXCEPTION 'Every participant must be a member who can use voice.' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.room_recordings r WHERE r.room_id = p_room_id AND r.status IN ('consent', 'recording')) THEN
    RAISE EXCEPTION 'A recording is already pending or running in this room.' USING ERRCODE = '23505';
  END IF;
  INSERT INTO public.room_recordings (room_id, requested_by, participants)
  VALUES (p_room_id, auth.uid(), v_participants)
  RETURNING id INTO v_id;
  INSERT INTO public.room_recording_consents (recording_id, room_id, user_id, decision)
  VALUES (v_id, p_room_id, auth.uid(), 'granted');
  IF cardinality(v_participants) = 1 THEN
    UPDATE public.room_recordings SET status = 'recording', started_at = now() WHERE id = v_id;
  END IF;
  RETURN v_id;
END;
$$;


--
-- Name: respond_room_recording(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.respond_room_recording(p_recording_id uuid, p_granted boolean) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_row public.room_recordings%ROWTYPE;
  v_granted integer;
BEGIN
  SELECT * INTO v_row FROM public.room_recordings r WHERE r.id = p_recording_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR p_granted IS NULL OR NOT (auth.uid() = ANY (v_row.participants))
     OR NOT public.room_has_capability(v_row.room_id, auth.uid(), 'chat') THEN
    RAISE EXCEPTION 'Only listed participants can answer this recording request.' USING ERRCODE = '42501';
  END IF;
  IF v_row.status <> 'consent' THEN
    RAISE EXCEPTION 'This recording request is no longer waiting for consent.' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.room_recording_consents (recording_id, room_id, user_id, decision)
  VALUES (p_recording_id, v_row.room_id, auth.uid(), CASE WHEN p_granted THEN 'granted' ELSE 'declined' END)
  ON CONFLICT (recording_id, user_id) DO UPDATE SET decision = EXCLUDED.decision, decided_at = now();
  IF NOT p_granted THEN
    UPDATE public.room_recordings SET status = 'cancelled', stopped_at = now() WHERE id = p_recording_id;
    RETURN 'cancelled';
  END IF;
  SELECT count(*) INTO v_granted FROM public.room_recording_consents c
  WHERE c.recording_id = p_recording_id AND c.decision = 'granted' AND c.user_id = ANY (v_row.participants);
  IF v_granted = cardinality(v_row.participants) THEN
    UPDATE public.room_recordings SET status = 'recording', started_at = now() WHERE id = p_recording_id;
    RETURN 'recording';
  END IF;
  RETURN 'consent';
END;
$$;


--
-- Name: respond_to_follow_request(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.respond_to_follow_request(p_follow_id uuid, p_decision text) RETURNS public.follows
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE follow_row public.follows;
BEGIN
  IF auth.uid() IS NULL OR p_decision NOT IN ('accepted', 'rejected') THEN
    RAISE EXCEPTION 'Invalid follow decision.';
  END IF;
  SELECT * INTO follow_row FROM public.follows WHERE id = p_follow_id FOR UPDATE;
  IF NOT FOUND OR follow_row.following_id <> auth.uid() OR follow_row.status <> 'pending' THEN
    RAISE EXCEPTION 'Follow request is not available.';
  END IF;
  UPDATE public.follows
  SET status = p_decision,
      responded_at = now(),
      accepted_at = CASE WHEN p_decision = 'accepted' THEN now() ELSE NULL END
  WHERE id = p_follow_id
  RETURNING * INTO follow_row;
  RETURN follow_row;
END;
$$;


--
-- Name: respond_to_friend_request(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.respond_to_friend_request(p_request_id uuid, p_decision text) RETURNS public.friend_requests
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  request_row public.friend_requests;
  low_user uuid;
  high_user uuid;
BEGIN
  IF auth.uid() IS NULL OR p_decision NOT IN ('accepted', 'rejected') THEN
    RAISE EXCEPTION 'Invalid friend decision.';
  END IF;

  SELECT * INTO request_row FROM public.friend_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR request_row.recipient_id <> auth.uid() OR request_row.status <> 'pending' THEN
    RAISE EXCEPTION 'Friend request is not available.';
  END IF;

  UPDATE public.friend_requests
  SET status = p_decision, responded_at = now(), responded_by = auth.uid()
  WHERE id = p_request_id
  RETURNING * INTO request_row;

  IF p_decision = 'accepted' THEN
    low_user := LEAST(request_row.requester_id, request_row.recipient_id);
    high_user := GREATEST(request_row.requester_id, request_row.recipient_id);
    INSERT INTO public.friendships (user_one, user_two)
    VALUES (low_user, high_user)
    ON CONFLICT (user_one, user_two) DO NOTHING;

    INSERT INTO public.follows (follower_id, following_id, status, responded_at, accepted_at)
    VALUES
      (request_row.requester_id, request_row.recipient_id, 'accepted', now(), now()),
      (request_row.recipient_id, request_row.requester_id, 'accepted', now(), now())
    ON CONFLICT (follower_id, following_id) DO UPDATE
      SET status = 'accepted', responded_at = now(), accepted_at = COALESCE(public.follows.accepted_at, now());
  END IF;
  RETURN request_row;
END;
$$;


--
-- Name: restore_study_note_version(uuid, bigint, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.restore_study_note_version(p_note_id uuid, p_version bigint, p_expected_version bigint) RETURNS public.study_notes
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_row public.study_note_versions%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.study_note_versions v WHERE v.note_id = p_note_id AND v.version = p_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That version is no longer available.' USING ERRCODE = 'P0002';
  END IF;
  -- update_study_note re-checks access, the lock and the expected version.
  RETURN public.update_study_note(p_note_id, p_expected_version, v_row.title, v_row.content);
END;
$$;


--
-- Name: room_permanent_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_permanent_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    room_id uuid NOT NULL,
    requester_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    reviewed_at timestamp with time zone,
    reviewed_by uuid,
    CONSTRAINT room_permanent_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);


--
-- Name: TABLE room_permanent_requests; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.room_permanent_requests IS 'Controlled permanence requests available during an approved recovery reopen period.';


--
-- Name: review_permanent_room_request(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.review_permanent_room_request(p_request_id uuid, p_decision text) RETURNS public.room_permanent_requests
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  request_row public.room_permanent_requests;
  recipient record;
BEGIN
  IF auth.uid() IS NULL OR p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Unauthorized permanent-room decision.';
  END IF;

  SELECT rpr.*
  INTO request_row
  FROM public.room_permanent_requests rpr
  WHERE rpr.id = p_request_id
  FOR UPDATE;

  IF NOT FOUND
     OR request_row.status <> 'pending'
     OR NOT public.room_has_active_access(request_row.room_id)
     OR NOT EXISTS (
       SELECT 1
       FROM public.rooms r
       WHERE r.id = request_row.room_id
         AND r.expiration_type = 'recoverable'
         AND r.reopened_until IS NOT NULL
         AND r.reopened_until > now()
     )
     OR NOT public.is_room_admin_or_owner(request_row.room_id, auth.uid()) THEN
    RAISE EXCEPTION 'Permanent-room request is not available for this reviewer.';
  END IF;

  UPDATE public.room_permanent_requests
  SET status = p_decision,
      reviewed_at = now(),
      reviewed_by = auth.uid()
  WHERE id = p_request_id
  RETURNING * INTO request_row;

  IF p_decision = 'approved' THEN
    PERFORM set_config('app.omnilume_lifecycle_authorized', 'permanent_conversion', true);
    UPDATE public.rooms
    SET expiration_type = 'permanent',
        expires_at = NULL,
        reopened_until = NULL
    WHERE id = request_row.room_id;

    FOR recipient IN
      SELECT DISTINCT recipients.user_id
      FROM (
        SELECT rm.user_id FROM public.room_members rm WHERE rm.room_id = request_row.room_id AND rm.join_status = 'approved'
        UNION SELECT m.sender_id FROM public.messages m WHERE m.room_id = request_row.room_id
        UNION SELECT m.receiver_id FROM public.messages m WHERE m.room_id = request_row.room_id AND m.receiver_id IS NOT NULL
        UNION SELECT rm2.user_id FROM public.room_messages rm2 WHERE rm2.room_id = request_row.room_id
        UNION SELECT ss.user_id FROM public.study_sessions ss WHERE ss.room_id = request_row.room_id AND ss.user_id IS NOT NULL
        UNION SELECT tm.user_id FROM public.temporary_media tm WHERE tm.room_id = request_row.room_id AND tm.user_id IS NOT NULL
      ) recipients
      WHERE recipients.user_id IS NOT NULL
    LOOP
      PERFORM public.enqueue_room_notification(
        recipient.user_id, request_row.room_id, 'permanent_conversion',
        public.notification_user_label(request_row.requester_id) || ' requested this room to become permanent. The request was approved, and the room is now permanent and available indefinitely.',
        jsonb_build_object('requester_id', request_row.requester_id, 'request_id', request_row.id, 'status', 'permanent'),
        auth.uid(), request_row.id, 'permanent_conversion:' || request_row.room_id::text
      );
    END LOOP;
  END IF;

  RETURN request_row;
END;
$$;


--
-- Name: recovery_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recovery_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    room_id uuid NOT NULL,
    requester_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    reviewed_at timestamp with time zone,
    reviewed_by uuid,
    CONSTRAINT recovery_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);


--
-- Name: TABLE recovery_requests; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.recovery_requests IS 'Persistent recovery requests for expired recoverable rooms; processed by authorized room owners/admins.';


--
-- Name: review_recovery_request(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.review_recovery_request(p_request_id uuid, p_decision text) RETURNS public.recovery_requests
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  request_row public.recovery_requests;
  room_row public.rooms;
BEGIN
  IF auth.uid() IS NULL OR p_decision IS NULL OR p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Unauthorized recovery decision.' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_site_owner(auth.uid()) THEN
    RAISE EXCEPTION 'Only a site owner can review recovery requests.' USING ERRCODE = '42501';
  END IF;

  SELECT rr.* INTO request_row
  FROM public.recovery_requests rr
  WHERE rr.id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Recovery request not found.';
  END IF;

  IF request_row.status <> 'pending' THEN
    RAISE EXCEPTION 'This recovery request has already been reviewed.';
  END IF;

  IF request_row.created_at <= now() - interval '7 days' THEN
    RAISE EXCEPTION 'This recovery request lapsed after 7 days without a review.';
  END IF;

  SELECT r.* INTO room_row
  FROM public.rooms r
  WHERE r.id = request_row.room_id
  FOR UPDATE;

  IF NOT FOUND OR room_row.expiration_type <> 'recoverable' THEN
    RAISE EXCEPTION 'This room cannot be recovered.';
  END IF;

  IF NOT public.room_in_recovery_window(request_row.room_id) THEN
    RAISE EXCEPTION 'This room is no longer in its recovery window.';
  END IF;

  UPDATE public.recovery_requests
  SET status = p_decision,
      reviewed_at = now(),
      reviewed_by = auth.uid()
  WHERE id = p_request_id
  RETURNING * INTO request_row;

  IF p_decision = 'approved' THEN
    PERFORM set_config('app.omnilume_lifecycle_authorized', 'recovery_approval', true);
    UPDATE public.rooms
    SET reopened_until = now() + interval '7 days'
    WHERE id = request_row.room_id
      AND expiration_type = 'recoverable';

    -- Everyone else who asked for this room gets the same answer.
    UPDATE public.recovery_requests
    SET status = 'approved',
        reviewed_at = now(),
        reviewed_by = auth.uid()
    WHERE room_id = request_row.room_id
      AND status = 'pending'
      AND id <> request_row.id;
  END IF;

  RETURN request_row;
END;
$$;


--
-- Name: review_room_member(uuid, uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.review_room_member(p_room_id uuid, p_target_user_id uuid, p_action text, p_reason text DEFAULT ''::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: revoke_room_invite(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.revoke_room_invite(p_invite_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE invite_row public.room_invites;
BEGIN
  SELECT * INTO invite_row FROM public.room_invites WHERE id = p_invite_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR NOT public.room_has_capability(invite_row.room_id, auth.uid(), 'manage_invites') THEN RAISE EXCEPTION 'Not authorized to revoke this invite.'; END IF;
  UPDATE public.room_invites SET revoked_at = now(), revoked_by = auth.uid() WHERE id = p_invite_id AND revoked_at IS NULL;
  PERFORM public.record_room_control_event(invite_row.room_id, 'invite_changed', NULL, jsonb_build_object('invite_id', p_invite_id, 'state', 'revoked'));
END;
$$;


--
-- Name: room_can_join(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.room_can_join(p_room_id uuid, p_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT
    (auth.uid() = p_user_id OR COALESCE(current_setting('request.jwt.claim.role', true), '') = 'service_role')
    AND public.room_lifecycle_state(p_room_id) IN ('active', 'reopened', 'permanent')
    AND NOT public.room_user_is_restricted(p_room_id, p_user_id);
$$;


--
-- Name: room_can_view_member(uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.room_can_view_member(p_room_id uuid, p_target_user_id uuid, p_viewer_id uuid) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
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


--
-- Name: room_feature_enabled(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.room_feature_enabled(p_room_id uuid, p_feature text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT COALESCE((s.feature_flags ->> p_feature)::boolean, false)
  FROM public.room_control_settings s WHERE s.room_id = p_room_id;
$$;


--
-- Name: room_file_owned_by_caller(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.room_file_owned_by_caller(p_bucket text, p_object_path text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT auth.uid() IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.room_files rf
       WHERE rf.storage_bucket = p_bucket
         AND rf.object_path = p_object_path
         AND rf.owner_id = auth.uid()
         AND rf.deleted_at IS NULL
     );
$$;


--
-- Name: room_has_active_access(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.room_has_active_access(p_room_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT public.room_lifecycle_state(p_room_id) IN ('active', 'reopened', 'permanent', 'locked');
$$;


--
-- Name: room_has_capability(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.room_has_capability(p_room_id uuid, p_user_id uuid, p_capability text) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: room_in_recovery_window(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.room_in_recovery_window(p_room_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT public.room_lifecycle_state(p_room_id) = 'recovery-window';
$$;


--
-- Name: room_lifecycle_state(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.room_lifecycle_state(p_room_id uuid) RETURNS text
    LANGUAGE plpgsql STABLE SECURITY DEFINER
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
    IF room_row.deletion_scheduled_at IS NOT NULL AND room_row.deletion_scheduled_at <= now() THEN
      RETURN 'destroyed';
    END IF;
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
     AND (
       now() <= room_row.expires_at + interval '7 days'
       OR EXISTS (
         SELECT 1
         FROM public.recovery_requests rr
         WHERE rr.room_id = p_room_id
           AND rr.status = 'pending'
           AND rr.created_at > now() - interval '7 days'
       )
     ) THEN
    RETURN 'recovery-window';
  END IF;

  RETURN 'destroyed';
END;
$$;


--
-- Name: room_media_is_live(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.room_media_is_live(p_room_id uuid, p_media_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.temporary_media tm
    WHERE tm.id = p_media_id AND tm.room_id = p_room_id AND tm.expires_at > now()
  );
$$;


--
-- Name: room_member_can(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.room_member_can(p_room_id uuid, p_user_id uuid, p_capability text) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_role text;
  v_feature text;
BEGIN
  IF p_room_id IS NULL OR p_user_id IS NULL OR NOT public.room_has_active_access(p_room_id) THEN
    RETURN false;
  END IF;
  v_feature := CASE p_capability
    WHEN 'chat' THEN 'chat' WHEN 'watch' THEN 'watch' WHEN 'watch_control' THEN 'watch'
    WHEN 'files' THEN 'files' WHEN 'study' THEN 'study'
    WHEN 'manage_announcements' THEN 'announcements' ELSE NULL END;
  IF v_feature IS NOT NULL AND NOT public.room_feature_enabled(p_room_id, v_feature) THEN
    RETURN false;
  END IF;
  v_role := public.room_user_role(p_room_id, p_user_id);
  IF v_role IS NULL THEN RETURN false; END IF;
  IF v_role = 'owner' THEN RETURN true; END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.room_role_permissions p
    WHERE p.room_id = p_room_id AND p.role = v_role AND p.capability = p_capability AND p.allowed
  );
END;
$$;


--
-- Name: room_message_reaction_summary(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.room_message_reaction_summary(p_message_id uuid) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT COALESCE(jsonb_object_agg(grouped.emoji, jsonb_build_object('count', grouped.total, 'users', grouped.users)), '{}'::jsonb)
  FROM (
    SELECT r.emoji,
           count(*) AS total,
           (SELECT jsonb_agg(first.user_id ORDER BY first.created_at, first.user_id)
              FROM (SELECT r2.user_id, r2.created_at FROM public.room_message_reactions r2
                    WHERE r2.message_id = p_message_id AND r2.emoji = r.emoji
                    ORDER BY r2.created_at, r2.user_id LIMIT 50) first) AS users
    FROM public.room_message_reactions r
    WHERE r.message_id = p_message_id
    GROUP BY r.emoji
  ) grouped;
$$;


--
-- Name: room_reaction_emojis(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.room_reaction_emojis() RETURNS text[]
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  SELECT ARRAY[U&'\+01F44D', U&'\2764\FE0F', U&'\+01F602', U&'\+01F389', U&'\+01F62E', U&'\+01F622', U&'\+01F525', U&'\+01F440']::text[];
$$;


--
-- Name: room_realtime_topic_room_id(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.room_realtime_topic_room_id(p_topic text) RETURNS uuid
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO ''
    AS $_$
BEGIN
  IF p_topic IS NULL
     OR p_topic !~ '^(sync|sync-chat|sync-study|sync-watch|sync-control|presence|presence-privileged):[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    RETURN NULL;
  END IF;

  RETURN split_part(p_topic, ':', 2)::uuid;
END;
$_$;


--
-- Name: room_recording_object_access(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.room_recording_object_access(p_name text, p_action text) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $_$
DECLARE
  v_match text[];
  v_row public.room_recordings%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR p_name IS NULL THEN RETURN false; END IF;
  v_match := regexp_match(p_name, '^([0-9a-f-]{36})/([0-9a-f-]{36})\.(webm|ogg|m4a)$');
  IF v_match IS NULL THEN RETURN false; END IF;
  SELECT * INTO v_row FROM public.room_recordings r WHERE r.id = v_match[2]::uuid AND r.room_id = v_match[1]::uuid;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_action = 'insert' THEN
    RETURN v_row.status = 'recording' AND v_row.requested_by = auth.uid()
      AND public.room_has_capability(v_row.room_id, auth.uid(), 'chat');
  ELSIF p_action = 'select' THEN
    RETURN v_row.status = 'stopped' AND public.can_view_room_recording(v_row.id);
  ELSIF p_action = 'delete' THEN
    RETURN v_row.status IN ('recording', 'stopped', 'cancelled', 'deleted')
      AND (v_row.requested_by = auth.uid() OR public.room_has_capability(v_row.room_id, auth.uid(), 'manage_members'));
  END IF;
  RETURN false;
END;
$_$;


--
-- Name: room_storage_path_kind(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.room_storage_path_kind(p_object_name text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO ''
    AS $$
DECLARE
  second_segment text;
BEGIN
  IF public.room_storage_path_room_id(p_object_name) IS NULL
     OR p_object_name IS NULL
     OR p_object_name LIKE '%..%'
     OR position('\\' IN p_object_name) > 0 THEN
    RETURN NULL;
  END IF;
  second_segment := split_part(p_object_name, '/', 2);
  IF second_segment IN ('files', 'media', 'subtitles') THEN
    RETURN second_segment;
  END IF;
  -- Existing Actions 01–08 objects used a direct room-prefix path. They are
  -- retained read-only for compatibility while Action 09 writes structured paths.
  RETURN 'legacy';
END;
$$;


--
-- Name: room_storage_path_room_id(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.room_storage_path_room_id(p_object_name text) RETURNS uuid
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO ''
    AS $_$
DECLARE
  candidate text;
BEGIN
  candidate := split_part(COALESCE(p_object_name, ''), '/', 1);
  IF candidate ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RETURN candidate::uuid;
  END IF;
  RETURN NULL;
END;
$_$;


--
-- Name: room_user_is_restricted(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.room_user_is_restricted(p_room_id uuid, p_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.room_member_restrictions r
    WHERE r.room_id = p_room_id AND r.user_id = p_user_id
      AND (r.expires_at IS NULL OR r.expires_at > now())
  );
$$;


--
-- Name: room_user_role(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.room_user_role(p_room_id uuid, p_user_id uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT rm.role FROM public.room_members rm
  WHERE rm.room_id = p_room_id AND rm.user_id = p_user_id
    AND rm.join_status = 'approved'
    AND (rm.guest_expires_at IS NULL OR rm.guest_expires_at > now())
    AND NOT public.room_user_is_restricted(p_room_id, p_user_id)
  LIMIT 1;
$$;


--
-- Name: save_resource_progress(uuid, numeric, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.save_resource_progress(p_resource_id uuid, p_position numeric, p_duration numeric DEFAULT NULL::numeric) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_room uuid;
BEGIN
  SELECT r.room_id INTO v_room FROM public.room_study_resources r WHERE r.id = p_resource_id;
  IF v_room IS NULL OR auth.uid() IS NULL OR NOT public.room_has_capability(v_room, auth.uid(), 'study') THEN
    RAISE EXCEPTION 'Not authorized to save progress for this resource.' USING ERRCODE = '42501';
  END IF;
  IF p_position IS NULL OR p_position < 0 OR p_position > 86400
     OR (p_duration IS NOT NULL AND (p_duration <= 0 OR p_duration > 86400)) THEN
    RAISE EXCEPTION 'Invalid playback position.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.room_resource_progress (resource_id, room_id, user_id, position_seconds, duration_seconds, updated_at)
  VALUES (p_resource_id, v_room, auth.uid(), p_position, p_duration, now())
  ON CONFLICT (resource_id, user_id) DO UPDATE
  SET position_seconds = EXCLUDED.position_seconds,
      duration_seconds = COALESCE(EXCLUDED.duration_seconds, public.room_resource_progress.duration_seconds),
      updated_at = now();
END;
$$;


--
-- Name: save_room_template(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.save_room_template(p_room_id uuid, p_name text, p_description text DEFAULT ''::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_room public.rooms%ROWTYPE;
  v_settings public.room_control_settings%ROWTYPE;
  v_id uuid;
BEGIN
  IF v_uid IS NULL OR NOT public.room_has_capability(p_room_id, v_uid, 'manage_settings') THEN
    RAISE EXCEPTION 'Only members who manage room settings can save a template.' USING ERRCODE = '42501';
  END IF;
  IF char_length(COALESCE(btrim(p_name), '')) NOT BETWEEN 1 AND 60 OR char_length(COALESCE(p_description, '')) > 200 THEN
    RAISE EXCEPTION 'Give the template a name of up to 60 characters.' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM public.room_templates t WHERE t.owner_id = v_uid) >= 20 THEN
    RAISE EXCEPTION 'You can keep up to 20 templates.' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_room FROM public.rooms r WHERE r.id = p_room_id;
  SELECT * INTO v_settings FROM public.room_control_settings s WHERE s.room_id = p_room_id;
  IF NOT FOUND OR v_room.id IS NULL THEN
    RAISE EXCEPTION 'That room is not available.' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.room_templates (owner_id, name, description, config)
  VALUES (v_uid, btrim(p_name), COALESCE(p_description, ''), jsonb_build_object(
    'is_private', v_room.is_private,
    'expiration_type', v_room.expiration_type,
    'duration_hours', CASE WHEN v_room.expiration_type = 'permanent' OR v_room.expires_at IS NULL THEN NULL
      ELSE LEAST(720, GREATEST(1, round(extract(epoch FROM (v_room.expires_at - v_room.created_at)) / 3600)))::integer END,
    'default_layout', v_settings.default_layout,
    'theme', v_settings.theme,
    'rules', v_settings.rules,
    'welcome_message', v_settings.welcome_message,
    'feature_flags', v_settings.feature_flags))
  RETURNING id INTO v_id;
  RETURN v_id;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'You already have a template with that name.' USING ERRCODE = '23505';
END;
$$;


--
-- Name: save_room_transcript(uuid, bigint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.save_room_transcript(p_recording_id uuid, p_expected_version bigint, p_body text) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_row public.room_recordings%ROWTYPE;
  v_version bigint;
BEGIN
  SELECT * INTO v_row FROM public.room_recordings r WHERE r.id = p_recording_id;
  IF NOT FOUND OR NOT public.can_view_room_recording(p_recording_id) THEN
    RAISE EXCEPTION 'Only participants can edit this transcript.' USING ERRCODE = '42501';
  END IF;
  IF v_row.status <> 'stopped' OR char_length(COALESCE(p_body, '')) > 200000 THEN
    RAISE EXCEPTION 'Transcripts can be written for finished recordings (200000 characters).' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_expected_version, 0) = 0 THEN
    INSERT INTO public.room_recording_transcripts (recording_id, room_id, body, updated_by)
    VALUES (p_recording_id, v_row.room_id, COALESCE(p_body, ''), auth.uid())
    ON CONFLICT (recording_id) DO NOTHING
    RETURNING version INTO v_version;
  ELSE
    UPDATE public.room_recording_transcripts
    SET body = COALESCE(p_body, ''), version = version + 1, updated_by = auth.uid(), updated_at = now()
    WHERE recording_id = p_recording_id AND version = p_expected_version
    RETURNING version INTO v_version;
  END IF;
  IF v_version IS NULL THEN
    RAISE EXCEPTION 'Transcript update rejected: expected version does not match.' USING ERRCODE = '23514';
  END IF;
  RETURN v_version;
END;
$$;


--
-- Name: save_room_whiteboard(uuid, bigint, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.save_room_whiteboard(p_room_id uuid, p_expected_version bigint, p_state jsonb) RETURNS public.room_whiteboards
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE board_row public.room_whiteboards%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.room_has_capability(p_room_id, auth.uid(), 'study')
     OR p_expected_version IS NULL OR p_expected_version < 0
     OR p_state IS NULL OR jsonb_typeof(p_state) <> 'object'
     OR octet_length(convert_to(p_state::text, 'UTF8')) > 524288 THEN
    RAISE EXCEPTION 'Invalid or unauthorized whiteboard update.';
  END IF;

  SELECT * INTO board_row FROM public.room_whiteboards rw WHERE rw.room_id = p_room_id FOR UPDATE;
  IF NOT FOUND THEN
    IF p_expected_version <> 0 THEN RAISE EXCEPTION 'Whiteboard update rejected: expected version does not match.'; END IF;
    INSERT INTO public.room_whiteboards(room_id, state, version, updated_by)
    VALUES (p_room_id, p_state, 1, auth.uid())
    RETURNING * INTO board_row;
    RETURN board_row;
  END IF;
  IF board_row.version <> p_expected_version THEN
    RAISE EXCEPTION 'Whiteboard update rejected: expected version does not match.';
  END IF;
  UPDATE public.room_whiteboards
  SET state = p_state, version = version + 1, updated_by = auth.uid(), updated_at = now()
  WHERE room_id = p_room_id
  RETURNING * INTO board_row;
  RETURN board_row;
END;
$$;


--
-- Name: schedule_room_deletion(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.schedule_room_deletion(p_room_id uuid, p_grace_days integer DEFAULT 7) RETURNS timestamp with time zone
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
$$;


--
-- Name: search_room_history(uuid, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.search_room_history(p_room_id uuid, p_query text, p_limit integer DEFAULT 40) RETURNS TABLE(kind text, item_id uuid, title text, snippet text, created_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_query text := btrim(COALESCE(p_query, ''));
  v_pattern text;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 40), 1), 100);
  v_chat boolean;
  v_study boolean;
  v_watch boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT public.room_has_active_access(p_room_id) THEN
    RAISE EXCEPTION 'Not authorized to search this room.' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_query) NOT BETWEEN 2 AND 100 THEN
    RAISE EXCEPTION 'Search for 2 to 100 characters.' USING ERRCODE = '22023';
  END IF;
  v_chat := public.room_has_capability(p_room_id, auth.uid(), 'chat');
  v_study := public.room_has_capability(p_room_id, auth.uid(), 'study');
  v_watch := public.room_has_capability(p_room_id, auth.uid(), 'watch');
  IF NOT (v_chat OR v_study OR v_watch) THEN
    RAISE EXCEPTION 'Not authorized to search this room.' USING ERRCODE = '42501';
  END IF;
  v_pattern := '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  RETURN QUERY
  SELECT * FROM (
    SELECT 'message'::text, m.id, 'Chat message'::text, left(m.content, 240), m.created_at
    FROM public.messages m
    WHERE v_chat AND m.room_id = p_room_id AND COALESCE(m.is_deleted, false) = false
      AND m.content IS NOT NULL AND m.content ILIKE v_pattern
    UNION ALL
    SELECT 'note', n.id, n.title, left(n.content, 240), n.updated_at
    FROM public.study_notes n
    WHERE v_study AND n.room_id = p_room_id AND (n.scope = 'room' OR n.owner_id = auth.uid())
      AND (n.title ILIKE v_pattern OR n.content ILIKE v_pattern)
    UNION ALL
    SELECT 'task', t.id, t.title, left(t.details, 240), t.created_at
    FROM public.room_tasks t
    WHERE v_study AND t.room_id = p_room_id AND (t.title ILIKE v_pattern OR t.details ILIKE v_pattern)
    UNION ALL
    SELECT 'poll', p.id, p.question, array_to_string(p.options, ' · '), p.created_at
    FROM public.room_polls p
    WHERE v_chat AND p.room_id = p_room_id
      AND (p.question ILIKE v_pattern OR array_to_string(p.options, ' ') ILIKE v_pattern)
    UNION ALL
    SELECT 'event', e.id, e.title, left(e.details, 240), e.starts_at
    FROM public.room_events e
    WHERE v_chat AND e.room_id = p_room_id AND (e.title ILIKE v_pattern OR e.details ILIKE v_pattern)
    UNION ALL
    SELECT 'clip', c.id, c.label, NULL::text, c.created_at
    FROM public.room_media_clips c
    WHERE v_watch AND c.room_id = p_room_id AND c.label ILIKE v_pattern
    UNION ALL
    SELECT 'resource', r.id, r.title, NULL::text, r.created_at
    FROM public.room_study_resources r
    WHERE v_study AND r.room_id = p_room_id AND r.title ILIKE v_pattern
    UNION ALL
    SELECT 'resource_note', rn.id, 'Timestamped note'::text, left(rn.body, 240), rn.created_at
    FROM public.room_resource_notes rn
    WHERE v_study AND rn.room_id = p_room_id AND (rn.scope = 'room' OR rn.user_id = auth.uid())
      AND rn.body ILIKE v_pattern
    UNION ALL
    SELECT 'transcript', tr.recording_id, 'Recording transcript'::text, left(tr.body, 240), tr.updated_at
    FROM public.room_recording_transcripts tr
    JOIN public.room_recordings rec ON rec.id = tr.recording_id
    WHERE v_chat AND tr.room_id = p_room_id AND rec.status = 'stopped'
      AND public.can_view_room_recording(tr.recording_id) AND tr.body ILIKE v_pattern
  ) AS results (kind, item_id, title, snippet, created_at)
  ORDER BY results.created_at DESC
  LIMIT v_limit;
END;
$$;


--
-- Name: seed_room_controls(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.seed_room_controls(p_room_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: seed_room_controls_after_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.seed_room_controls_after_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  PERFORM public.seed_room_controls(NEW.id);
  RETURN NEW;
END;
$$;


--
-- Name: send_message_request(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.send_message_request(p_recipient_id uuid, p_message text) RETURNS public.message_requests
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  current_user_id uuid := auth.uid();
  clean_message text := btrim(p_message);
  request_row public.message_requests;
  is_connected boolean;
BEGIN
  IF current_user_id IS NULL OR current_user_id = p_recipient_id THEN
    RAISE EXCEPTION 'Invalid message request recipient.';
  END IF;
  IF char_length(clean_message) < 1 OR char_length(clean_message) > 200 THEN
    RAISE EXCEPTION 'Message requests must be 1-200 characters.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_recipient_id) THEN
    RAISE EXCEPTION 'Recipient profile not found.';
  END IF;
  IF public.is_current_friend(current_user_id, p_recipient_id) THEN
    RAISE EXCEPTION 'You are already friends with this member.';
  END IF;

  SELECT public.is_accepted_follower(current_user_id, p_recipient_id)
      OR public.is_accepted_follower(p_recipient_id, current_user_id)
    INTO is_connected;
  IF NOT is_connected THEN
    RAISE EXCEPTION 'You are not connected through a follow relationship.';
  END IF;

  -- If both sides start a request at the same time, keep the first pending
  -- request and let the recipient handle it instead of hitting the pair index.
  SELECT * INTO request_row
  FROM public.message_requests
  WHERE status = 'pending'
    AND (
      (requester_id = current_user_id AND recipient_id = p_recipient_id)
      OR (requester_id = p_recipient_id AND recipient_id = current_user_id)
    )
  LIMIT 1
  FOR UPDATE;
  IF FOUND THEN RETURN request_row; END IF;

  SELECT * INTO request_row
  FROM public.message_requests
  WHERE requester_id = current_user_id AND recipient_id = p_recipient_id
  FOR UPDATE;

  IF FOUND THEN
    IF request_row.status IN ('pending', 'accepted') THEN
      RETURN request_row;
    END IF;
  END IF;

  -- A rejected/cancelled request is history. A new attempt gets a new row so
  -- the tamper-prevention trigger can keep completed rows immutable.
  INSERT INTO public.message_requests (requester_id, recipient_id, message)
  VALUES (current_user_id, p_recipient_id, clean_message)
  RETURNING * INTO request_row;
  RETURN request_row;
END;
$$;


--
-- Name: set_event_rsvp(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_event_rsvp(p_event_id uuid, p_response text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_event public.room_events%ROWTYPE;
BEGIN
  SELECT * INTO v_event FROM public.room_events e WHERE e.id = p_event_id;
  IF v_uid IS NULL OR NOT FOUND OR NOT public.room_has_capability(v_event.room_id, v_uid, 'chat') THEN
    RAISE EXCEPTION 'You cannot respond to this event.' USING ERRCODE = '42501';
  END IF;
  IF p_response IS NULL THEN
    DELETE FROM public.room_event_rsvps WHERE event_id = p_event_id AND user_id = v_uid;
    RETURN;
  END IF;
  IF p_response NOT IN ('going', 'maybe', 'declined') THEN
    RAISE EXCEPTION 'Choose going, maybe or declined.' USING ERRCODE = '22023';
  END IF;
  IF v_event.cancelled_at IS NOT NULL OR COALESCE(v_event.ends_at, v_event.starts_at + interval '1 hour') < now() THEN
    RAISE EXCEPTION 'This event is no longer open for responses.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.room_event_rsvps (event_id, room_id, user_id, response)
  VALUES (p_event_id, v_event.room_id, v_uid, p_response)
  ON CONFLICT (event_id, user_id) DO UPDATE SET response = EXCLUDED.response, updated_at = now();
END;
$$;


--
-- Name: set_music_now_playing(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_music_now_playing(p_upload_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  IF p_upload_id IS NULL
     OR EXISTS (SELECT 1 FROM public.music_settings s WHERE s.user_id = uid AND s.presence = 'nobody') THEN
    DELETE FROM public.music_now_playing np WHERE np.user_id = uid;
    RETURN;
  END IF;
  IF NOT public.music_can_play(p_upload_id, uid) THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.music_now_playing (user_id, title, artist)
  SELECT uid, u.title, u.artist FROM public.music_uploads u WHERE u.id = p_upload_id
  ON CONFLICT (user_id) DO UPDATE SET title = EXCLUDED.title, artist = EXCLUDED.artist, updated_at = now();
END;
$$;


--
-- Name: set_music_presence(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_music_presence(p_presence text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  IF p_presence IS NULL OR p_presence NOT IN ('friends', 'nobody') THEN
    RAISE EXCEPTION 'Invalid setting.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.music_settings (user_id, presence) VALUES (uid, p_presence)
  ON CONFLICT (user_id) DO UPDATE SET presence = EXCLUDED.presence, updated_at = now();
  IF p_presence = 'nobody' THEN
    DELETE FROM public.music_now_playing np WHERE np.user_id = uid;
  END IF;
  RETURN p_presence;
END;
$$;


--
-- Name: notification_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_preferences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    room_id uuid,
    muted_until timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE notification_preferences; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.notification_preferences IS 'One row = notifications muted for the user: room_id NULL is global do-not-disturb, otherwise one room. muted_until NULL means until turned off.';


--
-- Name: set_notification_preference(uuid, boolean, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_notification_preference(p_room_id uuid, p_muted boolean, p_muted_until timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS public.notification_preferences
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  pref public.notification_preferences;
BEGIN
  IF auth.uid() IS NULL OR p_muted IS NULL THEN
    RAISE EXCEPTION 'Unauthorized notification preference.' USING ERRCODE = '42501';
  END IF;

  IF p_room_id IS NOT NULL AND public.room_user_role(p_room_id, auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'You can mute only rooms you belong to.' USING ERRCODE = '42501';
  END IF;

  IF p_muted_until IS NOT NULL AND (p_muted_until <= now() OR p_muted_until > now() + interval '366 days') THEN
    RAISE EXCEPTION 'Choose a mute end time within the next year.';
  END IF;

  IF NOT p_muted THEN
    DELETE FROM public.notification_preferences np
    WHERE np.user_id = auth.uid()
      AND np.room_id IS NOT DISTINCT FROM p_room_id;
    RETURN NULL;
  END IF;

  IF p_room_id IS NULL THEN
    INSERT INTO public.notification_preferences (user_id, room_id, muted_until, updated_at)
    VALUES (auth.uid(), NULL, p_muted_until, now())
    ON CONFLICT (user_id) WHERE room_id IS NULL
    DO UPDATE SET muted_until = EXCLUDED.muted_until, updated_at = now()
    RETURNING * INTO pref;
  ELSE
    INSERT INTO public.notification_preferences (user_id, room_id, muted_until, updated_at)
    VALUES (auth.uid(), p_room_id, p_muted_until, now())
    ON CONFLICT (user_id, room_id) WHERE room_id IS NOT NULL
    DO UPDATE SET muted_until = EXCLUDED.muted_until, updated_at = now()
    RETURNING * INTO pref;
  END IF;

  RETURN pref;
END;
$$;


--
-- Name: set_room_bookmark(uuid, text, uuid, boolean, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_room_bookmark(p_room_id uuid, p_kind text, p_entity_id uuid, p_saved boolean, p_note text DEFAULT ''::text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to save items.' USING ERRCODE = '42501';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('room', 'message', 'file') OR p_room_id IS NULL OR p_entity_id IS NULL
     OR char_length(COALESCE(p_note, '')) > 200 THEN
    RAISE EXCEPTION 'That item cannot be saved.' USING ERRCODE = '22023';
  END IF;

  IF NOT COALESCE(p_saved, true) THEN
    DELETE FROM public.room_bookmarks
    WHERE user_id = v_uid AND kind = p_kind AND entity_id = p_entity_id;
    RETURN false;
  END IF;

  IF NOT public.room_has_active_access(p_room_id) OR public.room_user_is_restricted(p_room_id, v_uid) THEN
    RAISE EXCEPTION 'That item is not available.' USING ERRCODE = '42501';
  END IF;

  IF p_kind = 'room' THEN
    IF p_entity_id <> p_room_id THEN
      RAISE EXCEPTION 'That item cannot be saved.' USING ERRCODE = '22023';
    END IF;
    IF NOT public.is_approved_room_member(p_room_id, v_uid) AND NOT EXISTS (
      SELECT 1 FROM public.rooms r WHERE r.id = p_room_id AND NOT r.is_private AND NOT r.is_group
    ) THEN
      RAISE EXCEPTION 'That room is not available.' USING ERRCODE = '42501';
    END IF;
  ELSIF p_kind = 'message' THEN
    IF NOT public.room_has_capability(p_room_id, v_uid, 'chat') OR NOT EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.id = p_entity_id AND m.room_id = p_room_id AND NOT COALESCE(m.is_deleted, false) AND m.content IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'That message is not available.' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF NOT public.room_has_capability(p_room_id, v_uid, 'files') OR NOT EXISTS (
      SELECT 1 FROM public.room_files f
      WHERE f.id = p_entity_id AND f.room_id = p_room_id AND f.retention_state = 'active'
    ) THEN
      RAISE EXCEPTION 'That file is not available.' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF (SELECT count(*) FROM public.room_bookmarks b WHERE b.user_id = v_uid) >= 200
     AND NOT EXISTS (SELECT 1 FROM public.room_bookmarks b WHERE b.user_id = v_uid AND b.kind = p_kind AND b.entity_id = p_entity_id) THEN
    RAISE EXCEPTION 'You can save up to 200 items.' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.room_bookmarks (user_id, room_id, kind, entity_id, note)
  VALUES (v_uid, p_room_id, p_kind, p_entity_id, COALESCE(p_note, ''))
  ON CONFLICT (user_id, kind, entity_id) DO UPDATE SET note = EXCLUDED.note;
  RETURN true;
END;
$$;


--
-- Name: set_room_ghost_mode(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_room_ghost_mode(p_room_id uuid, p_is_ghost_mode boolean) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
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


--
-- Name: set_room_member_role(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_room_member_role(p_room_id uuid, p_target_user_id uuid, p_role text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: set_room_message_pin(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_room_message_pin(p_message_id uuid, p_pinned boolean) RETURNS timestamp with time zone
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_room uuid;
  v_deleted boolean;
  v_pinned_at timestamptz;
  v_result timestamptz;
BEGIN
  IF v_uid IS NULL OR p_pinned IS NULL THEN
    RAISE EXCEPTION 'Sign in to pin messages.' USING ERRCODE = '42501';
  END IF;

  SELECT m.room_id, COALESCE(m.is_deleted, false), m.pinned_at INTO v_room, v_deleted, v_pinned_at
  FROM public.messages m WHERE m.id = p_message_id
  FOR UPDATE;
  IF NOT FOUND OR v_room IS NULL OR v_deleted THEN
    RAISE EXCEPTION 'Message not found.' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.room_has_capability(v_room, v_uid, 'manage_announcements')
     OR NOT public.room_has_capability(v_room, v_uid, 'chat') THEN
    RAISE EXCEPTION 'Only members who manage announcements can pin messages.' USING ERRCODE = '42501';
  END IF;

  IF p_pinned THEN
    IF v_pinned_at IS NOT NULL THEN RETURN v_pinned_at; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('room-message-pins:' || v_room::text, 0));
    IF (SELECT count(*) FROM public.messages m WHERE m.room_id = v_room AND m.pinned_at IS NOT NULL) >= 5 THEN
      RAISE EXCEPTION 'A room can pin up to 5 messages. Unpin one first.' USING ERRCODE = '23514';
    END IF;
    v_result := now();
  ELSE
    IF v_pinned_at IS NULL THEN RETURN NULL; END IF;
    v_result := NULL;
  END IF;

  PERFORM set_config('app.omnilume_message_authorized', 'pin', true);
  UPDATE public.messages
  SET pinned_at = v_result, pinned_by = CASE WHEN p_pinned THEN v_uid ELSE NULL END
  WHERE id = p_message_id;
  PERFORM set_config('app.omnilume_message_authorized', '', true);
  RETURN v_result;
END;
$$;


--
-- Name: set_room_role_permission(uuid, text, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_room_role_permission(p_room_id uuid, p_role text, p_capability text, p_allowed boolean) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.rooms WHERE id = p_room_id AND created_by = auth.uid()) THEN RAISE EXCEPTION 'Only the room owner can change granular permissions.'; END IF;
  IF p_role NOT IN ('admin','member','guest') OR p_capability NOT IN ('manage_members','manage_invites','manage_settings','manage_announcements','chat','watch','watch_control','files','study') THEN RAISE EXCEPTION 'Invalid room permission.'; END IF;
  UPDATE public.room_role_permissions SET allowed = p_allowed WHERE room_id = p_room_id AND role = p_role AND capability = p_capability;
  PERFORM public.record_room_control_event(p_room_id, 'settings_changed', NULL, jsonb_build_object('role', p_role, 'capability', p_capability));
END;
$$;


--
-- Name: set_room_task_done(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_room_task_done(p_task_id uuid, p_done boolean) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_task public.room_tasks%ROWTYPE;
BEGIN
  SELECT * INTO v_task FROM public.room_tasks t WHERE t.id = p_task_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR p_done IS NULL OR NOT public.room_has_capability(v_task.room_id, auth.uid(), 'study')
     OR (auth.uid() NOT IN (v_task.created_by, COALESCE(v_task.assignee_id, v_task.created_by))
         AND NOT public.room_has_capability(v_task.room_id, auth.uid(), 'manage_members')) THEN
    RAISE EXCEPTION 'Only the creator, the assignee or a room manager can complete this task.' USING ERRCODE = '42501';
  END IF;
  UPDATE public.room_tasks
  SET status = CASE WHEN p_done THEN 'done' ELSE 'open' END,
      completed_by = CASE WHEN p_done THEN auth.uid() ELSE NULL END,
      completed_at = CASE WHEN p_done THEN now() ELSE NULL END,
      updated_at = now()
  WHERE id = p_task_id;
END;
$$;


--
-- Name: set_room_voice_moderation(uuid, uuid, boolean, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_room_voice_moderation(p_room_id uuid, p_user_id uuid, p_audio_muted boolean, p_screen_blocked boolean) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_target_role text;
BEGIN
  IF auth.uid() IS NULL OR p_user_id IS NULL OR p_audio_muted IS NULL OR p_screen_blocked IS NULL
     OR NOT public.room_has_capability(p_room_id, auth.uid(), 'manage_members') THEN
    RAISE EXCEPTION 'Only the owner or a member manager can mute members.' USING ERRCODE = '42501';
  END IF;
  v_target_role := public.room_user_role(p_room_id, p_user_id);
  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'That person is not a member of this room.' USING ERRCODE = 'P0002';
  END IF;
  IF p_user_id = auth.uid() OR (v_target_role = 'owner' AND public.room_user_role(p_room_id, auth.uid()) <> 'owner') THEN
    RAISE EXCEPTION 'You cannot moderate this member.' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.room_voice_moderation (room_id, user_id, audio_muted, screen_blocked, updated_by, updated_at)
  VALUES (p_room_id, p_user_id, p_audio_muted, p_screen_blocked, auth.uid(), now())
  ON CONFLICT (room_id, user_id) DO UPDATE
  SET audio_muted = EXCLUDED.audio_muted, screen_blocked = EXCLUDED.screen_blocked,
      updated_by = EXCLUDED.updated_by, updated_at = now();
END;
$$;


--
-- Name: set_study_note_locked(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_study_note_locked(p_note_id uuid, p_locked boolean) RETURNS public.study_notes
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE note_row public.study_notes%ROWTYPE;
BEGIN
  SELECT * INTO note_row FROM public.study_notes sn WHERE sn.id = p_note_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR p_locked IS NULL
     OR NOT public.room_has_capability(note_row.room_id, auth.uid(), 'study')
     OR note_row.scope <> 'room'
     OR (note_row.owner_id <> auth.uid() AND NOT public.room_has_capability(note_row.room_id, auth.uid(), 'manage_members')) THEN
    RAISE EXCEPTION 'Only the author or a room manager can change read-only mode.' USING ERRCODE = '42501';
  END IF;
  UPDATE public.study_notes
  SET locked = p_locked, locked_by = CASE WHEN p_locked THEN auth.uid() ELSE NULL END
  WHERE id = p_note_id
  RETURNING * INTO note_row;
  RETURN note_row;
END;
$$;


--
-- Name: set_temporary_media_subtitle(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_temporary_media_subtitle(p_media_id uuid, p_subtitle_path text) RETURNS public.temporary_media
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
DECLARE
  media_row public.temporary_media%ROWTYPE;
BEGIN
  SELECT * INTO media_row FROM public.temporary_media tm WHERE tm.id = p_media_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL
     OR media_row.expires_at <= now()
     OR NOT public.room_has_capability(media_row.room_id, auth.uid(), 'watch_control')
     OR p_subtitle_path !~* ('^' || media_row.room_id::text || '/subtitles/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(vtt|srt)$') THEN
    RAISE EXCEPTION 'Invalid or unauthorized subtitle association.';
  END IF;

  UPDATE public.temporary_media
  SET subtitle_path = p_subtitle_path
  WHERE id = p_media_id
  RETURNING * INTO media_row;
  RETURN media_row;
END;
$_$;


--
-- Name: music_upload_shares; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.music_upload_shares (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    upload_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    target_kind text NOT NULL,
    target_id uuid NOT NULL,
    attested_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT music_upload_shares_target_kind_check CHECK ((target_kind = ANY (ARRAY['room'::text, 'group'::text])))
);


--
-- Name: share_music_upload(uuid, text, uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.share_music_upload(p_upload_id uuid, p_target_kind text, p_target_id uuid, p_attest boolean) RETURNS public.music_upload_shares
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  uid uuid := auth.uid();
  member_ok boolean;
  row_out public.music_upload_shares%ROWTYPE;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  IF p_attest IS NOT TRUE THEN
    RAISE EXCEPTION 'Confirm you have the right to share this file.' USING ERRCODE = '22023';
  END IF;
  IF p_target_kind IS NULL OR p_target_kind NOT IN ('room', 'group') OR p_target_id IS NULL THEN
    RAISE EXCEPTION 'Invalid share target.' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.music_uploads u
    WHERE u.id = p_upload_id AND u.owner_id = uid AND u.state = 'active' AND u.expires_at > now()
  ) THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  -- (An assignment, because plpgsql's IF … THEN parser stops at the CASE's first THEN.)
  member_ok := CASE p_target_kind
    WHEN 'room' THEN public.room_has_capability(p_target_id, uid, 'watch')
      AND NOT EXISTS (SELECT 1 FROM public.groups g WHERE g.source_room_id = p_target_id)
    ELSE public.is_group_member(p_target_id, uid) END;
  IF member_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  IF (SELECT count(*) FROM public.music_upload_shares s WHERE s.upload_id = p_upload_id) >= 20 THEN
    RAISE EXCEPTION 'An upload can be shared to at most 20 places.' USING ERRCODE = '54000';
  END IF;

  INSERT INTO public.music_upload_shares (upload_id, owner_id, target_kind, target_id)
  VALUES (p_upload_id, uid, p_target_kind, p_target_id)
  ON CONFLICT (upload_id, target_kind, target_id) DO UPDATE SET attested_at = now()
  RETURNING * INTO row_out;
  RETURN row_out;
END;
$$;


--
-- Name: toggle_room_message_reaction(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.toggle_room_message_reaction(p_message_id uuid, p_emoji text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_room uuid;
  v_deleted boolean;
  v_summary jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to react.' USING ERRCODE = '42501';
  END IF;
  IF p_emoji IS NULL OR NOT (p_emoji = ANY (public.room_reaction_emojis())) THEN
    RAISE EXCEPTION 'That reaction is not available.' USING ERRCODE = '22023';
  END IF;

  -- Locking the message serializes toggles, so the summary never loses one.
  SELECT m.room_id, COALESCE(m.is_deleted, false) INTO v_room, v_deleted
  FROM public.messages m WHERE m.id = p_message_id
  FOR UPDATE;
  IF NOT FOUND OR v_room IS NULL OR v_deleted THEN
    RAISE EXCEPTION 'Message not found.' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.room_has_capability(v_room, v_uid, 'chat') THEN
    RAISE EXCEPTION 'You cannot react in this room.' USING ERRCODE = '42501';
  END IF;

  -- Set before the DELETE so the statement trigger leaves the summary to us.
  PERFORM set_config('app.omnilume_message_authorized', 'reactions', true);
  DELETE FROM public.room_message_reactions
  WHERE message_id = p_message_id AND user_id = v_uid AND emoji = p_emoji;
  IF NOT FOUND THEN
    INSERT INTO public.room_message_reactions (message_id, room_id, user_id, emoji)
    VALUES (p_message_id, v_room, v_uid, p_emoji);
  END IF;

  v_summary := public.room_message_reaction_summary(p_message_id);
  UPDATE public.messages SET reaction_summary = v_summary WHERE id = p_message_id;
  PERFORM set_config('app.omnilume_message_authorized', '', true);
  RETURN v_summary;
END;
$$;


--
-- Name: touch_post_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_post_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


--
-- Name: transfer_room_ownership(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.transfer_room_ownership(p_room_id uuid, p_target_user_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
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


--
-- Name: unblock_user(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.unblock_user(p_user_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501'; END IF;
  DELETE FROM public.user_blocks WHERE blocker_id = auth.uid() AND blocked_id = p_user_id;
  RETURN FOUND;
END;
$$;


--
-- Name: unfollow_user(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.unfollow_user(p_target_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  DELETE FROM public.follows
  WHERE follower_id = auth.uid() AND following_id = p_target_id;
  RETURN FOUND;
END;
$$;


--
-- Name: unshare_music_upload(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.unshare_music_upload(p_share_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.music_upload_shares s WHERE s.id = p_share_id AND s.owner_id = auth.uid();
  RETURN FOUND;
END;
$$;


--
-- Name: update_music_upload_tags(uuid, text, text, text, text, integer, integer, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_music_upload_tags(p_upload_id uuid, p_title text DEFAULT NULL::text, p_artist text DEFAULT NULL::text, p_album text DEFAULT NULL::text, p_album_artist text DEFAULT NULL::text, p_track_no integer DEFAULT NULL::integer, p_year integer DEFAULT NULL::integer, p_add_cover boolean DEFAULT false) RETURNS public.music_uploads
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  uid uuid := auth.uid();
  row_in public.music_uploads%ROWTYPE;
  row_out public.music_uploads%ROWTYPE;
  cover text;
  cover_meta jsonb;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO row_in FROM public.music_uploads u WHERE u.id = p_upload_id FOR UPDATE;
  IF NOT FOUND OR row_in.owner_id <> uid OR row_in.state <> 'active' OR row_in.expires_at <= now() THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = '42501';
  END IF;
  IF (p_title IS NOT NULL AND char_length(btrim(p_title)) NOT BETWEEN 1 AND 200)
     OR char_length(COALESCE(p_artist, '')) > 200 OR char_length(COALESCE(p_album, '')) > 200
     OR char_length(COALESCE(p_album_artist, '')) > 200
     OR (p_track_no IS NOT NULL AND p_track_no NOT BETWEEN 1 AND 999)
     OR (p_year IS NOT NULL AND p_year NOT BETWEEN 1000 AND 9999) THEN
    RAISE EXCEPTION 'Invalid tags.' USING ERRCODE = '22023';
  END IF;

  IF p_add_cover IS TRUE THEN
    IF row_in.cover_path IS NOT NULL THEN
      RAISE EXCEPTION 'This upload already has artwork.' USING ERRCODE = '22023';
    END IF;
    cover := uid::text || '/' || p_upload_id::text || '.cover.jpg';
    SELECT o.metadata INTO cover_meta FROM storage.objects o
    WHERE o.bucket_id = 'music_uploads' AND o.name = cover AND o.owner_id = uid::text;
    IF cover_meta IS NULL OR cover_meta ->> 'mimetype' IS DISTINCT FROM 'image/jpeg'
       OR COALESCE((cover_meta ->> 'size')::bigint, 0) NOT BETWEEN 1 AND 2097152 THEN
      RAISE EXCEPTION 'The uploaded artwork was not found or does not match.' USING ERRCODE = '22023';
    END IF;
  END IF;

  UPDATE public.music_uploads SET
    title = COALESCE(btrim(p_title), title),
    artist = COALESCE(p_artist, artist),
    album = COALESCE(p_album, album),
    album_artist = COALESCE(p_album_artist, album_artist),
    track_no = COALESCE(p_track_no, track_no),
    year = COALESCE(p_year, year),
    cover_path = CASE WHEN p_add_cover IS TRUE THEN cover ELSE cover_path END
  WHERE id = p_upload_id
  RETURNING * INTO row_out;
  RETURN row_out;
END;
$$;


--
-- Name: update_room_announcement(uuid, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_room_announcement(p_announcement_id uuid, p_body text, p_is_pinned boolean) RETURNS public.room_announcements
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE announcement_row public.room_announcements;
BEGIN
  SELECT * INTO announcement_row FROM public.room_announcements WHERE id = p_announcement_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR NOT public.room_has_capability(announcement_row.room_id, auth.uid(), 'manage_announcements') THEN RAISE EXCEPTION 'Not authorized to update this announcement.'; END IF;
  UPDATE public.room_announcements SET body = p_body, is_pinned = p_is_pinned, updated_at = now() WHERE id = p_announcement_id RETURNING * INTO announcement_row;
  PERFORM public.record_room_control_event(announcement_row.room_id, 'announcement_changed', NULL, jsonb_build_object('announcement_id', p_announcement_id, 'state', 'updated'));
  RETURN announcement_row;
END;
$$;


--
-- Name: update_room_appearance(uuid, text, boolean, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_room_appearance(p_room_id uuid, p_default_layout text, p_layout_locked boolean, p_theme text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.room_has_capability(p_room_id, auth.uid(), 'manage_settings') THEN
    RAISE EXCEPTION 'Only members who manage room settings can change the layout and theme.' USING ERRCODE = '42501';
  END IF;
  IF p_default_layout IS NULL OR p_default_layout NOT IN ('balanced', 'stage', 'chat')
     OR p_theme IS NULL OR p_theme NOT IN ('violet', 'ocean', 'emerald', 'amber', 'rose', 'graphite')
     OR p_layout_locked IS NULL THEN
    RAISE EXCEPTION 'Choose a valid layout and theme.' USING ERRCODE = '22023';
  END IF;

  UPDATE public.room_control_settings settings
  SET default_layout = p_default_layout,
      layout_locked = p_layout_locked,
      theme = p_theme,
      updated_at = now(),
      updated_by = auth.uid()
  WHERE settings.room_id = p_room_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Room settings were not found.' USING ERRCODE = 'P0002';
  END IF;

  PERFORM public.record_room_control_event(p_room_id, 'settings_changed', NULL, jsonb_build_object('kind', 'appearance'));
  RETURN jsonb_build_object('default_layout', p_default_layout, 'layout_locked', p_layout_locked, 'theme', p_theme);
END;
$$;


--
-- Name: room_control_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_control_settings (
    room_id uuid NOT NULL,
    rules text DEFAULT ''::text NOT NULL,
    welcome_message text DEFAULT ''::text NOT NULL,
    is_locked boolean DEFAULT false NOT NULL,
    feature_flags jsonb DEFAULT '{"chat": true, "files": true, "study": true, "watch": true, "announcements": true}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    default_layout text DEFAULT 'balanced'::text NOT NULL,
    layout_locked boolean DEFAULT false NOT NULL,
    theme text DEFAULT 'violet'::text NOT NULL,
    CONSTRAINT room_control_feature_flags_check CHECK (((jsonb_typeof(feature_flags) = 'object'::text) AND (feature_flags ?& ARRAY['chat'::text, 'watch'::text, 'files'::text, 'study'::text, 'announcements'::text]) AND (jsonb_typeof((feature_flags -> 'chat'::text)) = 'boolean'::text) AND (jsonb_typeof((feature_flags -> 'watch'::text)) = 'boolean'::text) AND (jsonb_typeof((feature_flags -> 'files'::text)) = 'boolean'::text) AND (jsonb_typeof((feature_flags -> 'study'::text)) = 'boolean'::text) AND (jsonb_typeof((feature_flags -> 'announcements'::text)) = 'boolean'::text))),
    CONSTRAINT room_control_settings_default_layout_check CHECK ((default_layout = ANY (ARRAY['balanced'::text, 'stage'::text, 'chat'::text]))),
    CONSTRAINT room_control_settings_theme_check CHECK ((theme = ANY (ARRAY['violet'::text, 'ocean'::text, 'emerald'::text, 'amber'::text, 'rose'::text, 'graphite'::text])))
);


--
-- Name: update_room_controls(uuid, text, text, boolean, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_room_controls(p_room_id uuid, p_rules text DEFAULT NULL::text, p_welcome_message text DEFAULT NULL::text, p_is_locked boolean DEFAULT NULL::boolean, p_feature_flags jsonb DEFAULT NULL::jsonb) RETURNS public.room_control_settings
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: update_room_task(uuid, text, text, uuid, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_room_task(p_task_id uuid, p_title text, p_details text, p_assignee_id uuid, p_due_at timestamp with time zone) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_task public.room_tasks%ROWTYPE;
BEGIN
  SELECT * INTO v_task FROM public.room_tasks t WHERE t.id = p_task_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR NOT public.room_has_capability(v_task.room_id, auth.uid(), 'study')
     OR (auth.uid() NOT IN (v_task.created_by, COALESCE(v_task.assignee_id, v_task.created_by))
         AND NOT public.room_has_capability(v_task.room_id, auth.uid(), 'manage_members')) THEN
    RAISE EXCEPTION 'Only the creator, the assignee or a room manager can edit this task.' USING ERRCODE = '42501';
  END IF;
  IF char_length(COALESCE(btrim(p_title), '')) NOT BETWEEN 1 AND 200 OR char_length(COALESCE(p_details, '')) > 2000 THEN
    RAISE EXCEPTION 'A task needs a title (200 characters) and details up to 2000 characters.' USING ERRCODE = '22023';
  END IF;
  IF p_assignee_id IS NOT NULL AND NOT public.room_member_can(v_task.room_id, p_assignee_id, 'study') THEN
    RAISE EXCEPTION 'The assignee must be a member who can use Study.' USING ERRCODE = '22023';
  END IF;
  UPDATE public.room_tasks
  SET title = btrim(p_title), details = COALESCE(p_details, ''), assignee_id = p_assignee_id,
      due_at = p_due_at, updated_at = now()
  WHERE id = p_task_id;
END;
$$;


--
-- Name: update_study_note(uuid, bigint, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_study_note(p_note_id uuid, p_expected_version bigint, p_title text, p_content text) RETURNS public.study_notes
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE note_row public.study_notes%ROWTYPE;
BEGIN
  SELECT * INTO note_row FROM public.study_notes sn WHERE sn.id = p_note_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL
     OR NOT public.room_has_capability(note_row.room_id, auth.uid(), 'study')
     OR (note_row.scope = 'personal' AND note_row.owner_id <> auth.uid())
     OR p_expected_version IS NULL OR p_expected_version <> note_row.version
     OR char_length(COALESCE(btrim(p_title), '')) NOT BETWEEN 1 AND 160
     OR char_length(COALESCE(p_content, '')) > 100000 THEN
    RAISE EXCEPTION 'Study note update rejected: expected version does not match or access is denied.';
  END IF;
  IF note_row.locked AND note_row.owner_id <> auth.uid()
     AND NOT public.room_has_capability(note_row.room_id, auth.uid(), 'manage_members') THEN
    RAISE EXCEPTION 'This note is read-only.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.study_notes
  SET title = btrim(p_title), content = COALESCE(p_content, ''), version = version + 1,
      updated_at = now(), last_edited_by = auth.uid()
  WHERE id = p_note_id
  RETURNING * INTO note_row;
  RETURN note_row;
END;
$$;


--
-- Name: room_member_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_member_profiles (
    room_id uuid NOT NULL,
    user_id uuid NOT NULL,
    display_name text,
    avatar_url text,
    bio text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT room_member_profiles_lengths CHECK ((((display_name IS NULL) OR (char_length(display_name) <= 80)) AND ((avatar_url IS NULL) OR (char_length(avatar_url) <= 2048)) AND ((bio IS NULL) OR (char_length(bio) <= 280))))
);


--
-- Name: upsert_room_member_profile(uuid, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.upsert_room_member_profile(p_room_id uuid, p_display_name text DEFAULT NULL::text, p_avatar_url text DEFAULT NULL::text, p_bio text DEFAULT NULL::text) RETURNS public.room_member_profiles
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE profile_row public.room_member_profiles;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_approved_room_member(p_room_id, auth.uid()) THEN RAISE EXCEPTION 'Not authorized to update a room profile.'; END IF;
  INSERT INTO public.room_member_profiles(room_id,user_id,display_name,avatar_url,bio) VALUES(p_room_id,auth.uid(),p_display_name,p_avatar_url,p_bio)
  ON CONFLICT(room_id,user_id) DO UPDATE SET display_name = EXCLUDED.display_name, avatar_url = EXCLUDED.avatar_url, bio = EXCLUDED.bio, updated_at = now()
  RETURNING * INTO profile_row;
  RETURN profile_row;
END;
$$;


--
-- Name: upsert_room_realtime_snapshot(uuid, text, bigint, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.upsert_room_realtime_snapshot(p_room_id uuid, p_snapshot_type text, p_state_version bigint, p_payload jsonb) RETURNS TABLE(snapshot_type text, state_version bigint, updated_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
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


--
-- Name: validate_post_fields(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_post_fields() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.author_id IS DISTINCT FROM OLD.author_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Post ownership and creation time cannot change.';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
    RAISE EXCEPTION 'Deleted posts cannot be restored.';
  END IF;

  IF NEW.media_url IS NOT NULL
     AND NEW.media_url !~ '^(https://|/)' THEN
    RAISE EXCEPTION 'Post media must use a secure URL or an application path.';
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: validate_private_chat_creation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_private_chat_creation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.user_one = NEW.user_two THEN
    RAISE EXCEPTION 'Private chats require two different users.';
  END IF;
  IF COALESCE(current_setting('app.omnilume_message_accept', true), '') <> 'true' THEN
    IF NOT public.is_current_friend(NEW.user_one, NEW.user_two)
       AND NOT EXISTS (
         SELECT 1
         FROM public.message_requests mr
         WHERE mr.status = 'accepted'
           AND (
             (mr.requester_id = NEW.user_one AND mr.recipient_id = NEW.user_two)
             OR (mr.requester_id = NEW.user_two AND mr.recipient_id = NEW.user_one)
           )
       ) THEN
      RAISE EXCEPTION 'Private chats require an accepted friendship or an accepted message request.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: validate_profile_fields(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_profile_fields() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Profile identity cannot change.';
  END IF;

  IF NEW.username IS NOT NULL THEN
    NEW.username := lower(btrim(NEW.username));
    IF NEW.username !~ '^[a-z0-9][a-z0-9_.]{2,29}$' THEN
      RAISE EXCEPTION 'Username must be 3-30 lowercase letters, numbers, underscores, or dots.';
    END IF;
  END IF;

  IF NEW.date_of_birth IS NOT NULL AND NEW.date_of_birth > CURRENT_DATE THEN
    RAISE EXCEPTION 'Date of birth cannot be in the future.';
  END IF;

  IF NEW.avatar_url IS NOT NULL AND NEW.avatar_url !~ '^(https://|/)' THEN
    RAISE EXCEPTION 'Profile picture must use a secure URL or an application path.';
  END IF;

  NEW.profile_details_completed := (
    NULLIF(btrim(COALESCE(NEW.display_name, '')), '') IS NOT NULL
    AND NEW.username IS NOT NULL
    AND NEW.date_of_birth IS NOT NULL
    AND NEW.gender IS NOT NULL
  );
  NEW.updated_at := now();
  RETURN NEW;
END;
$_$;


--
-- Name: validate_room_expiration(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_room_expiration() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.expiration_type = 'permanent' THEN
    IF NEW.expires_at IS NOT NULL THEN
      RAISE EXCEPTION 'Permanent rooms cannot have an expiration timestamp.';
    END IF;
  ELSIF NEW.expiration_type IN ('recoverable', 'irreversible') THEN
    IF NEW.expires_at IS NULL OR NEW.expires_at <= now() THEN
      RAISE EXCEPTION 'Temporary rooms require a future expiration timestamp.';
    END IF;
  ELSE
    RAISE EXCEPTION 'Invalid room expiration type.';
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: validate_room_schedule(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_room_schedule() RETURNS trigger
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


--
-- Name: vote_room_poll(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.vote_room_poll(p_poll_id uuid, p_option_index integer) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_poll public.room_polls%ROWTYPE;
BEGIN
  SELECT * INTO v_poll FROM public.room_polls p WHERE p.id = p_poll_id;
  IF NOT FOUND OR auth.uid() IS NULL OR NOT public.room_has_capability(v_poll.room_id, auth.uid(), 'chat') THEN
    RAISE EXCEPTION 'Not authorized to vote in this poll.' USING ERRCODE = '42501';
  END IF;
  IF v_poll.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'This poll is closed.' USING ERRCODE = '23514';
  END IF;
  IF p_option_index IS NULL OR p_option_index < 0 OR p_option_index >= cardinality(v_poll.options) THEN
    RAISE EXCEPTION 'Choose one of the poll options.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.room_poll_votes (poll_id, room_id, user_id, option_index)
  VALUES (p_poll_id, v_poll.room_id, auth.uid(), p_option_index)
  ON CONFLICT (poll_id, user_id) DO NOTHING;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'You have already voted in this poll.' USING ERRCODE = '23505';
  END IF;
END;
$$;


--
-- Name: conversation_reads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_reads (
    user_id uuid NOT NULL,
    chat_id uuid,
    group_id uuid,
    last_read_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT conversation_reads_one_target CHECK ((num_nonnulls(chat_id, group_id) = 1))
);


--
-- Name: friendships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.friendships (
    user_one uuid NOT NULL,
    user_two uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT friendships_normalized_pair CHECK ((user_one < user_two))
);


--
-- Name: group_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_members (
    group_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT group_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])))
);


--
-- Name: group_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    sender_id uuid NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT group_messages_content_length CHECK (((char_length(btrim(content)) >= 1) AND (char_length(btrim(content)) <= 4000)))
);


--
-- Name: groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    created_by uuid,
    source_room_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT groups_name_check CHECK ((char_length(btrim(name)) >= 1))
);


--
-- Name: message_reactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_reactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_id uuid NOT NULL,
    user_id uuid NOT NULL,
    emoji text NOT NULL,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    chat_id uuid,
    sender_id uuid NOT NULL,
    receiver_id uuid,
    ciphertext text,
    iv text,
    delivery_status text DEFAULT 'sent'::text,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    is_deleted boolean DEFAULT false,
    room_id uuid,
    content text,
    file_url text,
    edited_at timestamp with time zone,
    reply_to_id uuid,
    pinned_at timestamp with time zone,
    pinned_by uuid,
    reaction_summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT messages_delivery_status_check CHECK ((delivery_status = ANY (ARRAY['sent'::text, 'delivered'::text, 'read'::text]))),
    CONSTRAINT messages_not_reply_to_self_check CHECK (((reply_to_id IS NULL) OR (reply_to_id <> id))),
    CONSTRAINT messages_pinned_by_requires_pin_check CHECK (((pinned_by IS NULL) OR (pinned_at IS NOT NULL))),
    CONSTRAINT messages_reaction_summary_shape_check CHECK (((jsonb_typeof(reaction_summary) = 'object'::text) AND (octet_length((reaction_summary)::text) <= 32768))),
    CONSTRAINT messages_room_only_features_check CHECK (((room_id IS NOT NULL) OR ((edited_at IS NULL) AND (reply_to_id IS NULL) AND (pinned_at IS NULL) AND (pinned_by IS NULL) AND (reaction_summary = '{}'::jsonb))))
);


--
-- Name: music_custom_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.music_custom_sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id uuid DEFAULT auth.uid() NOT NULL,
    manifest_url text NOT NULL,
    name text NOT NULL,
    search_url text NOT NULL,
    health_url text,
    enabled boolean DEFAULT true NOT NULL,
    responsibility_accepted boolean NOT NULL,
    last_status text,
    last_message text,
    last_checked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT music_custom_sources_health_url_check CHECK (((health_url IS NULL) OR ((char_length(health_url) <= 500) AND ((health_url ~ '^https://[^/@\s]+(/\S*)?$'::text) OR (health_url ~ '^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?(/\S*)?$'::text))))),
    CONSTRAINT music_custom_sources_last_message_check CHECK ((char_length(last_message) <= 200)),
    CONSTRAINT music_custom_sources_last_status_check CHECK ((last_status = ANY (ARRAY['ok'::text, 'error'::text]))),
    CONSTRAINT music_custom_sources_manifest_url_check CHECK (((char_length(manifest_url) <= 500) AND ((manifest_url ~ '^https://[^/@\s]+(/\S*)?$'::text) OR (manifest_url ~ '^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?(/\S*)?$'::text)))),
    CONSTRAINT music_custom_sources_name_check CHECK (((char_length(btrim(name)) >= 1) AND (char_length(btrim(name)) <= 60))),
    CONSTRAINT music_custom_sources_responsibility_accepted_check CHECK (responsibility_accepted),
    CONSTRAINT music_custom_sources_search_url_check CHECK (((char_length(search_url) <= 500) AND (POSITION(('{query}'::text) IN (search_url)) > 0) AND ((search_url ~ '^https://[^/@\s]+(/\S*)?$'::text) OR (search_url ~ '^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?(/\S*)?$'::text))))
);


--
-- Name: music_listening_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.music_listening_history (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    upload_id uuid NOT NULL,
    played_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: music_listening_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.music_listening_history ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.music_listening_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: music_now_playing; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.music_now_playing (
    user_id uuid NOT NULL,
    title text NOT NULL,
    artist text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: music_playlist_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.music_playlist_items (
    playlist_id uuid NOT NULL,
    upload_id uuid NOT NULL,
    owner_id uuid DEFAULT auth.uid() NOT NULL,
    added_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: music_playlists; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.music_playlists (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id uuid DEFAULT auth.uid() NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT music_playlists_name_check CHECK (((char_length(btrim(name)) >= 1) AND (char_length(btrim(name)) <= 100)))
);


--
-- Name: music_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.music_settings (
    user_id uuid NOT NULL,
    presence text DEFAULT 'friends'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT music_settings_presence CHECK ((presence = ANY (ARRAY['friends'::text, 'nobody'::text])))
);


--
-- Name: posts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.posts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    author_id uuid NOT NULL,
    content text NOT NULL,
    media_url text,
    visibility text DEFAULT 'profile'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT posts_content_length_check CHECK (((char_length(content) >= 1) AND (char_length(content) <= 5000))),
    CONSTRAINT posts_media_url_length_check CHECK (((media_url IS NULL) OR (char_length(media_url) <= 2048))),
    CONSTRAINT posts_visibility_check CHECK ((visibility = ANY (ARRAY['profile'::text, 'public'::text, 'followers'::text])))
);


--
-- Name: private_chats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.private_chats (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_one uuid NOT NULL,
    user_two uuid NOT NULL,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    public_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    profile_completed boolean DEFAULT false NOT NULL,
    display_name text,
    username text,
    date_of_birth date,
    gender text,
    avatar_url text,
    bio text,
    is_private boolean DEFAULT true NOT NULL,
    profile_details_completed boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    profile_color text,
    CONSTRAINT profiles_avatar_url_length_check CHECK (((avatar_url IS NULL) OR (char_length(avatar_url) <= 2048))),
    CONSTRAINT profiles_bio_length_check CHECK (((bio IS NULL) OR (char_length(bio) <= 500))),
    CONSTRAINT profiles_display_name_length_check CHECK (((display_name IS NULL) OR ((char_length(display_name) >= 1) AND (char_length(display_name) <= 120)))),
    CONSTRAINT profiles_gender_check CHECK (((gender IS NULL) OR (gender = ANY (ARRAY['female'::text, 'male'::text, 'non_binary'::text, 'prefer_not_to_say'::text, 'other'::text])))),
    CONSTRAINT profiles_profile_color_check CHECK (((profile_color IS NULL) OR (profile_color = ANY (ARRAY['coral'::text, 'amber'::text, 'mint'::text, 'ocean'::text, 'orchid'::text, 'violet'::text]))))
);


--
-- Name: COLUMN profiles.profile_completed; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.profile_completed IS 'Whether the account has completed the current first-run identity gate; full profile fields are added by the Profiles action.';


--
-- Name: public_profiles; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.public_profiles AS
 SELECT id,
    username,
    display_name,
    avatar_url,
    bio,
    is_private,
    created_at,
    updated_at,
    profile_color
   FROM public.profiles p
  WHERE public.can_view_profile(id);


--
-- Name: room_activity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_activity (
    id bigint NOT NULL,
    room_id uuid NOT NULL,
    kind text NOT NULL,
    actor_id uuid,
    entity_id uuid,
    detail text,
    dedupe_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT room_activity_dedupe_key_check CHECK (((char_length(dedupe_key) >= 1) AND (char_length(dedupe_key) <= 200))),
    CONSTRAINT room_activity_detail_check CHECK (((detail IS NULL) OR (char_length(detail) <= 40))),
    CONSTRAINT room_activity_kind_check CHECK ((kind = ANY (ARRAY['member_joined'::text, 'member_left'::text, 'role_changed'::text, 'announcement'::text, 'file_shared'::text, 'poll_created'::text, 'event_scheduled'::text, 'task_created'::text, 'task_done'::text, 'note_created'::text, 'queue_added'::text, 'clip_saved'::text, 'group_converted'::text])))
);


--
-- Name: room_activity_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.room_activity ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.room_activity_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: room_bookmarks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_bookmarks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    room_id uuid NOT NULL,
    kind text NOT NULL,
    entity_id uuid NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT room_bookmarks_check CHECK (((kind <> 'room'::text) OR (entity_id = room_id))),
    CONSTRAINT room_bookmarks_kind_check CHECK ((kind = ANY (ARRAY['room'::text, 'message'::text, 'file'::text]))),
    CONSTRAINT room_bookmarks_note_check CHECK ((char_length(note) <= 200))
);


--
-- Name: room_cleanup_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_cleanup_jobs (
    room_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_attempt_at timestamp with time zone,
    CONSTRAINT room_cleanup_jobs_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT room_cleanup_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'failed'::text])))
);


--
-- Name: room_control_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_control_events (
    id bigint NOT NULL,
    room_id uuid NOT NULL,
    event_type text NOT NULL,
    actor_id uuid,
    subject_user_id uuid,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT room_control_events_event_type_check CHECK ((event_type = ANY (ARRAY['membership_changed'::text, 'role_changed'::text, 'invite_changed'::text, 'restriction_changed'::text, 'ownership_changed'::text, 'settings_changed'::text, 'lock_changed'::text, 'announcement_changed'::text, 'guest_changed'::text, 'feature_changed'::text, 'group_converted'::text])))
);


--
-- Name: room_control_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.room_control_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.room_control_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: room_countdowns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_countdowns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    room_id uuid NOT NULL,
    created_by uuid NOT NULL,
    label text NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    cancelled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT room_countdowns_check CHECK ((ends_at > created_at)),
    CONSTRAINT room_countdowns_label_check CHECK (((char_length(btrim(label)) >= 1) AND (char_length(btrim(label)) <= 120)))
);


--
-- Name: room_event_rsvps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_event_rsvps (
    event_id uuid NOT NULL,
    room_id uuid NOT NULL,
    user_id uuid NOT NULL,
    response text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT room_event_rsvps_response_check CHECK ((response = ANY (ARRAY['going'::text, 'maybe'::text, 'declined'::text])))
);


--
-- Name: room_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    room_id uuid NOT NULL,
    created_by uuid NOT NULL,
    title text NOT NULL,
    details text DEFAULT ''::text NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT room_events_check CHECK (((ends_at IS NULL) OR (ends_at >= starts_at))),
    CONSTRAINT room_events_details_check CHECK ((char_length(details) <= 2000)),
    CONSTRAINT room_events_title_check CHECK (((char_length(btrim(title)) >= 1) AND (char_length(btrim(title)) <= 160)))
);


--
-- Name: room_exports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_exports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    room_id uuid NOT NULL,
    requested_by uuid,
    counts jsonb DEFAULT '{}'::jsonb NOT NULL,
    truncated boolean DEFAULT false NOT NULL,
    sha256 text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT room_exports_sha256_check CHECK (((sha256 IS NULL) OR (sha256 ~ '^[0-9a-f]{64}$'::text)))
);


--
-- Name: room_group_conversions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_group_conversions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    room_id uuid NOT NULL,
    group_id uuid NOT NULL,
    converted_by uuid,
    status text DEFAULT 'completed'::text NOT NULL,
    member_count integer NOT NULL,
    content_refs jsonb DEFAULT '{}'::jsonb NOT NULL,
    resolved jsonb DEFAULT '{}'::jsonb NOT NULL,
    previous jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT room_group_conversions_content_refs_check CHECK ((jsonb_typeof(content_refs) = 'object'::text)),
    CONSTRAINT room_group_conversions_member_count_check CHECK ((member_count >= 1)),
    CONSTRAINT room_group_conversions_previous_check CHECK ((jsonb_typeof(previous) = 'object'::text)),
    CONSTRAINT room_group_conversions_resolved_check CHECK ((jsonb_typeof(resolved) = 'object'::text)),
    CONSTRAINT room_group_conversions_status_check CHECK ((status = 'completed'::text))
);


--
-- Name: room_hand_raises; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_hand_raises (
    room_id uuid NOT NULL,
    user_id uuid NOT NULL,
    raised_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: room_media_clips; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_media_clips (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    room_id uuid NOT NULL,
    media_id uuid NOT NULL,
    created_by uuid NOT NULL,
    start_seconds numeric(10,2) NOT NULL,
    end_seconds numeric(10,2),
    label text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT room_media_clips_check CHECK (((end_seconds IS NULL) OR ((end_seconds > start_seconds) AND (end_seconds <= (172800)::numeric)))),
    CONSTRAINT room_media_clips_label_check CHECK (((char_length(btrim(label)) >= 1) AND (char_length(btrim(label)) <= 120))),
    CONSTRAINT room_media_clips_start_seconds_check CHECK (((start_seconds >= (0)::numeric) AND (start_seconds <= (172800)::numeric)))
);


--
-- Name: room_media_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_media_queue (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    room_id uuid NOT NULL,
    media_id uuid NOT NULL,
    added_by uuid NOT NULL,
    "position" integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT room_media_queue_position_check CHECK (("position" >= 0))
);


--
-- Name: room_member_restrictions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_member_restrictions (
    room_id uuid NOT NULL,
    user_id uuid NOT NULL,
    restriction_type text NOT NULL,
    reason text DEFAULT ''::text NOT NULL,
    created_by uuid NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT room_member_restrictions_restriction_type_check CHECK ((restriction_type = ANY (ARRAY['ban'::text, 'block'::text])))
);


--
-- Name: room_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_members (
    room_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'member'::text,
    joined_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    join_status text DEFAULT 'approved'::text,
    guest_expires_at timestamp with time zone,
    is_ghost_mode boolean DEFAULT false NOT NULL,
    CONSTRAINT room_members_guest_expiry_check CHECK ((((role = 'guest'::text) AND (guest_expires_at IS NOT NULL) AND (guest_expires_at > joined_at)) OR ((role <> 'guest'::text) AND (guest_expires_at IS NULL)))),
    CONSTRAINT room_members_join_status_check CHECK ((join_status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text]))),
    CONSTRAINT room_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text, 'guest'::text])))
);


--
-- Name: room_message_reactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_message_reactions (
    message_id uuid NOT NULL,
    room_id uuid NOT NULL,
    user_id uuid NOT NULL,
    emoji text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT room_message_reactions_emoji_check CHECK ((emoji = ANY (public.room_reaction_emojis())))
);


--
-- Name: room_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    room_id uuid NOT NULL,
    user_id uuid NOT NULL,
    text text,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    gif_url text,
    file_url text,
    file_name text,
    file_type text,
    content text,
    file_size bigint
);


--
-- Name: room_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    room_id uuid NOT NULL,
    recipient_id uuid NOT NULL,
    notification_type text NOT NULL,
    message text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    read_at timestamp with time zone,
    actor_id uuid,
    entity_id uuid,
    dedupe_key text,
    CONSTRAINT room_notifications_dedupe_key_length CHECK (((dedupe_key IS NULL) OR ((char_length(dedupe_key) >= 1) AND (char_length(dedupe_key) <= 200)))),
    CONSTRAINT room_notifications_message_length CHECK (((char_length(message) >= 1) AND (char_length(message) <= 500))),
    CONSTRAINT room_notifications_type_allowed CHECK ((notification_type = ANY (ARRAY['mention'::text, 'reply'::text, 'announcement'::text, 'pdf_shared'::text, 'timer'::text, 'recovery_request'::text, 'recovery_decision'::text, 'access'::text, 'security'::text, 'permanent_conversion'::text, 'room_deletion'::text, 'task'::text, 'room_event'::text, 'group_conversion'::text]))),
    CONSTRAINT room_notifications_type_check CHECK ((notification_type <> ''::text))
);


--
-- Name: TABLE room_notifications; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.room_notifications IS 'Private in-app notifications addressed to users who used a room.';


--
-- Name: room_poll_votes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_poll_votes (
    poll_id uuid NOT NULL,
    room_id uuid NOT NULL,
    user_id uuid NOT NULL,
    option_index smallint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT room_poll_votes_option_index_check CHECK (((option_index >= 0) AND (option_index <= 9)))
);


--
-- Name: room_polls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_polls (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    room_id uuid NOT NULL,
    created_by uuid NOT NULL,
    question text NOT NULL,
    options text[] NOT NULL,
    closed_at timestamp with time zone,
    closed_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT room_polls_options_check CHECK (((cardinality(options) >= 2) AND (cardinality(options) <= 10))),
    CONSTRAINT room_polls_question_check CHECK (((char_length(btrim(question)) >= 1) AND (char_length(btrim(question)) <= 300)))
);


--
-- Name: room_read_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_read_states (
    room_id uuid NOT NULL,
    user_id uuid NOT NULL,
    last_read_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: room_realtime_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_realtime_snapshots (
    room_id uuid NOT NULL,
    snapshot_type text NOT NULL,
    state_version bigint NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid NOT NULL,
    CONSTRAINT room_realtime_snapshots_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT room_realtime_snapshots_snapshot_type_check CHECK ((snapshot_type = ANY (ARRAY['media'::text, 'timer'::text, 'settings'::text]))),
    CONSTRAINT room_realtime_snapshots_state_version_check CHECK ((state_version > 0))
);


--
-- Name: room_recording_consents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_recording_consents (
    recording_id uuid NOT NULL,
    room_id uuid NOT NULL,
    user_id uuid NOT NULL,
    decision text NOT NULL,
    decided_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT room_recording_consents_decision_check CHECK ((decision = ANY (ARRAY['granted'::text, 'declined'::text])))
);


--
-- Name: room_recording_transcripts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_recording_transcripts (
    recording_id uuid NOT NULL,
    room_id uuid NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT room_recording_transcripts_body_check CHECK ((char_length(body) <= 200000)),
    CONSTRAINT room_recording_transcripts_version_check CHECK ((version > 0))
);


--
-- Name: room_recordings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_recordings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    room_id uuid NOT NULL,
    requested_by uuid NOT NULL,
    status text DEFAULT 'consent'::text NOT NULL,
    participants uuid[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    stopped_at timestamp with time zone,
    storage_path text,
    duration_seconds integer,
    retention_until timestamp with time zone,
    CONSTRAINT room_recordings_duration_seconds_check CHECK (((duration_seconds IS NULL) OR ((duration_seconds >= 0) AND (duration_seconds <= 86400)))),
    CONSTRAINT room_recordings_participants_check CHECK (((cardinality(participants) >= 1) AND (cardinality(participants) <= 12))),
    CONSTRAINT room_recordings_status_check CHECK ((status = ANY (ARRAY['consent'::text, 'recording'::text, 'stopped'::text, 'cancelled'::text, 'deleted'::text]))),
    CONSTRAINT room_recordings_storage_path_check CHECK (((storage_path IS NULL) OR (storage_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(webm|ogg|m4a)$'::text)))
);


--
-- Name: room_resource_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_resource_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    resource_id uuid NOT NULL,
    room_id uuid NOT NULL,
    user_id uuid NOT NULL,
    at_seconds numeric NOT NULL,
    body text NOT NULL,
    scope text DEFAULT 'room'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT room_resource_notes_at_seconds_check CHECK (((at_seconds >= (0)::numeric) AND (at_seconds <= (86400)::numeric))),
    CONSTRAINT room_resource_notes_body_check CHECK (((char_length(btrim(body)) >= 1) AND (char_length(btrim(body)) <= 2000))),
    CONSTRAINT room_resource_notes_scope_check CHECK ((scope = ANY (ARRAY['room'::text, 'personal'::text])))
);


--
-- Name: room_resource_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_resource_progress (
    resource_id uuid NOT NULL,
    room_id uuid NOT NULL,
    user_id uuid NOT NULL,
    position_seconds numeric NOT NULL,
    duration_seconds numeric,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT room_resource_progress_duration_seconds_check CHECK (((duration_seconds IS NULL) OR ((duration_seconds > (0)::numeric) AND (duration_seconds <= (86400)::numeric)))),
    CONSTRAINT room_resource_progress_position_seconds_check CHECK (((position_seconds >= (0)::numeric) AND (position_seconds <= (86400)::numeric)))
);


--
-- Name: room_role_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_role_permissions (
    room_id uuid NOT NULL,
    role text NOT NULL,
    capability text NOT NULL,
    allowed boolean DEFAULT false NOT NULL,
    CONSTRAINT room_role_permissions_capability_check CHECK ((capability = ANY (ARRAY['manage_members'::text, 'manage_invites'::text, 'manage_settings'::text, 'manage_announcements'::text, 'chat'::text, 'watch'::text, 'watch_control'::text, 'files'::text, 'study'::text]))),
    CONSTRAINT room_role_permissions_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'member'::text, 'guest'::text])))
);


--
-- Name: room_study_resources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_study_resources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    room_id uuid NOT NULL,
    added_by uuid NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    url text,
    media_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT room_study_resources_check CHECK (((kind = 'media'::text) = (media_id IS NOT NULL))),
    CONSTRAINT room_study_resources_check1 CHECK (((kind = 'media'::text) OR (url IS NOT NULL))),
    CONSTRAINT room_study_resources_check2 CHECK (((kind <> 'youtube'::text) OR (url ~* '^https://(www\.|m\.)?(youtube\.com|youtu\.be)/'::text))),
    CONSTRAINT room_study_resources_kind_check CHECK ((kind = ANY (ARRAY['youtube'::text, 'media'::text, 'link'::text]))),
    CONSTRAINT room_study_resources_title_check CHECK (((char_length(btrim(title)) >= 1) AND (char_length(btrim(title)) <= 200))),
    CONSTRAINT room_study_resources_url_check CHECK (((url IS NULL) OR ((char_length(url) <= 2000) AND (url ~ '^https://[^[:space:]]+$'::text))))
);


--
-- Name: room_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    room_id uuid NOT NULL,
    created_by uuid NOT NULL,
    title text NOT NULL,
    details text DEFAULT ''::text NOT NULL,
    assignee_id uuid,
    due_at timestamp with time zone,
    status text DEFAULT 'open'::text NOT NULL,
    completed_by uuid,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT room_tasks_check CHECK (((status = 'done'::text) = (completed_at IS NOT NULL))),
    CONSTRAINT room_tasks_details_check CHECK ((char_length(details) <= 2000)),
    CONSTRAINT room_tasks_status_check CHECK ((status = ANY (ARRAY['open'::text, 'done'::text]))),
    CONSTRAINT room_tasks_title_check CHECK (((char_length(btrim(title)) >= 1) AND (char_length(btrim(title)) <= 200)))
);


--
-- Name: room_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id uuid,
    builtin_key text,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    config jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT room_templates_builtin_key_check CHECK (((builtin_key IS NULL) OR ((char_length(builtin_key) >= 1) AND (char_length(builtin_key) <= 40)))),
    CONSTRAINT room_templates_check CHECK (((owner_id IS NULL) = (builtin_key IS NOT NULL))),
    CONSTRAINT room_templates_config_check CHECK (((jsonb_typeof(config) = 'object'::text) AND (config ?& ARRAY['is_private'::text, 'expiration_type'::text, 'feature_flags'::text, 'default_layout'::text, 'theme'::text]) AND ((config ->> 'expiration_type'::text) = ANY (ARRAY['permanent'::text, 'recoverable'::text, 'irreversible'::text])) AND ((config ->> 'default_layout'::text) = ANY (ARRAY['balanced'::text, 'stage'::text, 'chat'::text])) AND ((config ->> 'theme'::text) = ANY (ARRAY['violet'::text, 'ocean'::text, 'emerald'::text, 'amber'::text, 'rose'::text, 'graphite'::text])) AND (jsonb_typeof((config -> 'is_private'::text)) = 'boolean'::text) AND (jsonb_typeof((config -> 'feature_flags'::text)) = 'object'::text))),
    CONSTRAINT room_templates_description_check CHECK ((char_length(description) <= 200)),
    CONSTRAINT room_templates_name_check CHECK (((char_length(btrim(name)) >= 1) AND (char_length(btrim(name)) <= 60)))
);


--
-- Name: room_timer_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_timer_sessions (
    room_id uuid NOT NULL,
    session_id text NOT NULL,
    started_by uuid NOT NULL,
    duration_seconds integer NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT room_timer_sessions_check CHECK (((completed_at IS NULL) OR (completed_at >= started_at))),
    CONSTRAINT room_timer_sessions_duration_seconds_check CHECK (((duration_seconds >= 1) AND (duration_seconds <= 359999))),
    CONSTRAINT room_timer_sessions_session_id_check CHECK ((session_id ~ '^[A-Za-z0-9-]{8,80}$'::text))
);


--
-- Name: room_voice_moderation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_voice_moderation (
    room_id uuid NOT NULL,
    user_id uuid NOT NULL,
    audio_muted boolean DEFAULT false NOT NULL,
    screen_blocked boolean DEFAULT false NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: site_owners; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.site_owners (
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: study_note_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.study_note_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    note_id uuid NOT NULL,
    room_id uuid NOT NULL,
    version bigint NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    edited_by uuid,
    saved_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT study_note_versions_content_check CHECK ((char_length(content) <= 100000)),
    CONSTRAINT study_note_versions_title_check CHECK (((char_length(title) >= 1) AND (char_length(title) <= 160))),
    CONSTRAINT study_note_versions_version_check CHECK ((version > 0))
);


--
-- Name: study_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.study_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    room_id uuid,
    subject text NOT NULL,
    duration_minutes integer NOT NULL,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now())
);


--
-- Name: temporary_media_cleanup_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.temporary_media_cleanup_jobs (
    media_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    last_attempt_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT temporary_media_cleanup_jobs_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT temporary_media_cleanup_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'failed'::text])))
);


--
-- Name: user_blocks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_blocks (
    blocker_id uuid NOT NULL,
    blocked_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_blocks_not_self CHECK ((blocker_id <> blocked_id))
);


--
-- Name: user_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_keys (
    user_id uuid NOT NULL,
    public_key text NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);


--
-- Name: follows follows_pair_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.follows
    ADD CONSTRAINT follows_pair_unique UNIQUE (follower_id, following_id);


--
-- Name: follows follows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.follows
    ADD CONSTRAINT follows_pkey PRIMARY KEY (id);


--
-- Name: friend_requests friend_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friend_requests
    ADD CONSTRAINT friend_requests_pkey PRIMARY KEY (id);


--
-- Name: friendships friendships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friendships
    ADD CONSTRAINT friendships_pkey PRIMARY KEY (user_one, user_two);


--
-- Name: group_members group_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_pkey PRIMARY KEY (group_id, user_id);


--
-- Name: group_messages group_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_messages
    ADD CONSTRAINT group_messages_pkey PRIMARY KEY (id);


--
-- Name: groups groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_pkey PRIMARY KEY (id);


--
-- Name: groups groups_source_room_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_source_room_id_key UNIQUE (source_room_id);


--
-- Name: message_reactions message_reactions_message_id_user_id_emoji_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_reactions
    ADD CONSTRAINT message_reactions_message_id_user_id_emoji_key UNIQUE (message_id, user_id, emoji);


--
-- Name: message_reactions message_reactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_reactions
    ADD CONSTRAINT message_reactions_pkey PRIMARY KEY (id);


--
-- Name: message_requests message_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_requests
    ADD CONSTRAINT message_requests_pkey PRIMARY KEY (id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: messages messages_private_encrypted_payload_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.messages
    ADD CONSTRAINT messages_private_encrypted_payload_check CHECK (((chat_id IS NULL) OR ((ciphertext IS NOT NULL) AND (iv IS NOT NULL) AND ((char_length(ciphertext) >= 24) AND (char_length(ciphertext) <= 32768)) AND ((char_length(ciphertext) % 4) = 0) AND (ciphertext ~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'::text) AND (char_length(iv) = 16) AND (iv ~ '^[A-Za-z0-9+/]{16}$'::text)))) NOT VALID;


--
-- Name: messages messages_room_content_length_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.messages
    ADD CONSTRAINT messages_room_content_length_check CHECK (((room_id IS NULL) OR (content IS NULL) OR ((char_length(btrim(content)) >= 1) AND (char_length(btrim(content)) <= 2000)))) NOT VALID;


--
-- Name: music_custom_sources music_custom_sources_owner_id_manifest_url_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.music_custom_sources
    ADD CONSTRAINT music_custom_sources_owner_id_manifest_url_key UNIQUE (owner_id, manifest_url);


--
-- Name: music_custom_sources music_custom_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.music_custom_sources
    ADD CONSTRAINT music_custom_sources_pkey PRIMARY KEY (id);


--
-- Name: music_listen_sessions music_listen_one_per_target; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.music_listen_sessions
    ADD CONSTRAINT music_listen_one_per_target UNIQUE (target_kind, target_id);


--
-- Name: music_listen_sessions music_listen_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.music_listen_sessions
    ADD CONSTRAINT music_listen_sessions_pkey PRIMARY KEY (id);


--
-- Name: music_listening_history music_listening_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.music_listening_history
    ADD CONSTRAINT music_listening_history_pkey PRIMARY KEY (id);


--
-- Name: music_now_playing music_now_playing_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.music_now_playing
    ADD CONSTRAINT music_now_playing_pkey PRIMARY KEY (user_id);


--
-- Name: music_playlist_items music_playlist_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.music_playlist_items
    ADD CONSTRAINT music_playlist_items_pkey PRIMARY KEY (playlist_id, upload_id);


--
-- Name: music_playlists music_playlists_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.music_playlists
    ADD CONSTRAINT music_playlists_pkey PRIMARY KEY (id);


--
-- Name: music_settings music_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.music_settings
    ADD CONSTRAINT music_settings_pkey PRIMARY KEY (user_id);


--
-- Name: music_upload_shares music_upload_shares_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.music_upload_shares
    ADD CONSTRAINT music_upload_shares_pkey PRIMARY KEY (id);


--
-- Name: music_upload_shares music_upload_shares_upload_id_target_kind_target_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.music_upload_shares
    ADD CONSTRAINT music_upload_shares_upload_id_target_kind_target_id_key UNIQUE (upload_id, target_kind, target_id);


--
-- Name: music_uploads music_uploads_cover_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.music_uploads
    ADD CONSTRAINT music_uploads_cover_path_key UNIQUE (cover_path);


--
-- Name: music_uploads music_uploads_object_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.music_uploads
    ADD CONSTRAINT music_uploads_object_path_key UNIQUE (object_path);


--
-- Name: music_uploads music_uploads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.music_uploads
    ADD CONSTRAINT music_uploads_pkey PRIMARY KEY (id);


--
-- Name: notification_preferences notification_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_pkey PRIMARY KEY (id);


--
-- Name: pdf_annotations pdf_annotations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdf_annotations
    ADD CONSTRAINT pdf_annotations_pkey PRIMARY KEY (id);


--
-- Name: posts posts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.posts
    ADD CONSTRAINT posts_pkey PRIMARY KEY (id);


--
-- Name: private_chats private_chats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_chats
    ADD CONSTRAINT private_chats_pkey PRIMARY KEY (id);


--
-- Name: private_chats private_chats_user_one_user_two_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_chats
    ADD CONSTRAINT private_chats_user_one_user_two_key UNIQUE (user_one, user_two);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: recovery_requests recovery_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recovery_requests
    ADD CONSTRAINT recovery_requests_pkey PRIMARY KEY (id);


--
-- Name: room_activity room_activity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_activity
    ADD CONSTRAINT room_activity_pkey PRIMARY KEY (id);


--
-- Name: room_activity room_activity_room_id_dedupe_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_activity
    ADD CONSTRAINT room_activity_room_id_dedupe_key_key UNIQUE (room_id, dedupe_key);


--
-- Name: room_announcements room_announcements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_announcements
    ADD CONSTRAINT room_announcements_pkey PRIMARY KEY (id);


--
-- Name: room_bookmarks room_bookmarks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_bookmarks
    ADD CONSTRAINT room_bookmarks_pkey PRIMARY KEY (id);


--
-- Name: room_bookmarks room_bookmarks_user_id_kind_entity_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_bookmarks
    ADD CONSTRAINT room_bookmarks_user_id_kind_entity_id_key UNIQUE (user_id, kind, entity_id);


--
-- Name: room_cleanup_jobs room_cleanup_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_cleanup_jobs
    ADD CONSTRAINT room_cleanup_jobs_pkey PRIMARY KEY (room_id);


--
-- Name: room_control_events room_control_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_control_events
    ADD CONSTRAINT room_control_events_pkey PRIMARY KEY (id);


--
-- Name: room_control_settings room_control_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_control_settings
    ADD CONSTRAINT room_control_settings_pkey PRIMARY KEY (room_id);


--
-- Name: room_countdowns room_countdowns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_countdowns
    ADD CONSTRAINT room_countdowns_pkey PRIMARY KEY (id);


--
-- Name: room_event_rsvps room_event_rsvps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_event_rsvps
    ADD CONSTRAINT room_event_rsvps_pkey PRIMARY KEY (event_id, user_id);


--
-- Name: room_events room_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_events
    ADD CONSTRAINT room_events_pkey PRIMARY KEY (id);


--
-- Name: room_exports room_exports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_exports
    ADD CONSTRAINT room_exports_pkey PRIMARY KEY (id);


--
-- Name: room_files room_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_files
    ADD CONSTRAINT room_files_pkey PRIMARY KEY (id);


--
-- Name: room_files room_files_storage_bucket_object_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_files
    ADD CONSTRAINT room_files_storage_bucket_object_path_key UNIQUE (storage_bucket, object_path);


--
-- Name: room_group_conversions room_group_conversions_group_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_group_conversions
    ADD CONSTRAINT room_group_conversions_group_id_key UNIQUE (group_id);


--
-- Name: room_group_conversions room_group_conversions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_group_conversions
    ADD CONSTRAINT room_group_conversions_pkey PRIMARY KEY (id);


--
-- Name: room_group_conversions room_group_conversions_room_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_group_conversions
    ADD CONSTRAINT room_group_conversions_room_id_key UNIQUE (room_id);


--
-- Name: room_hand_raises room_hand_raises_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_hand_raises
    ADD CONSTRAINT room_hand_raises_pkey PRIMARY KEY (room_id, user_id);


--
-- Name: room_invites room_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_invites
    ADD CONSTRAINT room_invites_pkey PRIMARY KEY (id);


--
-- Name: room_invites room_invites_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_invites
    ADD CONSTRAINT room_invites_token_key UNIQUE (token);


--
-- Name: room_media_clips room_media_clips_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_media_clips
    ADD CONSTRAINT room_media_clips_pkey PRIMARY KEY (id);


--
-- Name: room_media_queue room_media_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_media_queue
    ADD CONSTRAINT room_media_queue_pkey PRIMARY KEY (id);


--
-- Name: room_media_queue room_media_queue_room_id_media_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_media_queue
    ADD CONSTRAINT room_media_queue_room_id_media_id_key UNIQUE (room_id, media_id);


--
-- Name: room_member_profiles room_member_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_member_profiles
    ADD CONSTRAINT room_member_profiles_pkey PRIMARY KEY (room_id, user_id);


--
-- Name: room_member_restrictions room_member_restrictions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_member_restrictions
    ADD CONSTRAINT room_member_restrictions_pkey PRIMARY KEY (room_id, user_id, restriction_type);


--
-- Name: room_members room_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_members
    ADD CONSTRAINT room_members_pkey PRIMARY KEY (room_id, user_id);


--
-- Name: room_message_reactions room_message_reactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_message_reactions
    ADD CONSTRAINT room_message_reactions_pkey PRIMARY KEY (message_id, user_id, emoji);


--
-- Name: room_messages room_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_messages
    ADD CONSTRAINT room_messages_pkey PRIMARY KEY (id);


--
-- Name: room_notifications room_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_notifications
    ADD CONSTRAINT room_notifications_pkey PRIMARY KEY (id);


--
-- Name: room_permanent_requests room_permanent_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_permanent_requests
    ADD CONSTRAINT room_permanent_requests_pkey PRIMARY KEY (id);


--
-- Name: room_poll_votes room_poll_votes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_poll_votes
    ADD CONSTRAINT room_poll_votes_pkey PRIMARY KEY (poll_id, user_id);


--
-- Name: room_polls room_polls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_polls
    ADD CONSTRAINT room_polls_pkey PRIMARY KEY (id);


--
-- Name: room_read_states room_read_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_read_states
    ADD CONSTRAINT room_read_states_pkey PRIMARY KEY (room_id, user_id);


--
-- Name: room_realtime_snapshots room_realtime_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_realtime_snapshots
    ADD CONSTRAINT room_realtime_snapshots_pkey PRIMARY KEY (room_id, snapshot_type);


--
-- Name: room_recording_consents room_recording_consents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_recording_consents
    ADD CONSTRAINT room_recording_consents_pkey PRIMARY KEY (recording_id, user_id);


--
-- Name: room_recording_transcripts room_recording_transcripts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_recording_transcripts
    ADD CONSTRAINT room_recording_transcripts_pkey PRIMARY KEY (recording_id);


--
-- Name: room_recordings room_recordings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_recordings
    ADD CONSTRAINT room_recordings_pkey PRIMARY KEY (id);


--
-- Name: room_resource_notes room_resource_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_resource_notes
    ADD CONSTRAINT room_resource_notes_pkey PRIMARY KEY (id);


--
-- Name: room_resource_progress room_resource_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_resource_progress
    ADD CONSTRAINT room_resource_progress_pkey PRIMARY KEY (resource_id, user_id);


--
-- Name: room_role_permissions room_role_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_role_permissions
    ADD CONSTRAINT room_role_permissions_pkey PRIMARY KEY (room_id, role, capability);


--
-- Name: room_study_resources room_study_resources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_study_resources
    ADD CONSTRAINT room_study_resources_pkey PRIMARY KEY (id);


--
-- Name: room_tasks room_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_tasks
    ADD CONSTRAINT room_tasks_pkey PRIMARY KEY (id);


--
-- Name: room_templates room_templates_builtin_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_templates
    ADD CONSTRAINT room_templates_builtin_key_key UNIQUE (builtin_key);


--
-- Name: room_templates room_templates_owner_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_templates
    ADD CONSTRAINT room_templates_owner_id_name_key UNIQUE (owner_id, name);


--
-- Name: room_templates room_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_templates
    ADD CONSTRAINT room_templates_pkey PRIMARY KEY (id);


--
-- Name: room_timer_sessions room_timer_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_timer_sessions
    ADD CONSTRAINT room_timer_sessions_pkey PRIMARY KEY (room_id, session_id);


--
-- Name: room_voice_moderation room_voice_moderation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_voice_moderation
    ADD CONSTRAINT room_voice_moderation_pkey PRIMARY KEY (room_id, user_id);


--
-- Name: room_whiteboards room_whiteboards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_whiteboards
    ADD CONSTRAINT room_whiteboards_pkey PRIMARY KEY (room_id);


--
-- Name: rooms rooms_expiration_consistency_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.rooms
    ADD CONSTRAINT rooms_expiration_consistency_check CHECK ((((expiration_type = 'permanent'::text) AND (expires_at IS NULL)) OR ((expiration_type = ANY (ARRAY['recoverable'::text, 'irreversible'::text])) AND (expires_at IS NOT NULL)))) NOT VALID;


--
-- Name: rooms rooms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rooms
    ADD CONSTRAINT rooms_pkey PRIMARY KEY (id);


--
-- Name: rooms rooms_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rooms
    ADD CONSTRAINT rooms_username_key UNIQUE (username);


--
-- Name: site_owners site_owners_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site_owners
    ADD CONSTRAINT site_owners_pkey PRIMARY KEY (user_id);


--
-- Name: study_note_versions study_note_versions_note_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.study_note_versions
    ADD CONSTRAINT study_note_versions_note_id_version_key UNIQUE (note_id, version);


--
-- Name: study_note_versions study_note_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.study_note_versions
    ADD CONSTRAINT study_note_versions_pkey PRIMARY KEY (id);


--
-- Name: study_notes study_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.study_notes
    ADD CONSTRAINT study_notes_pkey PRIMARY KEY (id);


--
-- Name: study_sessions study_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.study_sessions
    ADD CONSTRAINT study_sessions_pkey PRIMARY KEY (id);


--
-- Name: temporary_media_cleanup_jobs temporary_media_cleanup_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_media_cleanup_jobs
    ADD CONSTRAINT temporary_media_cleanup_jobs_pkey PRIMARY KEY (media_id);


--
-- Name: temporary_media temporary_media_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_media
    ADD CONSTRAINT temporary_media_pkey PRIMARY KEY (id);


--
-- Name: user_blocks user_blocks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_blocks
    ADD CONSTRAINT user_blocks_pkey PRIMARY KEY (blocker_id, blocked_id);


--
-- Name: user_keys user_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_keys
    ADD CONSTRAINT user_keys_pkey PRIMARY KEY (user_id);


--
-- Name: conversation_reads_chat_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX conversation_reads_chat_idx ON public.conversation_reads USING btree (user_id, chat_id) WHERE (chat_id IS NOT NULL);


--
-- Name: conversation_reads_group_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX conversation_reads_group_idx ON public.conversation_reads USING btree (user_id, group_id) WHERE (group_id IS NOT NULL);


--
-- Name: follows_follower_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX follows_follower_status_idx ON public.follows USING btree (follower_id, status, created_at DESC);


--
-- Name: follows_following_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX follows_following_status_idx ON public.follows USING btree (following_id, status, created_at DESC);


--
-- Name: friend_requests_pending_pair_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX friend_requests_pending_pair_unique_idx ON public.friend_requests USING btree (LEAST(requester_id, recipient_id), GREATEST(requester_id, recipient_id)) WHERE (status = 'pending'::text);


--
-- Name: friend_requests_recipient_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX friend_requests_recipient_status_idx ON public.friend_requests USING btree (recipient_id, status, created_at DESC);


--
-- Name: friend_requests_requester_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX friend_requests_requester_status_idx ON public.friend_requests USING btree (requester_id, status, created_at DESC);


--
-- Name: group_members_one_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX group_members_one_owner ON public.group_members USING btree (group_id) WHERE (role = 'owner'::text);


--
-- Name: group_members_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX group_members_user_idx ON public.group_members USING btree (user_id);


--
-- Name: group_messages_group_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX group_messages_group_created_idx ON public.group_messages USING btree (group_id, created_at DESC, id DESC);


--
-- Name: message_requests_pending_pair_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX message_requests_pending_pair_unique_idx ON public.message_requests USING btree (LEAST(requester_id, recipient_id), GREATEST(requester_id, recipient_id)) WHERE (status = 'pending'::text);


--
-- Name: message_requests_recipient_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_requests_recipient_status_idx ON public.message_requests USING btree (recipient_id, status, created_at DESC);


--
-- Name: message_requests_requester_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_requests_requester_status_idx ON public.message_requests USING btree (requester_id, status, created_at DESC);


--
-- Name: messages_chat_created_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_chat_created_id_idx ON public.messages USING btree (chat_id, created_at DESC, id DESC);


--
-- Name: messages_chat_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_chat_id_idx ON public.messages USING btree (chat_id);


--
-- Name: messages_pinned_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_pinned_by_idx ON public.messages USING btree (pinned_by) WHERE (pinned_by IS NOT NULL);


--
-- Name: messages_reply_to_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_reply_to_idx ON public.messages USING btree (reply_to_id) WHERE (reply_to_id IS NOT NULL);


--
-- Name: messages_room_created_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_room_created_id_idx ON public.messages USING btree (room_id, created_at DESC, id DESC);


--
-- Name: messages_room_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_room_id_idx ON public.messages USING btree (room_id);


--
-- Name: messages_room_pinned_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_room_pinned_idx ON public.messages USING btree (room_id, pinned_at DESC) WHERE (pinned_at IS NOT NULL);


--
-- Name: music_listening_history_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX music_listening_history_user_idx ON public.music_listening_history USING btree (user_id, played_at DESC);


--
-- Name: music_playlists_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX music_playlists_owner_idx ON public.music_playlists USING btree (owner_id, created_at);


--
-- Name: music_upload_shares_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX music_upload_shares_target_idx ON public.music_upload_shares USING btree (target_kind, target_id);


--
-- Name: music_uploads_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX music_uploads_due_idx ON public.music_uploads USING btree (expires_at) WHERE (state <> 'deleted'::text);


--
-- Name: music_uploads_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX music_uploads_owner_idx ON public.music_uploads USING btree (owner_id, created_at DESC);


--
-- Name: notification_preferences_global_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX notification_preferences_global_unique ON public.notification_preferences USING btree (user_id) WHERE (room_id IS NULL);


--
-- Name: notification_preferences_room_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX notification_preferences_room_unique ON public.notification_preferences USING btree (user_id, room_id) WHERE (room_id IS NOT NULL);


--
-- Name: pdf_annotations_file_page_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pdf_annotations_file_page_idx ON public.pdf_annotations USING btree (file_id, page_number, created_at);


--
-- Name: posts_author_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX posts_author_created_idx ON public.posts USING btree (author_id, created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: private_chats_pair_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX private_chats_pair_unique_idx ON public.private_chats USING btree (LEAST(user_one, user_two), GREATEST(user_one, user_two));


--
-- Name: profiles_private_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX profiles_private_idx ON public.profiles USING btree (is_private);


--
-- Name: profiles_username_lower_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX profiles_username_lower_unique_idx ON public.profiles USING btree (lower(username)) WHERE (username IS NOT NULL);


--
-- Name: recovery_requests_one_pending_per_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX recovery_requests_one_pending_per_user ON public.recovery_requests USING btree (room_id, requester_id) WHERE (status = 'pending'::text);


--
-- Name: recovery_requests_room_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recovery_requests_room_status_idx ON public.recovery_requests USING btree (room_id, status, created_at DESC);


--
-- Name: room_activity_room_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_activity_room_idx ON public.room_activity USING btree (room_id, created_at DESC);


--
-- Name: room_announcements_room_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_announcements_room_created_idx ON public.room_announcements USING btree (room_id, is_pinned DESC, created_at DESC);


--
-- Name: room_bookmarks_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_bookmarks_user_idx ON public.room_bookmarks USING btree (user_id, created_at DESC);


--
-- Name: room_cleanup_jobs_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_cleanup_jobs_pending_idx ON public.room_cleanup_jobs USING btree (created_at) WHERE (status = ANY (ARRAY['pending'::text, 'failed'::text]));


--
-- Name: room_control_events_room_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_control_events_room_id_idx ON public.room_control_events USING btree (room_id, id DESC);


--
-- Name: room_countdowns_room_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_countdowns_room_idx ON public.room_countdowns USING btree (room_id, ends_at);


--
-- Name: room_event_rsvps_room_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_event_rsvps_room_idx ON public.room_event_rsvps USING btree (room_id);


--
-- Name: room_events_room_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_events_room_idx ON public.room_events USING btree (room_id, starts_at);


--
-- Name: room_exports_room_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_exports_room_idx ON public.room_exports USING btree (room_id, created_at DESC);


--
-- Name: room_files_one_active_name_per_room; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX room_files_one_active_name_per_room ON public.room_files USING btree (room_id, normalized_name) WHERE (deleted_at IS NULL);


--
-- Name: room_files_pending_cleanup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_files_pending_cleanup_idx ON public.room_files USING btree (delete_requested_at) WHERE (retention_state = 'delete_pending'::text);


--
-- Name: room_files_room_active_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_files_room_active_created_idx ON public.room_files USING btree (room_id, created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: room_invites_room_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_invites_room_active_idx ON public.room_invites USING btree (room_id, created_at DESC) WHERE (revoked_at IS NULL);


--
-- Name: room_media_clips_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_media_clips_created_by_idx ON public.room_media_clips USING btree (created_by);


--
-- Name: room_media_clips_media_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_media_clips_media_idx ON public.room_media_clips USING btree (media_id, start_seconds);


--
-- Name: room_media_clips_room_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_media_clips_room_idx ON public.room_media_clips USING btree (room_id);


--
-- Name: room_media_queue_added_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_media_queue_added_by_idx ON public.room_media_queue USING btree (added_by);


--
-- Name: room_media_queue_media_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_media_queue_media_idx ON public.room_media_queue USING btree (media_id);


--
-- Name: room_media_queue_room_position_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_media_queue_room_position_idx ON public.room_media_queue USING btree (room_id, "position");


--
-- Name: room_member_restrictions_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_member_restrictions_active_idx ON public.room_member_restrictions USING btree (room_id, user_id) WHERE (expires_at IS NULL);


--
-- Name: room_members_active_access_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_members_active_access_idx ON public.room_members USING btree (room_id, user_id, join_status, guest_expires_at);


--
-- Name: room_message_reactions_room_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_message_reactions_room_idx ON public.room_message_reactions USING btree (room_id);


--
-- Name: room_message_reactions_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_message_reactions_user_idx ON public.room_message_reactions USING btree (user_id);


--
-- Name: room_notifications_recipient_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_notifications_recipient_created_idx ON public.room_notifications USING btree (recipient_id, created_at DESC);


--
-- Name: room_notifications_recipient_dedupe; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX room_notifications_recipient_dedupe ON public.room_notifications USING btree (recipient_id, dedupe_key) WHERE (dedupe_key IS NOT NULL);


--
-- Name: room_notifications_recipient_unread_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_notifications_recipient_unread_idx ON public.room_notifications USING btree (recipient_id, created_at DESC) WHERE (read_at IS NULL);


--
-- Name: room_permanent_requests_one_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX room_permanent_requests_one_pending ON public.room_permanent_requests USING btree (room_id) WHERE (status = 'pending'::text);


--
-- Name: room_permanent_requests_room_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_permanent_requests_room_status_idx ON public.room_permanent_requests USING btree (room_id, status, created_at DESC);


--
-- Name: room_polls_room_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_polls_room_idx ON public.room_polls USING btree (room_id, created_at DESC);


--
-- Name: room_read_states_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_read_states_user_idx ON public.room_read_states USING btree (user_id);


--
-- Name: room_recordings_one_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX room_recordings_one_active_idx ON public.room_recordings USING btree (room_id) WHERE (status = ANY (ARRAY['consent'::text, 'recording'::text]));


--
-- Name: room_recordings_room_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_recordings_room_idx ON public.room_recordings USING btree (room_id, created_at DESC);


--
-- Name: room_resource_notes_resource_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_resource_notes_resource_idx ON public.room_resource_notes USING btree (resource_id, at_seconds);


--
-- Name: room_study_resources_room_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_study_resources_room_idx ON public.room_study_resources USING btree (room_id, created_at DESC);


--
-- Name: room_tasks_assignee_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_tasks_assignee_idx ON public.room_tasks USING btree (assignee_id);


--
-- Name: room_tasks_room_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_tasks_room_idx ON public.room_tasks USING btree (room_id, status, due_at);


--
-- Name: room_timer_sessions_started_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX room_timer_sessions_started_by_idx ON public.room_timer_sessions USING btree (started_by);


--
-- Name: rooms_scheduled_for_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rooms_scheduled_for_idx ON public.rooms USING btree (scheduled_for) WHERE (scheduled_for IS NOT NULL);


--
-- Name: study_note_versions_note_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX study_note_versions_note_idx ON public.study_note_versions USING btree (note_id, version DESC);


--
-- Name: study_notes_owner_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX study_notes_owner_updated_idx ON public.study_notes USING btree (owner_id, updated_at DESC);


--
-- Name: study_notes_room_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX study_notes_room_updated_idx ON public.study_notes USING btree (room_id, updated_at DESC);


--
-- Name: temporary_media_cleanup_jobs_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX temporary_media_cleanup_jobs_pending_idx ON public.temporary_media_cleanup_jobs USING btree (updated_at) WHERE (status = ANY (ARRAY['pending'::text, 'failed'::text]));


--
-- Name: temporary_media_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX temporary_media_expiry_idx ON public.temporary_media USING btree (expires_at);


--
-- Name: user_blocks_blocked_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_blocks_blocked_idx ON public.user_blocks USING btree (blocked_id);


--
-- Name: study_notes capture_study_note_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER capture_study_note_version AFTER UPDATE ON public.study_notes FOR EACH ROW EXECUTE FUNCTION public.capture_study_note_version();


--
-- Name: messages clear_deleted_room_message_reactions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER clear_deleted_room_message_reactions AFTER UPDATE OF is_deleted ON public.messages FOR EACH ROW EXECUTE FUNCTION public.clear_deleted_room_message_reactions();


--
-- Name: messages guard_room_message_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER guard_room_message_update BEFORE UPDATE ON public.messages FOR EACH ROW EXECUTE FUNCTION public.guard_room_message_update();


--
-- Name: room_announcements log_room_activity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER log_room_activity AFTER INSERT ON public.room_announcements FOR EACH ROW EXECUTE FUNCTION public.log_room_activity();


--
-- Name: room_events log_room_activity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER log_room_activity AFTER INSERT ON public.room_events FOR EACH ROW EXECUTE FUNCTION public.log_room_activity();


--
-- Name: room_files log_room_activity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER log_room_activity AFTER INSERT ON public.room_files FOR EACH ROW EXECUTE FUNCTION public.log_room_activity();


--
-- Name: room_media_clips log_room_activity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER log_room_activity AFTER INSERT ON public.room_media_clips FOR EACH ROW EXECUTE FUNCTION public.log_room_activity();


--
-- Name: room_media_queue log_room_activity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER log_room_activity AFTER INSERT ON public.room_media_queue FOR EACH ROW EXECUTE FUNCTION public.log_room_activity();


--
-- Name: room_members log_room_activity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER log_room_activity AFTER INSERT OR DELETE OR UPDATE OF join_status, role ON public.room_members FOR EACH ROW EXECUTE FUNCTION public.log_room_activity();


--
-- Name: room_polls log_room_activity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER log_room_activity AFTER INSERT ON public.room_polls FOR EACH ROW EXECUTE FUNCTION public.log_room_activity();


--
-- Name: room_tasks log_room_activity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER log_room_activity AFTER INSERT OR UPDATE OF status ON public.room_tasks FOR EACH ROW EXECUTE FUNCTION public.log_room_activity();


--
-- Name: study_notes log_room_activity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER log_room_activity AFTER INSERT ON public.study_notes FOR EACH ROW EXECUTE FUNCTION public.log_room_activity();


--
-- Name: music_custom_sources music_custom_sources_limit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER music_custom_sources_limit BEFORE INSERT ON public.music_custom_sources FOR EACH ROW EXECUTE FUNCTION public.music_custom_sources_limit();


--
-- Name: music_playlists music_playlists_limit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER music_playlists_limit BEFORE INSERT ON public.music_playlists FOR EACH ROW EXECUTE FUNCTION public.music_playlists_limit();


--
-- Name: room_control_events notify_member_access_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notify_member_access_change AFTER INSERT ON public.room_control_events FOR EACH ROW EXECUTE FUNCTION public.notify_member_access_change();


--
-- Name: room_announcements notify_room_announcement; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notify_room_announcement AFTER INSERT ON public.room_announcements FOR EACH ROW EXECUTE FUNCTION public.notify_room_announcement();


--
-- Name: room_events notify_room_event_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notify_room_event_change AFTER INSERT OR UPDATE OF cancelled_at ON public.room_events FOR EACH ROW EXECUTE FUNCTION public.notify_room_event_change();


--
-- Name: messages notify_room_message_activity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notify_room_message_activity AFTER INSERT OR UPDATE OF content ON public.messages FOR EACH ROW EXECUTE FUNCTION public.notify_room_message_activity();


--
-- Name: room_files notify_room_pdf_shared; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notify_room_pdf_shared AFTER INSERT ON public.room_files FOR EACH ROW EXECUTE FUNCTION public.notify_room_pdf_shared();


--
-- Name: recovery_requests notify_room_recovery_decision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notify_room_recovery_decision AFTER UPDATE OF status ON public.recovery_requests FOR EACH ROW EXECUTE FUNCTION public.notify_room_recovery_decision();


--
-- Name: room_tasks notify_room_task_assignment; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notify_room_task_assignment AFTER INSERT OR UPDATE OF assignee_id ON public.room_tasks FOR EACH ROW EXECUTE FUNCTION public.notify_room_task_assignment();


--
-- Name: room_realtime_snapshots notify_room_timer_activity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notify_room_timer_activity AFTER INSERT OR UPDATE ON public.room_realtime_snapshots FOR EACH ROW WHEN ((new.snapshot_type = 'timer'::text)) EXECUTE FUNCTION public.notify_room_timer_activity();


--
-- Name: recovery_requests notify_site_owners_of_recovery_request; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notify_site_owners_of_recovery_request AFTER INSERT ON public.recovery_requests FOR EACH ROW EXECUTE FUNCTION public.notify_site_owners_of_recovery_request();


--
-- Name: messages prepare_room_message_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER prepare_room_message_insert BEFORE INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION public.prepare_room_message_insert();


--
-- Name: follows prevent_follows_tampering; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER prevent_follows_tampering BEFORE UPDATE ON public.follows FOR EACH ROW EXECUTE FUNCTION public.prevent_social_request_tampering();


--
-- Name: friend_requests prevent_friend_requests_tampering; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER prevent_friend_requests_tampering BEFORE UPDATE ON public.friend_requests FOR EACH ROW EXECUTE FUNCTION public.prevent_social_request_tampering();


--
-- Name: message_requests prevent_message_request_tampering; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER prevent_message_request_tampering BEFORE UPDATE ON public.message_requests FOR EACH ROW EXECUTE FUNCTION public.prevent_message_request_tampering();


--
-- Name: messages prevent_message_scope_changes; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER prevent_message_scope_changes BEFORE UPDATE ON public.messages FOR EACH ROW EXECUTE FUNCTION public.prevent_message_scope_changes();


--
-- Name: room_permanent_requests prevent_permanent_request_tampering; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER prevent_permanent_request_tampering BEFORE UPDATE ON public.room_permanent_requests FOR EACH ROW EXECUTE FUNCTION public.prevent_permanent_request_tampering();


--
-- Name: recovery_requests prevent_recovery_request_tampering; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER prevent_recovery_request_tampering BEFORE UPDATE ON public.recovery_requests FOR EACH ROW EXECUTE FUNCTION public.prevent_recovery_request_tampering();


--
-- Name: room_members prevent_room_membership_escalation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER prevent_room_membership_escalation BEFORE UPDATE ON public.room_members FOR EACH ROW EXECUTE FUNCTION public.prevent_room_membership_escalation();


--
-- Name: rooms prevent_unauthorized_deletion_schedule; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER prevent_unauthorized_deletion_schedule BEFORE INSERT OR UPDATE OF deletion_scheduled_at, deletion_scheduled_by ON public.rooms FOR EACH ROW EXECUTE FUNCTION public.prevent_unauthorized_deletion_schedule();


--
-- Name: rooms prevent_unauthorized_expired_conversion; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER prevent_unauthorized_expired_conversion BEFORE UPDATE OF expiration_type, expires_at ON public.rooms FOR EACH ROW EXECUTE FUNCTION public.prevent_unauthorized_expired_conversion();


--
-- Name: rooms prevent_unauthorized_reopen; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER prevent_unauthorized_reopen BEFORE UPDATE OF reopened_until ON public.rooms FOR EACH ROW EXECUTE FUNCTION public.prevent_unauthorized_reopen();


--
-- Name: profiles profiles_enforce_minimum_age; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER profiles_enforce_minimum_age BEFORE INSERT OR UPDATE OF date_of_birth ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_minimum_age();


--
-- Name: room_message_reactions refresh_room_message_reaction_summary; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER refresh_room_message_reaction_summary AFTER DELETE ON public.room_message_reactions REFERENCING OLD TABLE AS removed_rows FOR EACH STATEMENT EXECUTE FUNCTION public.refresh_room_message_reaction_summary();


--
-- Name: follows reject_blocked_pair; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reject_blocked_pair BEFORE INSERT ON public.follows FOR EACH ROW EXECUTE FUNCTION public.reject_blocked_pair('follower_id', 'following_id');


--
-- Name: friend_requests reject_blocked_pair; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reject_blocked_pair BEFORE INSERT ON public.friend_requests FOR EACH ROW EXECUTE FUNCTION public.reject_blocked_pair('requester_id', 'recipient_id');


--
-- Name: friendships reject_blocked_pair; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reject_blocked_pair BEFORE INSERT ON public.friendships FOR EACH ROW EXECUTE FUNCTION public.reject_blocked_pair('user_one', 'user_two');


--
-- Name: message_requests reject_blocked_pair; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reject_blocked_pair BEFORE INSERT ON public.message_requests FOR EACH ROW EXECUTE FUNCTION public.reject_blocked_pair('requester_id', 'recipient_id');


--
-- Name: private_chats reject_blocked_pair; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER reject_blocked_pair BEFORE INSERT ON public.private_chats FOR EACH ROW EXECUTE FUNCTION public.reject_blocked_pair('user_one', 'user_two');


--
-- Name: rooms seed_room_controls_after_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER seed_room_controls_after_insert AFTER INSERT ON public.rooms FOR EACH ROW EXECUTE FUNCTION public.seed_room_controls_after_insert();


--
-- Name: posts touch_post_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_post_updated_at BEFORE UPDATE ON public.posts FOR EACH ROW EXECUTE FUNCTION public.touch_post_updated_at();


--
-- Name: posts validate_post_fields; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER validate_post_fields BEFORE INSERT OR UPDATE ON public.posts FOR EACH ROW EXECUTE FUNCTION public.validate_post_fields();


--
-- Name: private_chats validate_private_chat_creation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER validate_private_chat_creation BEFORE INSERT ON public.private_chats FOR EACH ROW EXECUTE FUNCTION public.validate_private_chat_creation();


--
-- Name: profiles validate_profile_fields; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER validate_profile_fields BEFORE INSERT OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.validate_profile_fields();


--
-- Name: rooms validate_room_expiration; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER validate_room_expiration BEFORE INSERT OR UPDATE OF expiration_type, expires_at ON public.rooms FOR EACH ROW EXECUTE FUNCTION public.validate_room_expiration();


--
-- Name: rooms validate_room_schedule; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER validate_room_schedule BEFORE INSERT OR UPDATE OF scheduled_for, expiration_type, expires_at ON public.rooms FOR EACH ROW EXECUTE FUNCTION public.validate_room_schedule();


--
-- Name: conversation_reads conversation_reads_chat_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_reads
    ADD CONSTRAINT conversation_reads_chat_id_fkey FOREIGN KEY (chat_id) REFERENCES public.private_chats(id) ON DELETE CASCADE;


--
-- Name: conversation_reads conversation_reads_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_reads
    ADD CONSTRAINT conversation_reads_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE;


--
-- Name: conversation_reads conversation_reads_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_reads
    ADD CONSTRAINT conversation_reads_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: follows follows_follower_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.follows
    ADD CONSTRAINT follows_follower_id_fkey FOREIGN KEY (follower_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: follows follows_following_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.follows
    ADD CONSTRAINT follows_following_id_fkey FOREIGN KEY (following_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: friend_requests friend_requests_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friend_requests
    ADD CONSTRAINT friend_requests_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: friend_requests friend_requests_requester_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friend_requests
    ADD CONSTRAINT friend_requests_requester_id_fkey FOREIGN KEY (requester_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: friend_requests friend_requests_responded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friend_requests
    ADD CONSTRAINT friend_requests_responded_by_fkey FOREIGN KEY (responded_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: friendships friendships_user_one_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friendships
    ADD CONSTRAINT friendships_user_one_fkey FOREIGN KEY (user_one) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: friendships friendships_user_two_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friendships
    ADD CONSTRAINT friendships_user_two_fkey FOREIGN KEY (user_two) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: group_members group_members_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE;


--
-- Name: group_members group_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: group_messages group_messages_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_messages
    ADD CONSTRAINT group_messages_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE;


--
-- Name: group_messages group_messages_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_messages
    ADD CONSTRAINT group_messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: groups groups_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: groups groups_source_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_source_room_id_fkey FOREIGN KEY (source_room_id) REFERENCES public.rooms(id) ON DELETE RESTRICT;


--
-- Name: message_reactions message_reactions_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_reactions
    ADD CONSTRAINT message_reactions_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.room_messages(id) ON DELETE CASCADE;


--
-- Name: message_reactions message_reactions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_reactions
    ADD CONSTRAINT message_reactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: message_requests message_requests_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_requests
    ADD CONSTRAINT message_requests_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: message_requests message_requests_requester_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_requests
    ADD CONSTRAINT message_requests_requester_id_fkey FOREIGN KEY (requester_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: message_requests message_requests_responded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_requests
    ADD CONSTRAINT message_requests_responded_by_fkey FOREIGN KEY (responded_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: messages messages_chat_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_chat_id_fkey FOREIGN KEY (chat_id) REFERENCES public.private_chats(id) ON DELETE CASCADE;


--
-- Name: messages messages_pinned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pinned_by_fkey FOREIGN KEY (pinned_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: messages messages_receiver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_receiver_id_fkey FOREIGN KEY (receiver_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: messages messages_reply_to_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_reply_to_id_fkey FOREIGN KEY (reply_to_id) REFERENCES public.messages(id) ON DELETE SET NULL;


--
-- Name: messages messages_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: messages messages_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: music_custom_sources music_custom_sources_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.music_custom_sources
    ADD CONSTRAINT music_custom_sources_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: music_listen_sessions music_listen_sessions_host_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.music_listen_sessions
    ADD CONSTRAINT music_listen_sessions_host_id_fkey FOREIGN KEY (host_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: music_listen_sessions music_listen_sessions_upload_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.music_listen_sessions
    ADD CONSTRAINT music_listen_sessions_upload_id_fkey FOREIGN KEY (upload_id) REFERENCES public.music_uploads(id) ON DELETE SET NULL;


--
-- Name: music_listening_history music_listening_history_upload_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.music_listening_history
    ADD CONSTRAINT music_listening_history_upload_id_fkey FOREIGN KEY (upload_id) REFERENCES public.music_uploads(id) ON DELETE CASCADE;


--
-- Name: music_listening_history music_listening_history_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.music_listening_history
    ADD CONSTRAINT music_listening_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: music_now_playing music_now_playing_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.music_now_playing
    ADD CONSTRAINT music_now_playing_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: music_playlist_items music_playlist_items_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.music_playlist_items
    ADD CONSTRAINT music_playlist_items_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: music_playlist_items music_playlist_items_playlist_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.music_playlist_items
    ADD CONSTRAINT music_playlist_items_playlist_id_fkey FOREIGN KEY (playlist_id) REFERENCES public.music_playlists(id) ON DELETE CASCADE;


--
-- Name: music_playlist_items music_playlist_items_upload_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.music_playlist_items
    ADD CONSTRAINT music_playlist_items_upload_id_fkey FOREIGN KEY (upload_id) REFERENCES public.music_uploads(id) ON DELETE CASCADE;


--
-- Name: music_playlists music_playlists_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.music_playlists
    ADD CONSTRAINT music_playlists_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: music_settings music_settings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.music_settings
    ADD CONSTRAINT music_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: music_upload_shares music_upload_shares_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.music_upload_shares
    ADD CONSTRAINT music_upload_shares_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: music_upload_shares music_upload_shares_upload_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.music_upload_shares
    ADD CONSTRAINT music_upload_shares_upload_id_fkey FOREIGN KEY (upload_id) REFERENCES public.music_uploads(id) ON DELETE CASCADE;


--
-- Name: music_uploads music_uploads_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.music_uploads
    ADD CONSTRAINT music_uploads_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: notification_preferences notification_preferences_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: notification_preferences notification_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: pdf_annotations pdf_annotations_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdf_annotations
    ADD CONSTRAINT pdf_annotations_file_id_fkey FOREIGN KEY (file_id) REFERENCES public.room_files(id) ON DELETE CASCADE;


--
-- Name: pdf_annotations pdf_annotations_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdf_annotations
    ADD CONSTRAINT pdf_annotations_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: pdf_annotations pdf_annotations_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdf_annotations
    ADD CONSTRAINT pdf_annotations_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: posts posts_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.posts
    ADD CONSTRAINT posts_author_id_fkey FOREIGN KEY (author_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: private_chats private_chats_user_one_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_chats
    ADD CONSTRAINT private_chats_user_one_fkey FOREIGN KEY (user_one) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: private_chats private_chats_user_two_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_chats
    ADD CONSTRAINT private_chats_user_two_fkey FOREIGN KEY (user_two) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: recovery_requests recovery_requests_requester_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recovery_requests
    ADD CONSTRAINT recovery_requests_requester_id_fkey FOREIGN KEY (requester_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: recovery_requests recovery_requests_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recovery_requests
    ADD CONSTRAINT recovery_requests_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: recovery_requests recovery_requests_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recovery_requests
    ADD CONSTRAINT recovery_requests_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_activity room_activity_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_activity
    ADD CONSTRAINT room_activity_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: room_activity room_activity_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_activity
    ADD CONSTRAINT room_activity_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_announcements room_announcements_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_announcements
    ADD CONSTRAINT room_announcements_author_id_fkey FOREIGN KEY (author_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_announcements room_announcements_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_announcements
    ADD CONSTRAINT room_announcements_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_bookmarks room_bookmarks_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_bookmarks
    ADD CONSTRAINT room_bookmarks_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_bookmarks room_bookmarks_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_bookmarks
    ADD CONSTRAINT room_bookmarks_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_cleanup_jobs room_cleanup_jobs_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_cleanup_jobs
    ADD CONSTRAINT room_cleanup_jobs_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_control_events room_control_events_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_control_events
    ADD CONSTRAINT room_control_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: room_control_events room_control_events_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_control_events
    ADD CONSTRAINT room_control_events_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_control_events room_control_events_subject_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_control_events
    ADD CONSTRAINT room_control_events_subject_user_id_fkey FOREIGN KEY (subject_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: room_control_settings room_control_settings_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_control_settings
    ADD CONSTRAINT room_control_settings_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_control_settings room_control_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_control_settings
    ADD CONSTRAINT room_control_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: room_countdowns room_countdowns_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_countdowns
    ADD CONSTRAINT room_countdowns_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_countdowns room_countdowns_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_countdowns
    ADD CONSTRAINT room_countdowns_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_event_rsvps room_event_rsvps_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_event_rsvps
    ADD CONSTRAINT room_event_rsvps_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.room_events(id) ON DELETE CASCADE;


--
-- Name: room_event_rsvps room_event_rsvps_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_event_rsvps
    ADD CONSTRAINT room_event_rsvps_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_event_rsvps room_event_rsvps_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_event_rsvps
    ADD CONSTRAINT room_event_rsvps_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_events room_events_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_events
    ADD CONSTRAINT room_events_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_events room_events_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_events
    ADD CONSTRAINT room_events_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_exports room_exports_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_exports
    ADD CONSTRAINT room_exports_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: room_exports room_exports_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_exports
    ADD CONSTRAINT room_exports_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_files room_files_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_files
    ADD CONSTRAINT room_files_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_files room_files_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_files
    ADD CONSTRAINT room_files_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_group_conversions room_group_conversions_converted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_group_conversions
    ADD CONSTRAINT room_group_conversions_converted_by_fkey FOREIGN KEY (converted_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: room_group_conversions room_group_conversions_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_group_conversions
    ADD CONSTRAINT room_group_conversions_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE;


--
-- Name: room_group_conversions room_group_conversions_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_group_conversions
    ADD CONSTRAINT room_group_conversions_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE RESTRICT;


--
-- Name: room_hand_raises room_hand_raises_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_hand_raises
    ADD CONSTRAINT room_hand_raises_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_hand_raises room_hand_raises_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_hand_raises
    ADD CONSTRAINT room_hand_raises_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_invites room_invites_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_invites
    ADD CONSTRAINT room_invites_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_invites room_invites_revoked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_invites
    ADD CONSTRAINT room_invites_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: room_invites room_invites_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_invites
    ADD CONSTRAINT room_invites_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_media_clips room_media_clips_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_media_clips
    ADD CONSTRAINT room_media_clips_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_media_clips room_media_clips_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_media_clips
    ADD CONSTRAINT room_media_clips_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.temporary_media(id) ON DELETE CASCADE;


--
-- Name: room_media_clips room_media_clips_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_media_clips
    ADD CONSTRAINT room_media_clips_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_media_queue room_media_queue_added_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_media_queue
    ADD CONSTRAINT room_media_queue_added_by_fkey FOREIGN KEY (added_by) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_media_queue room_media_queue_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_media_queue
    ADD CONSTRAINT room_media_queue_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.temporary_media(id) ON DELETE CASCADE;


--
-- Name: room_media_queue room_media_queue_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_media_queue
    ADD CONSTRAINT room_media_queue_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_member_profiles room_member_profiles_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_member_profiles
    ADD CONSTRAINT room_member_profiles_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_member_profiles room_member_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_member_profiles
    ADD CONSTRAINT room_member_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_member_restrictions room_member_restrictions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_member_restrictions
    ADD CONSTRAINT room_member_restrictions_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_member_restrictions room_member_restrictions_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_member_restrictions
    ADD CONSTRAINT room_member_restrictions_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_member_restrictions room_member_restrictions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_member_restrictions
    ADD CONSTRAINT room_member_restrictions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_members room_members_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_members
    ADD CONSTRAINT room_members_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_members room_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_members
    ADD CONSTRAINT room_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_message_reactions room_message_reactions_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_message_reactions
    ADD CONSTRAINT room_message_reactions_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id) ON DELETE CASCADE;


--
-- Name: room_message_reactions room_message_reactions_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_message_reactions
    ADD CONSTRAINT room_message_reactions_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_message_reactions room_message_reactions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_message_reactions
    ADD CONSTRAINT room_message_reactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_messages room_messages_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_messages
    ADD CONSTRAINT room_messages_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_messages room_messages_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_messages
    ADD CONSTRAINT room_messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_notifications room_notifications_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_notifications
    ADD CONSTRAINT room_notifications_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: room_notifications room_notifications_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_notifications
    ADD CONSTRAINT room_notifications_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_notifications room_notifications_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_notifications
    ADD CONSTRAINT room_notifications_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_permanent_requests room_permanent_requests_requester_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_permanent_requests
    ADD CONSTRAINT room_permanent_requests_requester_id_fkey FOREIGN KEY (requester_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_permanent_requests room_permanent_requests_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_permanent_requests
    ADD CONSTRAINT room_permanent_requests_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: room_permanent_requests room_permanent_requests_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_permanent_requests
    ADD CONSTRAINT room_permanent_requests_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_poll_votes room_poll_votes_poll_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_poll_votes
    ADD CONSTRAINT room_poll_votes_poll_id_fkey FOREIGN KEY (poll_id) REFERENCES public.room_polls(id) ON DELETE CASCADE;


--
-- Name: room_poll_votes room_poll_votes_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_poll_votes
    ADD CONSTRAINT room_poll_votes_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_poll_votes room_poll_votes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_poll_votes
    ADD CONSTRAINT room_poll_votes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_polls room_polls_closed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_polls
    ADD CONSTRAINT room_polls_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: room_polls room_polls_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_polls
    ADD CONSTRAINT room_polls_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_polls room_polls_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_polls
    ADD CONSTRAINT room_polls_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_read_states room_read_states_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_read_states
    ADD CONSTRAINT room_read_states_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_read_states room_read_states_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_read_states
    ADD CONSTRAINT room_read_states_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_realtime_snapshots room_realtime_snapshots_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_realtime_snapshots
    ADD CONSTRAINT room_realtime_snapshots_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_realtime_snapshots room_realtime_snapshots_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_realtime_snapshots
    ADD CONSTRAINT room_realtime_snapshots_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_recording_consents room_recording_consents_recording_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_recording_consents
    ADD CONSTRAINT room_recording_consents_recording_id_fkey FOREIGN KEY (recording_id) REFERENCES public.room_recordings(id) ON DELETE CASCADE;


--
-- Name: room_recording_consents room_recording_consents_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_recording_consents
    ADD CONSTRAINT room_recording_consents_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_recording_consents room_recording_consents_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_recording_consents
    ADD CONSTRAINT room_recording_consents_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_recording_transcripts room_recording_transcripts_recording_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_recording_transcripts
    ADD CONSTRAINT room_recording_transcripts_recording_id_fkey FOREIGN KEY (recording_id) REFERENCES public.room_recordings(id) ON DELETE CASCADE;


--
-- Name: room_recording_transcripts room_recording_transcripts_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_recording_transcripts
    ADD CONSTRAINT room_recording_transcripts_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_recording_transcripts room_recording_transcripts_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_recording_transcripts
    ADD CONSTRAINT room_recording_transcripts_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: room_recordings room_recordings_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_recordings
    ADD CONSTRAINT room_recordings_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_recordings room_recordings_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_recordings
    ADD CONSTRAINT room_recordings_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_resource_notes room_resource_notes_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_resource_notes
    ADD CONSTRAINT room_resource_notes_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.room_study_resources(id) ON DELETE CASCADE;


--
-- Name: room_resource_notes room_resource_notes_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_resource_notes
    ADD CONSTRAINT room_resource_notes_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_resource_notes room_resource_notes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_resource_notes
    ADD CONSTRAINT room_resource_notes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_resource_progress room_resource_progress_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_resource_progress
    ADD CONSTRAINT room_resource_progress_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.room_study_resources(id) ON DELETE CASCADE;


--
-- Name: room_resource_progress room_resource_progress_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_resource_progress
    ADD CONSTRAINT room_resource_progress_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_resource_progress room_resource_progress_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_resource_progress
    ADD CONSTRAINT room_resource_progress_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_role_permissions room_role_permissions_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_role_permissions
    ADD CONSTRAINT room_role_permissions_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_study_resources room_study_resources_added_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_study_resources
    ADD CONSTRAINT room_study_resources_added_by_fkey FOREIGN KEY (added_by) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_study_resources room_study_resources_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_study_resources
    ADD CONSTRAINT room_study_resources_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.temporary_media(id) ON DELETE CASCADE;


--
-- Name: room_study_resources room_study_resources_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_study_resources
    ADD CONSTRAINT room_study_resources_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_tasks room_tasks_assignee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_tasks
    ADD CONSTRAINT room_tasks_assignee_id_fkey FOREIGN KEY (assignee_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: room_tasks room_tasks_completed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_tasks
    ADD CONSTRAINT room_tasks_completed_by_fkey FOREIGN KEY (completed_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: room_tasks room_tasks_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_tasks
    ADD CONSTRAINT room_tasks_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_tasks room_tasks_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_tasks
    ADD CONSTRAINT room_tasks_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_templates room_templates_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_templates
    ADD CONSTRAINT room_templates_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_timer_sessions room_timer_sessions_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_timer_sessions
    ADD CONSTRAINT room_timer_sessions_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_timer_sessions room_timer_sessions_started_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_timer_sessions
    ADD CONSTRAINT room_timer_sessions_started_by_fkey FOREIGN KEY (started_by) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_voice_moderation room_voice_moderation_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_voice_moderation
    ADD CONSTRAINT room_voice_moderation_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_voice_moderation room_voice_moderation_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_voice_moderation
    ADD CONSTRAINT room_voice_moderation_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: room_voice_moderation room_voice_moderation_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_voice_moderation
    ADD CONSTRAINT room_voice_moderation_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_whiteboards room_whiteboards_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_whiteboards
    ADD CONSTRAINT room_whiteboards_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_whiteboards room_whiteboards_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_whiteboards
    ADD CONSTRAINT room_whiteboards_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: rooms rooms_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rooms
    ADD CONSTRAINT rooms_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: rooms rooms_deletion_scheduled_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rooms
    ADD CONSTRAINT rooms_deletion_scheduled_by_fkey FOREIGN KEY (deletion_scheduled_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: site_owners site_owners_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site_owners
    ADD CONSTRAINT site_owners_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: study_note_versions study_note_versions_edited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.study_note_versions
    ADD CONSTRAINT study_note_versions_edited_by_fkey FOREIGN KEY (edited_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: study_note_versions study_note_versions_note_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.study_note_versions
    ADD CONSTRAINT study_note_versions_note_id_fkey FOREIGN KEY (note_id) REFERENCES public.study_notes(id) ON DELETE CASCADE;


--
-- Name: study_note_versions study_note_versions_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.study_note_versions
    ADD CONSTRAINT study_note_versions_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: study_notes study_notes_last_edited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.study_notes
    ADD CONSTRAINT study_notes_last_edited_by_fkey FOREIGN KEY (last_edited_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: study_notes study_notes_locked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.study_notes
    ADD CONSTRAINT study_notes_locked_by_fkey FOREIGN KEY (locked_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: study_notes study_notes_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.study_notes
    ADD CONSTRAINT study_notes_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: study_notes study_notes_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.study_notes
    ADD CONSTRAINT study_notes_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: study_sessions study_sessions_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.study_sessions
    ADD CONSTRAINT study_sessions_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: study_sessions study_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.study_sessions
    ADD CONSTRAINT study_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: temporary_media_cleanup_jobs temporary_media_cleanup_jobs_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_media_cleanup_jobs
    ADD CONSTRAINT temporary_media_cleanup_jobs_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.temporary_media(id) ON DELETE CASCADE;


--
-- Name: temporary_media temporary_media_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_media
    ADD CONSTRAINT temporary_media_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: temporary_media temporary_media_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_media
    ADD CONSTRAINT temporary_media_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: user_blocks user_blocks_blocked_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_blocks
    ADD CONSTRAINT user_blocks_blocked_id_fkey FOREIGN KEY (blocked_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: user_blocks user_blocks_blocker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_blocks
    ADD CONSTRAINT user_blocks_blocker_id_fkey FOREIGN KEY (blocker_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: user_keys user_keys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_keys
    ADD CONSTRAINT user_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_members Active room members respect ghost visibility; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Active room members respect ghost visibility" ON public.room_members FOR SELECT TO authenticated USING (public.room_can_view_member(room_id, user_id, auth.uid()));


--
-- Name: user_keys Allow read access to public keys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow read access to public keys" ON public.user_keys FOR SELECT TO authenticated USING (true);


--
-- Name: room_permanent_requests Approved members can request permanence; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Approved members can request permanence" ON public.room_permanent_requests FOR INSERT TO authenticated WITH CHECK (((requester_id = auth.uid()) AND (status = 'pending'::text) AND public.room_has_active_access(room_id) AND public.is_approved_room_member(room_id, auth.uid()) AND (EXISTS ( SELECT 1
   FROM public.rooms r
  WHERE ((r.id = room_permanent_requests.room_id) AND (r.expiration_type = 'recoverable'::text) AND (r.reopened_until IS NOT NULL) AND (r.reopened_until > now()))))));


--
-- Name: recovery_requests Approved members can request recovery; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Approved members can request recovery" ON public.recovery_requests FOR INSERT TO authenticated WITH CHECK (((requester_id = auth.uid()) AND (status = 'pending'::text) AND (reviewed_at IS NULL) AND (reviewed_by IS NULL) AND public.can_request_room_recovery(room_id)));


--
-- Name: temporary_media Approved members can upload active temporary media; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Approved members can upload active temporary media" ON public.temporary_media FOR INSERT TO authenticated WITH CHECK (((auth.uid() = user_id) AND (expires_at > now()) AND public.room_has_capability(room_id, auth.uid(), 'watch_control'::text)));


--
-- Name: message_reactions Approved members can view active room reactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Approved members can view active room reactions" ON public.message_reactions FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.room_messages msg
  WHERE ((msg.id = message_reactions.message_id) AND public.room_has_active_access(msg.room_id) AND public.is_approved_room_member(msg.room_id, auth.uid())))));


--
-- Name: temporary_media Approved members can view active temporary media; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Approved members can view active temporary media" ON public.temporary_media FOR SELECT TO authenticated USING (((expires_at > now()) AND public.room_has_capability(room_id, auth.uid(), 'watch'::text)));


--
-- Name: messages Approved members read active room messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Approved members read active room messages" ON public.messages FOR SELECT TO authenticated USING (((room_id IS NOT NULL) AND public.room_has_capability(room_id, auth.uid(), 'chat'::text)));


--
-- Name: room_messages Approved members read active room messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Approved members read active room messages" ON public.room_messages FOR SELECT TO authenticated USING (public.room_has_capability(room_id, auth.uid(), 'chat'::text));


--
-- Name: room_activity Approved members read room activity; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Approved members read room activity" ON public.room_activity FOR SELECT TO authenticated USING ((public.room_has_active_access(room_id) AND public.is_approved_room_member(room_id, auth.uid())));


--
-- Name: room_messages Approved members send active room messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Approved members send active room messages" ON public.room_messages FOR INSERT TO authenticated WITH CHECK (((auth.uid() = user_id) AND public.room_has_capability(room_id, auth.uid(), 'chat'::text)));


--
-- Name: messages Approved senders can update active room messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Approved senders can update active room messages" ON public.messages FOR UPDATE TO authenticated USING (((room_id IS NOT NULL) AND (sender_id = auth.uid()) AND public.room_has_capability(room_id, auth.uid(), 'chat'::text))) WITH CHECK (((room_id IS NOT NULL) AND (sender_id = auth.uid()) AND public.room_has_capability(room_id, auth.uid(), 'chat'::text)));


--
-- Name: rooms Authenticated users can create rooms; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can create rooms" ON public.rooms FOR INSERT TO authenticated WITH CHECK (((auth.uid() = created_by) AND (((expiration_type = 'permanent'::text) AND (expires_at IS NULL)) OR ((expiration_type = ANY (ARRAY['recoverable'::text, 'irreversible'::text])) AND (expires_at IS NOT NULL) AND (expires_at > now())))));


--
-- Name: rooms Authorized users can view active rooms; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authorized users can view active rooms" ON public.rooms FOR SELECT TO authenticated USING ((((created_by = auth.uid()) AND ((expiration_type = 'permanent'::text) OR ((expires_at IS NOT NULL) AND (expires_at > now())) OR ((reopened_until IS NOT NULL) AND (reopened_until > now())))) OR (public.room_has_active_access(id) AND ((NOT is_private) OR public.is_approved_room_member(id, auth.uid())))));


--
-- Name: user_blocks Blockers read their own blocks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Blockers read their own blocks" ON public.user_blocks FOR SELECT TO authenticated USING ((blocker_id = auth.uid()));


--
-- Name: room_countdowns Chat members read countdowns; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Chat members read countdowns" ON public.room_countdowns FOR SELECT TO authenticated USING (public.room_has_capability(room_id, auth.uid(), 'chat'::text));


--
-- Name: room_polls Chat members read polls; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Chat members read polls" ON public.room_polls FOR SELECT TO authenticated USING (public.room_has_capability(room_id, auth.uid(), 'chat'::text));


--
-- Name: room_hand_raises Chat members read raised hands; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Chat members read raised hands" ON public.room_hand_raises FOR SELECT TO authenticated USING (public.room_has_capability(room_id, auth.uid(), 'chat'::text));


--
-- Name: room_events Chat members read room events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Chat members read room events" ON public.room_events FOR SELECT TO authenticated USING (public.room_has_capability(room_id, auth.uid(), 'chat'::text));


--
-- Name: room_message_reactions Chat members read room message reactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Chat members read room message reactions" ON public.room_message_reactions FOR SELECT TO authenticated USING (public.room_has_capability(room_id, auth.uid(), 'chat'::text));


--
-- Name: room_voice_moderation Chat members read voice moderation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Chat members read voice moderation" ON public.room_voice_moderation FOR SELECT TO authenticated USING (public.room_has_capability(room_id, auth.uid(), 'chat'::text));


--
-- Name: room_group_conversions Group managers read conversion records; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Group managers read conversion records" ON public.room_group_conversions FOR SELECT TO authenticated USING (public.is_group_manager(group_id, auth.uid()));


--
-- Name: group_messages Group members read group messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Group members read group messages" ON public.group_messages FOR SELECT TO authenticated USING (public.is_group_member(group_id, auth.uid()));


--
-- Name: group_members Group members read the member list; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Group members read the member list" ON public.group_members FOR SELECT TO authenticated USING (public.is_group_member(group_id, auth.uid()));


--
-- Name: groups Group members read their groups; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Group members read their groups" ON public.groups FOR SELECT TO authenticated USING (public.is_group_member(id, auth.uid()));


--
-- Name: group_messages Group members send as themselves; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Group members send as themselves" ON public.group_messages FOR INSERT TO authenticated WITH CHECK (((sender_id = auth.uid()) AND public.is_group_member(group_id, auth.uid())));


--
-- Name: music_listening_history Listeners clear their history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Listeners clear their history" ON public.music_listening_history FOR DELETE TO authenticated USING ((user_id = auth.uid()));


--
-- Name: music_listening_history Listeners read their history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Listeners read their history" ON public.music_listening_history FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: music_settings Listeners read their music settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Listeners read their music settings" ON public.music_settings FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: room_member_restrictions Managers read restrictions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Managers read restrictions" ON public.room_member_restrictions FOR SELECT TO authenticated USING (public.room_has_capability(room_id, auth.uid(), 'manage_members'::text));


--
-- Name: rooms Members can view their room during its recovery window; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can view their room during its recovery window" ON public.rooms FOR SELECT TO authenticated USING (public.can_view_room_in_recovery_window(id));


--
-- Name: room_announcements Members read announcements; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members read announcements" ON public.room_announcements FOR SELECT TO authenticated USING ((public.room_has_active_access(room_id) AND public.room_feature_enabled(room_id, 'announcements'::text) AND public.is_approved_room_member(room_id, auth.uid())));


--
-- Name: room_control_events Members read room control events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members read room control events" ON public.room_control_events FOR SELECT TO authenticated USING ((public.room_has_active_access(room_id) AND public.is_approved_room_member(room_id, auth.uid())));


--
-- Name: room_member_profiles Members read room profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members read room profiles" ON public.room_member_profiles FOR SELECT TO authenticated USING (public.room_can_view_member(room_id, user_id, auth.uid()));


--
-- Name: room_poll_votes Members read their own poll votes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members read their own poll votes" ON public.room_poll_votes FOR SELECT TO authenticated USING (((user_id = auth.uid()) AND public.room_has_capability(room_id, auth.uid(), 'chat'::text)));


--
-- Name: room_resource_progress Members read their own resource progress; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members read their own resource progress" ON public.room_resource_progress FOR SELECT TO authenticated USING (((user_id = auth.uid()) AND public.room_has_capability(room_id, auth.uid(), 'study'::text)));


--
-- Name: room_read_states Members read their own room read state; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members read their own room read state" ON public.room_read_states FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: room_members Non-owner users can leave active rooms; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Non-owner users can leave active rooms" ON public.room_members FOR DELETE TO authenticated USING (((auth.uid() = user_id) AND (role <> 'owner'::text) AND public.room_has_active_access(room_id)));


--
-- Name: room_permanent_requests Owners and admins can view permanent requests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Owners and admins can view permanent requests" ON public.room_permanent_requests FOR SELECT TO authenticated USING (((requester_id = auth.uid()) OR (public.room_has_active_access(room_id) AND public.is_room_admin_or_owner(room_id, auth.uid()))));


--
-- Name: rooms Owners can update active rooms; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Owners can update active rooms" ON public.rooms FOR UPDATE TO authenticated USING (((auth.uid() = created_by) AND public.room_has_active_access(id))) WITH CHECK ((auth.uid() = created_by));


--
-- Name: music_custom_sources Owners manage their custom sources; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Owners manage their custom sources" ON public.music_custom_sources TO authenticated USING ((owner_id = auth.uid())) WITH CHECK ((owner_id = auth.uid()));


--
-- Name: music_playlist_items Owners manage their playlist items; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Owners manage their playlist items" ON public.music_playlist_items TO authenticated USING ((owner_id = auth.uid())) WITH CHECK (((owner_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM public.music_playlists p
  WHERE ((p.id = music_playlist_items.playlist_id) AND (p.owner_id = auth.uid())))) AND (EXISTS ( SELECT 1
   FROM public.music_uploads u
  WHERE ((u.id = music_playlist_items.upload_id) AND (u.owner_id = auth.uid()))))));


--
-- Name: music_playlists Owners manage their playlists; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Owners manage their playlists" ON public.music_playlists TO authenticated USING ((owner_id = auth.uid())) WITH CHECK ((owner_id = auth.uid()));


--
-- Name: music_upload_shares Owners read their music shares; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Owners read their music shares" ON public.music_upload_shares FOR SELECT TO authenticated USING ((owner_id = auth.uid()));


--
-- Name: music_uploads Owners read their music uploads; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Owners read their music uploads" ON public.music_uploads FOR SELECT TO authenticated USING ((owner_id = auth.uid()));


--
-- Name: messages Participants read private messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Participants read private messages" ON public.messages FOR SELECT TO authenticated USING (((chat_id IS NOT NULL) AND ((auth.uid() = sender_id) OR (auth.uid() = receiver_id))));


--
-- Name: room_recording_consents Participants read recording consent; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Participants read recording consent" ON public.room_recording_consents FOR SELECT TO authenticated USING (public.can_view_room_recording(recording_id));


--
-- Name: room_recordings Participants read recordings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Participants read recordings" ON public.room_recordings FOR SELECT TO authenticated USING (public.can_view_room_recording(id));


--
-- Name: room_recording_transcripts Participants read transcripts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Participants read transcripts" ON public.room_recording_transcripts FOR SELECT TO authenticated USING (public.can_view_room_recording(recording_id));


--
-- Name: private_chats Participants view own chats; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Participants view own chats" ON public.private_chats FOR SELECT TO authenticated USING (((auth.uid() = user_one) OR (auth.uid() = user_two)));


--
-- Name: messages Private messages go only to the other participant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Private messages go only to the other participant" ON public.messages AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (((chat_id IS NULL) OR ((public.private_chat_type(chat_id) IS NOT NULL) AND (room_id IS NULL) AND (content IS NULL) AND (receiver_id = ( SELECT
        CASE
            WHEN (pc.user_one = auth.uid()) THEN pc.user_two
            ELSE pc.user_one
        END AS user_one
   FROM public.private_chats pc
  WHERE (pc.id = messages.chat_id))))));


--
-- Name: messages Private messages require active conversation access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Private messages require active conversation access" ON public.messages AS RESTRICTIVE FOR SELECT TO authenticated USING (((chat_id IS NULL) OR (public.private_chat_type(chat_id) IS NOT NULL)));


--
-- Name: rooms Public active rooms are viewable by everyone; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public active rooms are viewable by everyone" ON public.rooms FOR SELECT TO authenticated, anon USING (((NOT is_private) AND public.room_has_active_access(id)));


--
-- Name: room_event_rsvps Read own or managed RSVPs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Read own or managed RSVPs" ON public.room_event_rsvps FOR SELECT TO authenticated USING (((user_id = auth.uid()) OR public.room_has_capability(room_id, auth.uid(), 'manage_announcements'::text)));


--
-- Name: conversation_reads Readers see their own read state; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Readers see their own read state" ON public.conversation_reads FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: room_notifications Recipients can mark notifications read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Recipients can mark notifications read" ON public.room_notifications FOR UPDATE TO authenticated USING ((recipient_id = auth.uid())) WITH CHECK ((recipient_id = auth.uid()));


--
-- Name: room_notifications Recipients can read room notifications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Recipients can read room notifications" ON public.room_notifications FOR SELECT TO authenticated USING ((recipient_id = auth.uid()));


--
-- Name: room_members Recovery managers can view room membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Recovery managers can view room membership" ON public.room_members FOR SELECT TO authenticated USING ((public.room_in_recovery_window(room_id) AND public.is_room_admin_or_owner(room_id, auth.uid())));


--
-- Name: room_control_events Removed members read own moderation event; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Removed members read own moderation event" ON public.room_control_events FOR SELECT TO authenticated USING (((subject_user_id = auth.uid()) AND (event_type = ANY (ARRAY['membership_changed'::text, 'restriction_changed'::text]))));


--
-- Name: recovery_requests Requesters and site owners can view recovery requests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Requesters and site owners can view recovery requests" ON public.recovery_requests FOR SELECT TO authenticated USING (((requester_id = auth.uid()) OR public.is_site_owner(auth.uid())));


--
-- Name: room_exports Room managers read export audit; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Room managers read export audit" ON public.room_exports FOR SELECT TO authenticated USING (public.is_room_admin_or_owner(room_id, auth.uid()));


--
-- Name: room_control_settings Room members read controls; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Room members read controls" ON public.room_control_settings FOR SELECT TO authenticated USING ((public.room_has_active_access(room_id) AND public.is_approved_room_member(room_id, auth.uid())));


--
-- Name: room_role_permissions Room members read permissions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Room members read permissions" ON public.room_role_permissions FOR SELECT TO authenticated USING ((public.room_has_active_access(room_id) AND public.is_approved_room_member(room_id, auth.uid())));


--
-- Name: group_messages Senders and group managers delete group messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Senders and group managers delete group messages" ON public.group_messages FOR DELETE TO authenticated USING ((public.is_group_member(group_id, auth.uid()) AND ((sender_id = auth.uid()) OR public.is_group_manager(group_id, auth.uid()))));


--
-- Name: site_owners Site owners can see their own row; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Site owners can see their own row" ON public.site_owners FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: pdf_annotations Study members read PDF annotations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Study members read PDF annotations" ON public.pdf_annotations FOR SELECT TO authenticated USING ((public.room_has_capability(room_id, auth.uid(), 'study'::text) AND public.room_has_capability(room_id, auth.uid(), 'files'::text)));


--
-- Name: room_resource_notes Study members read resource notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Study members read resource notes" ON public.room_resource_notes FOR SELECT TO authenticated USING ((public.room_has_capability(room_id, auth.uid(), 'study'::text) AND ((scope = 'room'::text) OR (user_id = auth.uid()))));


--
-- Name: room_study_resources Study members read resources; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Study members read resources" ON public.room_study_resources FOR SELECT TO authenticated USING (public.room_has_capability(room_id, auth.uid(), 'study'::text));


--
-- Name: study_notes Study members read scoped notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Study members read scoped notes" ON public.study_notes FOR SELECT TO authenticated USING ((public.room_has_capability(room_id, auth.uid(), 'study'::text) AND ((scope = 'room'::text) OR (owner_id = auth.uid()))));


--
-- Name: room_tasks Study members read tasks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Study members read tasks" ON public.room_tasks FOR SELECT TO authenticated USING (public.room_has_capability(room_id, auth.uid(), 'study'::text));


--
-- Name: room_whiteboards Study members read whiteboards; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Study members read whiteboards" ON public.room_whiteboards FOR SELECT TO authenticated USING (public.room_has_capability(room_id, auth.uid(), 'study'::text));


--
-- Name: private_chats Users can create chats; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create chats" ON public.private_chats FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_one));


--
-- Name: messages Users can insert messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert messages" ON public.messages FOR INSERT TO authenticated WITH CHECK ((((chat_id IS NOT NULL) AND (auth.uid() = sender_id) AND (EXISTS ( SELECT 1
   FROM public.private_chats pc
  WHERE ((pc.id = messages.chat_id) AND ((pc.user_one = auth.uid()) OR (pc.user_two = auth.uid())) AND (public.is_current_friend(pc.user_one, pc.user_two) OR (EXISTS ( SELECT 1
           FROM public.message_requests mr
          WHERE ((mr.status = 'accepted'::text) AND (messages.receiver_id =
                CASE
                    WHEN (pc.user_one = auth.uid()) THEN pc.user_two
                    ELSE pc.user_one
                END) AND (((mr.requester_id = pc.user_one) AND (mr.recipient_id = pc.user_two)) OR ((mr.requester_id = pc.user_two) AND (mr.recipient_id = pc.user_one))))))))))) OR ((room_id IS NOT NULL) AND (auth.uid() = sender_id) AND public.room_has_capability(room_id, auth.uid(), 'chat'::text))));


--
-- Name: message_reactions Users can manage reactions in active rooms; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can manage reactions in active rooms" ON public.message_reactions TO authenticated USING (((auth.uid() = user_id) AND (EXISTS ( SELECT 1
   FROM public.room_messages msg
  WHERE ((msg.id = message_reactions.message_id) AND public.room_has_active_access(msg.room_id) AND public.is_approved_room_member(msg.room_id, auth.uid())))))) WITH CHECK (((auth.uid() = user_id) AND (EXISTS ( SELECT 1
   FROM public.room_messages msg
  WHERE ((msg.id = message_reactions.message_id) AND public.room_has_active_access(msg.room_id) AND public.is_approved_room_member(msg.room_id, auth.uid()))))));


--
-- Name: room_members Users can request to join active rooms; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can request to join active rooms" ON public.room_members FOR INSERT TO authenticated WITH CHECK (((auth.uid() = user_id) AND public.room_has_active_access(room_id) AND public.room_can_join(room_id, auth.uid()) AND (((role = 'owner'::text) AND (join_status = 'approved'::text) AND (EXISTS ( SELECT 1
   FROM public.rooms r
  WHERE ((r.id = room_members.room_id) AND (r.created_by = auth.uid()))))) OR ((role = 'member'::text) AND (join_status = ANY (ARRAY['pending'::text, 'approved'::text])) AND (NOT COALESCE(( SELECT s.is_locked
   FROM public.room_control_settings s
  WHERE (s.room_id = room_members.room_id)), false)) AND ((join_status = 'pending'::text) OR (EXISTS ( SELECT 1
   FROM public.rooms r
  WHERE ((r.id = room_members.room_id) AND (NOT r.is_private)))))))));


--
-- Name: notification_preferences Users can see their own notification preferences; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can see their own notification preferences" ON public.notification_preferences FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: study_sessions Users manage study sessions in active rooms; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage study sessions in active rooms" ON public.study_sessions TO authenticated USING (((auth.uid() = user_id) AND ((room_id IS NULL) OR public.room_has_capability(room_id, auth.uid(), 'study'::text)))) WITH CHECK (((auth.uid() = user_id) AND ((room_id IS NULL) OR public.room_has_capability(room_id, auth.uid(), 'study'::text))));


--
-- Name: room_templates Users read built-in and own templates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users read built-in and own templates" ON public.room_templates FOR SELECT TO authenticated USING (((owner_id IS NULL) OR (owner_id = auth.uid())));


--
-- Name: room_bookmarks Users read their own bookmarks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users read their own bookmarks" ON public.room_bookmarks FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: user_keys Users update own public key; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users update own public key" ON public.user_keys TO authenticated USING ((auth.uid() = user_id));


--
-- Name: room_media_clips Watch members read room clips; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Watch members read room clips" ON public.room_media_clips FOR SELECT TO authenticated USING (public.room_has_capability(room_id, auth.uid(), 'watch'::text));


--
-- Name: room_media_queue Watch members read the room queue; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Watch members read the room queue" ON public.room_media_queue FOR SELECT TO authenticated USING (public.room_has_capability(room_id, auth.uid(), 'watch'::text));


--
-- Name: conversation_reads; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversation_reads ENABLE ROW LEVEL SECURITY;

--
-- Name: follows; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;

--
-- Name: follows follows_select_involved; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY follows_select_involved ON public.follows FOR SELECT TO authenticated USING (((auth.uid() = follower_id) OR (auth.uid() = following_id)));


--
-- Name: friend_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.friend_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: friend_requests friend_requests_select_involved; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY friend_requests_select_involved ON public.friend_requests FOR SELECT TO authenticated USING (((auth.uid() = requester_id) OR (auth.uid() = recipient_id)));


--
-- Name: friendships; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;

--
-- Name: friendships friendships_delete_involved; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY friendships_delete_involved ON public.friendships FOR DELETE TO authenticated USING (((auth.uid() = user_one) OR (auth.uid() = user_two)));


--
-- Name: friendships friendships_select_involved; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY friendships_select_involved ON public.friendships FOR SELECT TO authenticated USING (((auth.uid() = user_one) OR (auth.uid() = user_two)));


--
-- Name: group_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;

--
-- Name: group_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.group_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: groups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;

--
-- Name: message_reactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.message_reactions ENABLE ROW LEVEL SECURITY;

--
-- Name: message_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.message_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: message_requests message_requests_select_involved; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY message_requests_select_involved ON public.message_requests FOR SELECT TO authenticated USING (((auth.uid() = requester_id) OR (auth.uid() = recipient_id)));


--
-- Name: messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

--
-- Name: music_custom_sources; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.music_custom_sources ENABLE ROW LEVEL SECURITY;

--
-- Name: music_listen_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.music_listen_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: music_listening_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.music_listening_history ENABLE ROW LEVEL SECURITY;

--
-- Name: music_now_playing; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.music_now_playing ENABLE ROW LEVEL SECURITY;

--
-- Name: music_playlist_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.music_playlist_items ENABLE ROW LEVEL SECURITY;

--
-- Name: music_playlists; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.music_playlists ENABLE ROW LEVEL SECURITY;

--
-- Name: music_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.music_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: music_upload_shares; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.music_upload_shares ENABLE ROW LEVEL SECURITY;

--
-- Name: music_uploads; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.music_uploads ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_preferences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;

--
-- Name: pdf_annotations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pdf_annotations ENABLE ROW LEVEL SECURITY;

--
-- Name: posts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;

--
-- Name: posts posts_delete_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY posts_delete_own ON public.posts FOR DELETE TO authenticated USING ((auth.uid() = author_id));


--
-- Name: posts posts_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY posts_insert_own ON public.posts FOR INSERT TO authenticated WITH CHECK ((auth.uid() = author_id));


--
-- Name: posts posts_select_visible; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY posts_select_visible ON public.posts FOR SELECT TO authenticated USING (((auth.uid() = author_id) OR ((deleted_at IS NULL) AND public.can_view_post(author_id, visibility))));


--
-- Name: posts posts_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY posts_update_own ON public.posts FOR UPDATE TO authenticated USING ((auth.uid() = author_id)) WITH CHECK ((auth.uid() = author_id));


--
-- Name: private_chats; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.private_chats ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles profiles_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_insert_own ON public.profiles FOR INSERT TO authenticated WITH CHECK ((auth.uid() = id));


--
-- Name: profiles profiles_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_select_own ON public.profiles FOR SELECT TO authenticated USING ((auth.uid() = id));


--
-- Name: profiles profiles_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_update_own ON public.profiles FOR UPDATE TO authenticated USING ((auth.uid() = id)) WITH CHECK ((auth.uid() = id));


--
-- Name: recovery_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.recovery_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: room_activity; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_activity ENABLE ROW LEVEL SECURITY;

--
-- Name: room_announcements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_announcements ENABLE ROW LEVEL SECURITY;

--
-- Name: room_bookmarks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_bookmarks ENABLE ROW LEVEL SECURITY;

--
-- Name: room_cleanup_jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_cleanup_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: room_control_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_control_events ENABLE ROW LEVEL SECURITY;

--
-- Name: room_control_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_control_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: room_countdowns; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_countdowns ENABLE ROW LEVEL SECURITY;

--
-- Name: room_event_rsvps; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_event_rsvps ENABLE ROW LEVEL SECURITY;

--
-- Name: room_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_events ENABLE ROW LEVEL SECURITY;

--
-- Name: room_exports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_exports ENABLE ROW LEVEL SECURITY;

--
-- Name: room_files; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_files ENABLE ROW LEVEL SECURITY;

--
-- Name: room_group_conversions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_group_conversions ENABLE ROW LEVEL SECURITY;

--
-- Name: room_hand_raises; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_hand_raises ENABLE ROW LEVEL SECURITY;

--
-- Name: room_invites; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_invites ENABLE ROW LEVEL SECURITY;

--
-- Name: room_media_clips; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_media_clips ENABLE ROW LEVEL SECURITY;

--
-- Name: room_media_queue; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_media_queue ENABLE ROW LEVEL SECURITY;

--
-- Name: room_member_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_member_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: room_member_restrictions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_member_restrictions ENABLE ROW LEVEL SECURITY;

--
-- Name: room_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_members ENABLE ROW LEVEL SECURITY;

--
-- Name: room_message_reactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_message_reactions ENABLE ROW LEVEL SECURITY;

--
-- Name: room_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: room_notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: room_permanent_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_permanent_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: room_poll_votes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_poll_votes ENABLE ROW LEVEL SECURITY;

--
-- Name: room_polls; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_polls ENABLE ROW LEVEL SECURITY;

--
-- Name: room_read_states; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_read_states ENABLE ROW LEVEL SECURITY;

--
-- Name: room_realtime_snapshots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_realtime_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: room_recording_consents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_recording_consents ENABLE ROW LEVEL SECURITY;

--
-- Name: room_recording_transcripts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_recording_transcripts ENABLE ROW LEVEL SECURITY;

--
-- Name: room_recordings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_recordings ENABLE ROW LEVEL SECURITY;

--
-- Name: room_resource_notes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_resource_notes ENABLE ROW LEVEL SECURITY;

--
-- Name: room_resource_progress; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_resource_progress ENABLE ROW LEVEL SECURITY;

--
-- Name: room_role_permissions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_role_permissions ENABLE ROW LEVEL SECURITY;

--
-- Name: room_study_resources; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_study_resources ENABLE ROW LEVEL SECURITY;

--
-- Name: room_tasks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: room_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: room_timer_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_timer_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: room_voice_moderation; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_voice_moderation ENABLE ROW LEVEL SECURITY;

--
-- Name: room_whiteboards; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_whiteboards ENABLE ROW LEVEL SECURITY;

--
-- Name: rooms; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;

--
-- Name: site_owners; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.site_owners ENABLE ROW LEVEL SECURITY;

--
-- Name: study_note_versions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.study_note_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: study_notes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.study_notes ENABLE ROW LEVEL SECURITY;

--
-- Name: study_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.study_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: temporary_media; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.temporary_media ENABLE ROW LEVEL SECURITY;

--
-- Name: temporary_media_cleanup_jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.temporary_media_cleanup_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: user_blocks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_blocks ENABLE ROW LEVEL SECURITY;

--
-- Name: user_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_keys ENABLE ROW LEVEL SECURITY;

--
-- Hostel roadmap phases 02–03 (20261110071321, 20261110071805). Added in
-- pg_dump format without a fresh dump (pg_dump isn't installed on the machine
-- that applied them); the next full regeneration replaces this block.
--

--
-- Name: product_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_events (
    id bigint NOT NULL,
    event text NOT NULL,
    room_id uuid,
    ref text,
    meta jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT product_events_event_check CHECK ((event = ANY (ARRAY['room_created'::text, 'invite_created'::text, 'share_completed'::text, 'call_in_shared'::text, 'join_viewed'::text, 'joined'::text, 'guest_joined'::text, 'spot_joined'::text, 'drop_in'::text, 'knock_sent'::text, 'timer_started'::text, 'timer_completed'::text, 'room_tick'::text, 'recap_shared'::text, 'report_created'::text]))),
    CONSTRAINT product_events_meta_check CHECK ((pg_column_size(meta) <= 512)),
    CONSTRAINT product_events_ref_check CHECK ((ref ~ '^[a-z0-9-]{1,40}$'::text))
);

COMMENT ON TABLE public.product_events IS 'Anonymous product metrics. No user ids, IPs, message text or titles. Written only through log_product_event / room_heartbeat.';

ALTER TABLE public.product_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.product_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE ONLY public.product_events
    ADD CONSTRAINT product_events_pkey PRIMARY KEY (id);

CREATE INDEX product_events_event_created_at_idx ON public.product_events USING btree (event, created_at);

CREATE INDEX product_events_room_created_at_idx ON public.product_events USING btree (room_id, created_at);

ALTER TABLE public.product_events ENABLE ROW LEVEL SECURITY;

--
-- Name: room_live_status; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_live_status (
    room_id uuid NOT NULL,
    people integer DEFAULT 0 NOT NULL,
    desk integer DEFAULT 0 NOT NULL,
    screen integer DEFAULT 0 NOT NULL,
    speaker integer DEFAULT 0 NOT NULL,
    bed integer DEFAULT 0 NOT NULL,
    door text DEFAULT 'open'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT room_live_status_bed_check CHECK (((bed >= 0) AND (bed <= 50))),
    CONSTRAINT room_live_status_desk_check CHECK (((desk >= 0) AND (desk <= 50))),
    CONSTRAINT room_live_status_door_check CHECK ((door = ANY (ARRAY['open'::text, 'knock'::text, 'dnd'::text]))),
    CONSTRAINT room_live_status_people_check CHECK (((people >= 0) AND (people <= 50))),
    CONSTRAINT room_live_status_screen_check CHECK (((screen >= 0) AND (screen <= 50))),
    CONSTRAINT room_live_status_speaker_check CHECK (((speaker >= 0) AND (speaker <= 50)))
);

COMMENT ON TABLE public.room_live_status IS 'Live counts per room from the public presence channel. Counts only, no user ids. Written only through room_heartbeat.';

ALTER TABLE ONLY public.room_live_status
    ADD CONSTRAINT room_live_status_pkey PRIMARY KEY (room_id);

ALTER TABLE ONLY public.room_live_status
    ADD CONSTRAINT room_live_status_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;

ALTER TABLE public.room_live_status ENABLE ROW LEVEL SECURITY;

--
-- Name: night_date(timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.night_date(ts timestamp with time zone) RETURNS date
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO ''
    AS $$
  SELECT ((ts AT TIME ZONE 'Asia/Kolkata') - interval '6 hours')::date;
$$;

--
-- Name: log_product_event(text, uuid, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.log_product_event(p_event text, p_room_id uuid DEFAULT NULL::uuid, p_ref text DEFAULT NULL::text, p_meta jsonb DEFAULT NULL::jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  meta_key text;
  meta_value jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in to log events.' USING ERRCODE = '42501';
  END IF;

  IF p_event IS NULL OR p_event NOT IN (
    'room_created', 'invite_created', 'share_completed', 'call_in_shared',
    'join_viewed', 'joined', 'guest_joined', 'spot_joined', 'drop_in',
    'knock_sent', 'timer_started', 'timer_completed',
    'recap_shared', 'report_created'
  ) THEN
    RAISE EXCEPTION 'Unknown event.' USING ERRCODE = '22023';
  END IF;

  IF p_ref IS NOT NULL AND p_ref !~ '^[a-z0-9-]{1,40}$' THEN
    RAISE EXCEPTION 'Invalid ref.' USING ERRCODE = '22023';
  END IF;

  IF p_meta IS NOT NULL THEN
    IF jsonb_typeof(p_meta) <> 'object' OR pg_column_size(p_meta) > 512 THEN
      RAISE EXCEPTION 'Invalid meta.' USING ERRCODE = '22023';
    END IF;
    FOR meta_key, meta_value IN SELECT key, value FROM jsonb_each(p_meta) LOOP
      IF meta_key NOT IN ('spot', 'people', 'minutes', 'template', 'from', 'variant') THEN
        RAISE EXCEPTION 'Invalid meta key.' USING ERRCODE = '22023';
      END IF;
      IF jsonb_typeof(meta_value) = 'string' THEN
        IF length(meta_value #>> '{}') > 40 THEN
          RAISE EXCEPTION 'Invalid meta value.' USING ERRCODE = '22023';
        END IF;
      ELSIF jsonb_typeof(meta_value) = 'number' THEN
        IF (meta_value #>> '{}')::numeric NOT BETWEEN -100000 AND 100000 THEN
          RAISE EXCEPTION 'Invalid meta value.' USING ERRCODE = '22023';
        END IF;
      ELSIF jsonb_typeof(meta_value) <> 'boolean' THEN
        RAISE EXCEPTION 'Invalid meta value.' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;

  IF p_room_id IS NOT NULL AND NOT public.is_approved_room_member(p_room_id, auth.uid()) THEN
    RAISE EXCEPTION 'Not a member of this room.' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.product_events (event, room_id, ref, meta)
  VALUES (p_event, p_room_id, p_ref, p_meta);
END;
$$;

--
-- Name: room_heartbeat(uuid, integer, jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.room_heartbeat(p_room_id uuid, p_people integer, p_spots jsonb, p_door text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_people integer;
  v_desk integer;
  v_screen integer;
  v_speaker integer;
  v_bed integer;
  v_door text;
  v_spots jsonb := CASE WHEN jsonb_typeof(p_spots) = 'object' THEN p_spots ELSE '{}'::jsonb END;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in first.' USING ERRCODE = '42501';
  END IF;

  IF p_room_id IS NULL OR NOT public.is_approved_room_member(p_room_id, auth.uid()) THEN
    RAISE EXCEPTION 'Not a member of this room.' USING ERRCODE = '42501';
  END IF;

  -- Clamp everything to 0..50; anything that isn't a number counts as 0.
  v_people := LEAST(GREATEST(COALESCE(p_people, 0), 0), 50);
  v_desk := CASE WHEN jsonb_typeof(v_spots -> 'desk') = 'number' THEN LEAST(GREATEST(floor((v_spots ->> 'desk')::numeric), 0), 50)::integer ELSE 0 END;
  v_screen := CASE WHEN jsonb_typeof(v_spots -> 'screen') = 'number' THEN LEAST(GREATEST(floor((v_spots ->> 'screen')::numeric), 0), 50)::integer ELSE 0 END;
  v_speaker := CASE WHEN jsonb_typeof(v_spots -> 'speaker') = 'number' THEN LEAST(GREATEST(floor((v_spots ->> 'speaker')::numeric), 0), 50)::integer ELSE 0 END;
  v_bed := CASE WHEN jsonb_typeof(v_spots -> 'bed') = 'number' THEN LEAST(GREATEST(floor((v_spots ->> 'bed')::numeric), 0), 50)::integer ELSE 0 END;
  v_door := CASE WHEN p_door IN ('open', 'knock', 'dnd') THEN p_door ELSE 'open' END;

  -- The upsert locks the room's row, so concurrent heartbeats run one at a
  -- time and the tick check below sees the other's tick.
  INSERT INTO public.room_live_status AS s (room_id, people, desk, screen, speaker, bed, door, updated_at)
  VALUES (p_room_id, v_people, v_desk, v_screen, v_speaker, v_bed, v_door, now())
  ON CONFLICT (room_id) DO UPDATE
  SET people = EXCLUDED.people,
      desk = EXCLUDED.desk,
      screen = EXCLUDED.screen,
      speaker = EXCLUDED.speaker,
      bed = EXCLUDED.bed,
      door = EXCLUDED.door,
      updated_at = now();

  IF v_people >= 2 AND NOT EXISTS (
    SELECT 1
    FROM public.product_events e
    WHERE e.room_id = p_room_id
      AND e.event = 'room_tick'
      AND e.created_at > now() - interval '10 minutes'
  ) THEN
    INSERT INTO public.product_events (event, room_id, meta)
    VALUES ('room_tick', p_room_id, jsonb_build_object(
      'people', v_people, 'desk', v_desk, 'screen', v_screen, 'speaker', v_speaker, 'bed', v_bed
    ));
  END IF;
END;
$$;

--
-- Name: get_my_rooms_live(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_my_rooms_live() RETURNS TABLE(room_id uuid, people integer, desk integer, screen integer, speaker integer, bed integer, door text, fresh boolean)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT s.room_id, s.people, s.desk, s.screen, s.speaker, s.bed, s.door,
         s.updated_at > now() - interval '2 minutes'
  FROM public.room_live_status s
  JOIN public.room_members m ON m.room_id = s.room_id AND m.user_id = auth.uid()
  WHERE auth.uid() IS NOT NULL
    AND public.is_approved_room_member(s.room_id, auth.uid());
$$;

--
-- Hostel roadmap phases 04–05 (20261110103628, 20261110105146). Same format
-- and caveat as the 02–03 block above. rooms.nameplate and
-- room_invites.is_door_key are in their CREATE TABLE statements.
--

--
-- Name: fill_room_nameplate(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fill_room_nameplate() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  IF NEW.nameplate IS NULL THEN
    NEW.nameplate := chr(65 + (abs(hashtext(NEW.id::text)::bigint) % 8)::int)
      || '-' || (101 + (abs(hashtext(NEW.id::text)::bigint) / 8) % 399);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER fill_room_nameplate BEFORE INSERT ON public.rooms FOR EACH ROW EXECUTE FUNCTION public.fill_room_nameplate();

CREATE UNIQUE INDEX room_invites_one_door_key_idx ON public.room_invites USING btree (room_id) WHERE (is_door_key AND (revoked_at IS NULL));

--
-- Name: get_room_door_link(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_room_door_link(p_room_id uuid) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_invite_id uuid;
  v_token text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in first.' USING ERRCODE = '42501';
  END IF;
  IF p_room_id IS NULL THEN
    RAISE EXCEPTION 'Room is required.' USING ERRCODE = '22023';
  END IF;

  v_role := public.room_user_role(p_room_id, v_uid);
  IF NOT public.room_has_active_access(p_room_id)
     OR v_role IS NULL
     OR (v_role = 'guest' AND NOT public.room_has_capability(p_room_id, v_uid, 'manage_invites')) THEN
    RAISE EXCEPTION 'Not allowed to share this room.' USING ERRCODE = '42501';
  END IF;

  SELECT i.token INTO v_token
  FROM public.room_invites i
  WHERE i.room_id = p_room_id AND i.is_door_key AND i.revoked_at IS NULL;
  IF v_token IS NOT NULL THEN
    RETURN v_token;
  END IF;

  INSERT INTO public.room_invites (room_id, token, created_by, is_door_key)
  VALUES (p_room_id, encode(extensions.gen_random_bytes(24), 'hex'), v_uid, true)
  ON CONFLICT (room_id) WHERE is_door_key AND revoked_at IS NULL DO NOTHING
  RETURNING id, token INTO v_invite_id, v_token;

  IF v_token IS NULL THEN
    -- Another member created it at the same moment: share theirs.
    SELECT i.token INTO v_token
    FROM public.room_invites i
    WHERE i.room_id = p_room_id AND i.is_door_key AND i.revoked_at IS NULL;
    RETURN v_token;
  END IF;

  INSERT INTO public.product_events (event, room_id, meta)
  VALUES ('invite_created', p_room_id, jsonb_build_object('from', 'door'));

  PERFORM public.record_room_control_event(
    p_room_id, 'invite_changed', NULL,
    jsonb_build_object('invite_id', v_invite_id, 'state', 'created')
  );

  RETURN v_token;
END;
$$;

--
-- Name: change_room_lock(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.change_room_lock(p_room_id uuid) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_old_id uuid;
  v_invite_id uuid;
  v_token text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in first.' USING ERRCODE = '42501';
  END IF;
  IF p_room_id IS NULL OR NOT public.room_has_capability(p_room_id, v_uid, 'manage_invites') THEN
    RAISE EXCEPTION 'Not allowed to change this room''s lock.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.room_invites
  SET revoked_at = now(), revoked_by = v_uid
  WHERE room_id = p_room_id AND is_door_key AND revoked_at IS NULL
  RETURNING id INTO v_old_id;

  IF v_old_id IS NOT NULL THEN
    PERFORM public.record_room_control_event(
      p_room_id, 'invite_changed', NULL,
      jsonb_build_object('invite_id', v_old_id, 'state', 'revoked')
    );
  END IF;

  INSERT INTO public.room_invites (room_id, token, created_by, is_door_key)
  VALUES (p_room_id, encode(extensions.gen_random_bytes(24), 'hex'), v_uid, true)
  ON CONFLICT (room_id) WHERE is_door_key AND revoked_at IS NULL DO NOTHING
  RETURNING id, token INTO v_invite_id, v_token;

  IF v_token IS NULL THEN
    -- A concurrent change already fitted a new lock: return that one.
    SELECT i.token INTO v_token
    FROM public.room_invites i
    WHERE i.room_id = p_room_id AND i.is_door_key AND i.revoked_at IS NULL;
    RETURN v_token;
  END IF;

  PERFORM public.record_room_control_event(
    p_room_id, 'invite_changed', NULL,
    jsonb_build_object('invite_id', v_invite_id, 'state', 'created')
  );

  RETURN v_token;
END;
$$;

--
-- Name: set_room_nameplate(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_room_nameplate(p_room_id uuid, p_text text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_text text := btrim(regexp_replace(COALESCE(p_text, ''), '\s+', ' ', 'g'));
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in first.' USING ERRCODE = '42501';
  END IF;
  IF p_room_id IS NULL OR NOT public.room_has_capability(p_room_id, v_uid, 'manage_settings') THEN
    RAISE EXCEPTION 'Not allowed to rename this room''s nameplate.' USING ERRCODE = '42501';
  END IF;
  IF v_text !~ '^[A-Za-z0-9 -]{1,12}$' THEN
    RAISE EXCEPTION 'A nameplate is 1–12 letters, numbers, spaces or dashes.' USING ERRCODE = '22023';
  END IF;

  UPDATE public.rooms SET nameplate = v_text WHERE id = p_room_id;

  PERFORM public.record_room_control_event(
    p_room_id, 'settings_changed', NULL, jsonb_build_object('field', 'nameplate')
  );

  RETURN v_text;
END;
$$;

--
-- Name: invite_card_hits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invite_card_hits (
    token_hash bytea NOT NULL,
    bucket timestamp with time zone NOT NULL,
    hits integer DEFAULT 0 NOT NULL
);

COMMENT ON TABLE public.invite_card_hits IS 'Per-token rate-limit buckets for get_public_invite_card. SHA-256 of the token only. Written only by that function.';

ALTER TABLE ONLY public.invite_card_hits
    ADD CONSTRAINT invite_card_hits_pkey PRIMARY KEY (token_hash, bucket);

CREATE INDEX invite_card_hits_bucket_idx ON public.invite_card_hits USING btree (bucket);

ALTER TABLE public.invite_card_hits ENABLE ROW LEVEL SECURITY;

--
-- Name: get_public_invite_card(text, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_public_invite_card(p_token text, p_ref text DEFAULT NULL::text, p_log boolean DEFAULT false) RETURNS TABLE(room_name text, nameplate text, member_count integer, people integer, desk integer, screen integer, speaker integer, bed integer, door text, is_visitor_pass boolean, visitor_until timestamp with time zone, focus_ends_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_token text := lower(btrim(COALESCE(p_token, '')));
  v_invite public.room_invites%ROWTYPE;
  v_room public.rooms%ROWTYPE;
  v_status public.room_live_status%ROWTYPE;
  v_hits integer;
  v_timer jsonb;
  v_end_ms numeric;
  v_focus timestamptz;
  v_members integer;
BEGIN
  IF v_token !~ '^[a-f0-9]{48}$' THEN
    RETURN;
  END IF;

  SELECT i.* INTO v_invite
  FROM public.room_invites i
  WHERE i.token = v_token
    AND i.revoked_at IS NULL
    AND (i.expires_at IS NULL OR i.expires_at > now())
    AND (i.max_uses IS NULL OR i.uses_count < i.max_uses);
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT r.* INTO v_room FROM public.rooms r WHERE r.id = v_invite.room_id;
  IF NOT FOUND OR public.room_lifecycle_state(v_room.id) IN ('destroyed', 'recovery-window') THEN
    RETURN;
  END IF;

  DELETE FROM public.invite_card_hits WHERE bucket < now() - interval '1 day';

  INSERT INTO public.invite_card_hits AS h (token_hash, bucket, hits)
  VALUES (
    sha256(convert_to(v_token, 'UTF8')),
    date_bin('10 minutes', now(), timestamptz '2000-01-01 00:00:00+00'),
    1
  )
  ON CONFLICT (token_hash, bucket) DO UPDATE SET hits = h.hits + 1
  RETURNING h.hits INTO v_hits;

  IF v_hits > 60 THEN
    RAISE EXCEPTION 'Too many looks at this link. Try again in a few minutes.' USING ERRCODE = 'PT429';
  END IF;

  SELECT count(*)::integer INTO v_members
  FROM public.room_members m
  WHERE m.room_id = v_room.id
    AND public.room_user_role(m.room_id, m.user_id) IS NOT NULL;

  SELECT s.* INTO v_status
  FROM public.room_live_status s
  WHERE s.room_id = v_room.id
    AND s.updated_at > now() - interval '2 minutes';

  -- The timer snapshot is {eventType, payload}; endTime is epoch ms. Only a
  -- running timer with a sane end in the next day counts. The subject is
  -- never read.
  SELECT s.payload INTO v_timer
  FROM public.room_realtime_snapshots s
  WHERE s.room_id = v_room.id AND s.snapshot_type = 'timer'
  ORDER BY s.updated_at DESC
  LIMIT 1;

  IF v_timer ->> 'eventType' = 'timer_start'
     AND jsonb_typeof(v_timer -> 'payload' -> 'endTime') = 'number' THEN
    v_end_ms := (v_timer -> 'payload' ->> 'endTime')::numeric;
    IF v_end_ms > extract(epoch FROM now()) * 1000
       AND v_end_ms < extract(epoch FROM now() + interval '1 day') * 1000 THEN
      v_focus := to_timestamp(v_end_ms / 1000);
    END IF;
  END IF;

  IF p_log THEN
    INSERT INTO public.product_events (event, room_id, ref)
    VALUES (
      'join_viewed',
      v_room.id,
      CASE WHEN p_ref ~ '^[a-z0-9-]{1,40}$' THEN p_ref END
    );
  END IF;

  RETURN QUERY SELECT
    v_room.name,
    v_room.nameplate,
    v_members,
    COALESCE(v_status.people, 0),
    COALESCE(v_status.desk, 0),
    COALESCE(v_status.screen, 0),
    COALESCE(v_status.speaker, 0),
    COALESCE(v_status.bed, 0),
    COALESCE(v_status.door, 'open'),
    v_invite.guest_lifetime_minutes IS NOT NULL,
    CASE
      WHEN v_invite.guest_lifetime_minutes IS NULL THEN NULL
      ELSE now() + make_interval(mins => v_invite.guest_lifetime_minutes)
    END,
    v_focus;
END;
$$;

--
-- PostgreSQL database dump complete
--

\unrestrict 2pemX3zymr8BfzXQubWyRlbSQZFodz71MGTaBKSsIGN3x0nJyv4092P4K1JOOIt

