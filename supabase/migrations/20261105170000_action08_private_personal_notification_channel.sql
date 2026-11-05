-- Action 08: the per-user notification channel must be a private channel.
--
-- This project allows only private Realtime channels, so the public
-- personal_message_notifications_<uid> channel used by
-- usePersonalMessageNotifications was refused with "PrivateOnly" and live
-- personal-message and room-notification delivery never arrived.
--
-- Private channels are authorized through realtime.messages RLS. Each
-- signed-in user may receive on exactly their own topic. There is no INSERT
-- policy, so no one can publish to it. Rows delivered through Postgres
-- Changes on this channel stay filtered by the personal_messages and
-- room_notifications RLS policies.

DROP POLICY IF EXISTS "Users receive their own notification channel" ON realtime.messages;
CREATE POLICY "Users receive their own notification channel"
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  realtime.messages.extension IN ('broadcast', 'presence')
  AND (SELECT auth.uid()) IS NOT NULL
  AND (SELECT realtime.topic()) = 'personal_message_notifications_' || (SELECT auth.uid())::text
);
