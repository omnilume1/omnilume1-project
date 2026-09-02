-- Restore the authenticated room-creation policy required by the application.
-- This is intentionally limited to a user's own room row and valid lifecycle
-- values; it does not grant access to private room data.
DROP POLICY IF EXISTS "Authenticated users can create rooms" ON public.rooms;

CREATE POLICY "Authenticated users can create rooms"
ON public.rooms
FOR INSERT TO authenticated
WITH CHECK (
  auth.uid() = created_by
  AND (
    (expiration_type = 'permanent' AND expires_at IS NULL)
    OR
    (
      expiration_type IN ('recoverable', 'irreversible')
      AND expires_at IS NOT NULL
      AND expires_at > now()
    )
  )
);
