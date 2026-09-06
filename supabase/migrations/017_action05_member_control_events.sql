-- Allow a removed member to receive only their own moderation event so the
-- active client can close the room immediately. This complements the existing
-- membership policy; no room-wide event data is exposed to non-members.
CREATE POLICY "Removed members read own moderation event" ON public.room_control_events
FOR SELECT TO authenticated
USING (
  subject_user_id = auth.uid()
  AND event_type IN ('membership_changed', 'restriction_changed')
);
