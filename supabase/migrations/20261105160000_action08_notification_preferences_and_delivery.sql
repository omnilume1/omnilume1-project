-- Action 08 notification system (owner spec 2026-11-05, section 3):
--
-- 1. Do-not-disturb and per-room mute preferences, applied server-side in the
--    single notification writer. Access, security, recovery and room
--    deletion notices are never suppressed.
-- 2. Recipients may change only read_at (column privilege) and get a
--    mark-read function; nobody else can read or change their notices.
-- 3. Live delivery: room_notifications joins the realtime publication (RLS
--    limits each change to its recipient).
-- 4. Access notices from the existing room_control_events record: role
--    changes, approvals, removals, bans and ownership transfers reach the
--    affected member.
--
-- Additive: new table, functions, trigger and publication entry; the writer
-- function gains the preference check. No existing row is modified.

-- ---------------------------------------------------------------------------
-- 1. Preferences
-- ---------------------------------------------------------------------------
CREATE TABLE public.notification_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  room_id uuid REFERENCES public.rooms (id) ON DELETE CASCADE,
  muted_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.notification_preferences IS
  'One row = notifications muted for the user: room_id NULL is global do-not-disturb, otherwise one room. muted_until NULL means until turned off.';

CREATE UNIQUE INDEX notification_preferences_global_unique
ON public.notification_preferences (user_id)
WHERE room_id IS NULL;

CREATE UNIQUE INDEX notification_preferences_room_unique
ON public.notification_preferences (user_id, room_id)
WHERE room_id IS NOT NULL;

ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.notification_preferences FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.notification_preferences TO authenticated;

CREATE POLICY "Users can see their own notification preferences"
ON public.notification_preferences
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

-- Writes go through this function only: a room mute requires membership.
CREATE OR REPLACE FUNCTION public.set_notification_preference(
  p_room_id uuid,
  p_muted boolean,
  p_muted_until timestamptz DEFAULT NULL
)
RETURNS public.notification_preferences
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
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

REVOKE ALL ON FUNCTION public.set_notification_preference(uuid, boolean, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_notification_preference(uuid, boolean, timestamptz) TO authenticated;

CREATE OR REPLACE FUNCTION public.notifications_suppressed(p_user_id uuid, p_room_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.notification_preferences np
    WHERE np.user_id = p_user_id
      AND (np.room_id IS NULL OR np.room_id = p_room_id)
      AND (np.muted_until IS NULL OR np.muted_until > now())
  );
$$;

REVOKE ALL ON FUNCTION public.notifications_suppressed(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- The single writer, now honouring preferences. Access, security, recovery
-- and deletion notices bypass them. The room name is stored with the notice
-- so it stays readable after the member loses access to the room.
CREATE OR REPLACE FUNCTION public.enqueue_room_notification(
  p_recipient_id uuid,
  p_room_id uuid,
  p_type text,
  p_message text,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_actor_id uuid DEFAULT NULL,
  p_entity_id uuid DEFAULT NULL,
  p_dedupe_key text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
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

REVOKE ALL ON FUNCTION public.enqueue_room_notification(uuid, uuid, text, text, jsonb, uuid, uuid, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Read state: recipients may change read_at only
-- ---------------------------------------------------------------------------
REVOKE UPDATE ON public.room_notifications FROM PUBLIC, anon, authenticated;
GRANT UPDATE (read_at) ON public.room_notifications TO authenticated;

CREATE OR REPLACE FUNCTION public.mark_room_notifications_read(p_ids uuid[] DEFAULT NULL)
RETURNS integer
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
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

REVOKE ALL ON FUNCTION public.mark_room_notifications_read(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_room_notifications_read(uuid[]) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Live delivery
-- ---------------------------------------------------------------------------
DO $publication$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'room_notifications'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.room_notifications;
  END IF;
END
$publication$;

-- ---------------------------------------------------------------------------
-- 4. Access notices from room_control_events
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_member_access_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
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

REVOKE ALL ON FUNCTION public.notify_member_access_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS notify_member_access_change ON public.room_control_events;
CREATE TRIGGER notify_member_access_change
AFTER INSERT ON public.room_control_events
FOR EACH ROW
EXECUTE FUNCTION public.notify_member_access_change();
