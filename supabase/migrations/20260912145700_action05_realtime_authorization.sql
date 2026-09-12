-- ============================================================
-- OmniLume room Realtime authorization
--
-- Broadcast and Presence are authorized through realtime.messages RLS.
-- The client uses private channels; these policies ensure that only
-- approved active room members can join/read room topics, while privileged
-- media control broadcasts require the existing watch_control capability.
-- ============================================================

CREATE OR REPLACE FUNCTION public.room_realtime_topic_room_id(p_topic text)
RETURNS uuid
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF p_topic IS NULL
     OR p_topic !~ '^(sync|sync-control|presence):[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    RETURN NULL;
  END IF;

  RETURN split_part(p_topic, ':', 2)::uuid;
END;
$$;

REVOKE ALL ON FUNCTION public.room_realtime_topic_room_id(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.room_realtime_topic_room_id(text) TO authenticated, service_role;

DROP POLICY IF EXISTS "Approved room members receive room realtime" ON realtime.messages;
CREATE POLICY "Approved room members receive room realtime"
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  public.room_has_active_access(
    public.room_realtime_topic_room_id((SELECT realtime.topic()))
  )
  AND public.is_approved_room_member(
      public.room_realtime_topic_room_id((SELECT realtime.topic())),
      (SELECT auth.uid())
    )
  AND realtime.messages.extension IN ('broadcast', 'presence')
  AND (
    (SELECT realtime.topic()) LIKE 'sync:%'
    OR (SELECT realtime.topic()) LIKE 'sync-control:%'
    OR (SELECT realtime.topic()) LIKE 'presence:%'
  )
);

DROP POLICY IF EXISTS "Approved room members send room realtime" ON realtime.messages;
CREATE POLICY "Approved room members send room realtime"
ON realtime.messages
FOR INSERT
TO authenticated
WITH CHECK (
  realtime.messages.extension IN ('broadcast', 'presence')
  AND (
    (
      (SELECT realtime.topic()) LIKE 'sync:%'
      AND public.room_has_active_access(
        public.room_realtime_topic_room_id((SELECT realtime.topic()))
      )
      AND public.is_approved_room_member(
        public.room_realtime_topic_room_id((SELECT realtime.topic())),
        (SELECT auth.uid())
      )
    )
    OR (
      (SELECT realtime.topic()) LIKE 'presence:%'
      AND public.room_has_active_access(
        public.room_realtime_topic_room_id((SELECT realtime.topic()))
      )
      AND public.is_approved_room_member(
        public.room_realtime_topic_room_id((SELECT realtime.topic())),
        (SELECT auth.uid())
      )
    )
    OR (
      (SELECT realtime.topic()) LIKE 'sync-control:%'
      AND public.room_has_capability(
        public.room_realtime_topic_room_id((SELECT realtime.topic())),
        (SELECT auth.uid()),
        'watch_control'
      )
    )
  )
);
