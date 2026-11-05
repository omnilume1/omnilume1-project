-- Actions 06/08/09 repair found by the 2026-11-05 two-account probes
-- (scripts/security/authorization-probe.mjs). Additive and narrowly scoped:
-- no data, table shape, grant broadening, or policy semantics change.

-- 1. Recovery decisions always fail (T4).
--    In 20260923120000 notify_room_recovery_decision declares a PL/pgSQL
--    variable named notification_type, and the same name appears in
--    ON CONFLICT (room_id, recipient_id, notification_type). PostgreSQL raises
--    42702 "column reference notification_type is ambiguous". The AFTER UPDATE
--    trigger runs inside review_recovery_request's transaction, so every
--    recovery approval and rejection is rolled back. Only the variables are
--    renamed. The body is otherwise identical, and CREATE OR REPLACE keeps the
--    existing grants (service_role only) and the trigger binding.
CREATE OR REPLACE FUNCTION public.notify_room_recovery_decision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_notification_type text;
  v_notification_message text;
BEGIN
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('approved', 'rejected') THEN
    RETURN NEW;
  END IF;

  v_notification_type := CASE NEW.status
    WHEN 'approved' THEN 'recovery_approved'
    ELSE 'recovery_rejected'
  END;

  v_notification_message := CASE NEW.status
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
    v_notification_type,
    v_notification_message,
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

-- 2. Every authenticated delete in room_attachments fails.
--    The storage DELETE policy's files branch runs
--    EXISTS (SELECT ... FROM public.room_files ...) with the caller's
--    privileges, but 20260923140000 revoked all client privileges on
--    room_files. PostgreSQL checks table privileges for the whole policy
--    expression, so any delete, including Watch media and subtitles, fails with
--    "permission denied for table room_files". The ownership check moves into a
--    SECURITY DEFINER helper, so the policy keeps exactly the same meaning while
--    room_files stays unreadable to clients.
CREATE OR REPLACE FUNCTION public.room_file_owned_by_caller(p_bucket text, p_object_path text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
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

REVOKE ALL ON FUNCTION public.room_file_owned_by_caller(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.room_file_owned_by_caller(text, text) TO authenticated, service_role;

ALTER POLICY "Members can delete active room attachments" ON storage.objects
USING (
  bucket_id = 'room_attachments'
  AND public.room_storage_path_room_id(name) IS NOT NULL
  AND (
    (
      public.room_storage_path_kind(name) = 'files'
      AND (
        public.room_file_owned_by_caller(bucket_id, name)
        OR public.is_room_admin_or_owner(public.room_storage_path_room_id(name), auth.uid())
      )
    )
    OR (
      public.room_storage_path_kind(name) IN ('media', 'subtitles')
      AND public.room_has_capability(public.room_storage_path_room_id(name), auth.uid(), 'watch_control')
    )
  )
);
