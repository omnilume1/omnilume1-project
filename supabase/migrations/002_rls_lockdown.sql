-- Migration: RLS Lockdown (Action 2)
-- Fixes critical security vulnerabilities in Row Level Security policies
-- Addresses: B-2, B-3, B-6, D-1, D-2, D-3 from audit report

-- ============================================================================
-- 1. MESSAGES TABLE - Remove public read access (B-2, D-1)
-- ============================================================================

-- DROP the dangerous public read policy
DROP POLICY IF EXISTS "Enable read access for all users" ON public.messages;

-- Keep the existing participant-based policies:
-- - "Participants read messages" (for private chats)
-- - "Room members read room messages" (for room chats)

-- Add membership check for room message inserts
-- First drop existing insert policies
DROP POLICY IF EXISTS "Enable insert access for authenticated users" ON public.messages;
DROP POLICY IF EXISTS "Senders insert messages" ON public.messages;

-- Create new insert policy that requires room membership for room messages
CREATE POLICY "Users can insert messages" ON public.messages
FOR INSERT TO authenticated
WITH CHECK (
  -- For private chat messages: sender must be a participant
  (chat_id IS NOT NULL AND auth.uid() = sender_id AND (
    EXISTS (
      SELECT 1 FROM public.private_chats pc
      WHERE pc.id = messages.chat_id
      AND (pc.user_one = auth.uid() OR pc.user_two = auth.uid())
    )
  ))
  OR
  -- For room messages: sender must be an approved room member
  (room_id IS NOT NULL AND auth.uid() = sender_id AND (
    EXISTS (
      SELECT 1 FROM public.room_members rm
      WHERE rm.room_id = messages.room_id
      AND rm.user_id = auth.uid()
      AND rm.join_status = 'approved'
    )
  ))
);

-- ============================================================================
-- 2. ROOM_MEMBERS TABLE - Prevent self-promotion (B-3, D-2)
-- ============================================================================

-- Drop existing problematic insert policies
DROP POLICY IF EXISTS "Users can add themselves on creation" ON public.room_members;
DROP POLICY IF EXISTS "users join rooms" ON public.room_members;

-- Create new insert policy that forces role='member' and join_status='pending'
-- Only the room creator (owner) can insert with role='owner' via the room creation flow
CREATE POLICY "Users can request to join rooms" ON public.room_members
FOR INSERT TO authenticated
WITH CHECK (
  auth.uid() = user_id
  AND role = 'member'
  AND join_status = 'pending'
);

-- Drop existing problematic update policy
DROP POLICY IF EXISTS "users update own membership" ON public.room_members;

-- Create new update policy that prevents self-promotion
-- Users can only update their own join_status (to leave) but cannot change role
CREATE POLICY "Users can update own membership status" ON public.room_members
FOR UPDATE TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (
  auth.uid() = user_id
  -- Prevent users from changing their own role
  AND role = (SELECT role FROM public.room_members WHERE room_id = room_members.room_id AND user_id = auth.uid())
  -- Allow changing join_status to 'rejected' (leaving) or 'pending' (re-requesting)
  AND join_status IN ('pending', 'rejected')
);

-- Keep existing owner/admin policies for managing other members:
-- - "Owners can update members" (for approving/rejecting requests)
-- - "Owners can delete members" (for removing members)

-- ============================================================================
-- 3. TEMPORARY_MEDIA TABLE - Require room membership (D-3 related)
-- ============================================================================

-- Drop existing permissive policies
DROP POLICY IF EXISTS "Anyone in room can view temporary media" ON public.temporary_media;
DROP POLICY IF EXISTS "Users can upload temporary media" ON public.temporary_media;

-- Create new select policy requiring approved room membership
CREATE POLICY "Approved room members can view temporary media" ON public.temporary_media
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.room_members rm
    WHERE rm.room_id = temporary_media.room_id
    AND rm.user_id = auth.uid()
    AND rm.join_status = 'approved'
  )
);

-- Create new insert policy requiring approved room membership
CREATE POLICY "Approved room members can upload temporary media" ON public.temporary_media
FOR INSERT TO authenticated
WITH CHECK (
  auth.uid() = user_id
  AND EXISTS (
    SELECT 1 FROM public.room_members rm
    WHERE rm.room_id = temporary_media.room_id
    AND rm.user_id = auth.uid()
    AND rm.join_status = 'approved'
  )
);

-- ============================================================================
-- 4. ROOM_MESSAGES TABLE (Legacy) - Fix public access
-- ============================================================================

-- Drop existing permissive policies
DROP POLICY IF EXISTS "Anyone can read room messages" ON public.room_messages;
DROP POLICY IF EXISTS "authenticated read room messages" ON public.room_messages;
DROP POLICY IF EXISTS "Authenticated users can insert room messages" ON public.room_messages;
DROP POLICY IF EXISTS "authenticated send room messages" ON public.room_messages;

-- Create new select policy requiring room membership
CREATE POLICY "Room members can read room messages" ON public.room_messages
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.room_members rm
    WHERE rm.room_id = room_messages.room_id
    AND rm.user_id = auth.uid()
    AND rm.join_status = 'approved'
  )
);

-- Create new insert policy requiring room membership
CREATE POLICY "Room members can send room messages" ON public.room_messages
FOR INSERT TO authenticated
WITH CHECK (
  auth.uid() = user_id
  AND EXISTS (
    SELECT 1 FROM public.room_members rm
    WHERE rm.room_id = room_messages.room_id
    AND rm.user_id = auth.uid()
    AND rm.join_status = 'approved'
  )
);

-- ============================================================================
-- 5. STORAGE POLICIES - Scope by room path (D-3)
-- ============================================================================

-- Note: Storage policies are managed separately in Supabase Storage
-- The following SQL comments document the required changes:

-- For the 'room_attachments' bucket:
-- 1. Make bucket private (not public)
-- 2. Update SELECT policy to check room membership based on path prefix
-- 3. Update INSERT policy to check room membership based on path prefix
-- 4. Update DELETE policy to check room membership based on path prefix

-- The path format is: {room_id}/{filename}
-- Policies should extract room_id from path and verify membership

-- Since storage policies cannot be created via SQL (they're managed via Supabase dashboard/API),
-- we document the required policy expressions here:

-- SELECT policy expression:
-- bucket_id = 'room_attachments' AND auth.role() = 'authenticated' AND EXISTS (
--   SELECT 1 FROM public.room_members rm
--   WHERE rm.room_id = (storage.foldername(name))[1]::uuid
--   AND rm.user_id = auth.uid()
--   AND rm.join_status = 'approved'
-- )

-- INSERT policy expression:
-- bucket_id = 'room_attachments' AND auth.role() = 'authenticated' AND EXISTS (
--   SELECT 1 FROM public.room_members rm
--   WHERE rm.room_id = (storage.foldername(name))[1]::uuid
--   AND rm.user_id = auth.uid()
--   AND rm.join_status = 'approved'
-- )

-- DELETE policy expression:
-- bucket_id = 'room_attachments' AND auth.role() = 'authenticated' AND EXISTS (
--   SELECT 1 FROM public.room_members rm
--   WHERE rm.room_id = (storage.foldername(name))[1]::uuid
--   AND rm.user_id = auth.uid()
--   AND rm.join_status = 'approved'
-- )

-- Drop existing permissive storage policies
DROP POLICY IF EXISTS "authenticated delete room attachments" ON storage.objects;
DROP POLICY IF EXISTS "authenticated read room attachments" ON storage.objects;
DROP POLICY IF EXISTS "authenticated upload room attachments" ON storage.objects;
DROP POLICY IF EXISTS "room_attachments_delete" ON storage.objects;
DROP POLICY IF EXISTS "room_attachments_insert" ON storage.objects;
DROP POLICY IF EXISTS "room_attachments_select" ON storage.objects;

-- Create new storage policies with room membership checks
-- Note: These require the storage.objects table to be accessible
-- If storage.objects is not accessible, these will fail and need to be applied via Supabase dashboard

CREATE POLICY "Room members can read attachments" ON storage.objects
FOR SELECT TO authenticated
USING (
  bucket_id = 'room_attachments'
  AND EXISTS (
    SELECT 1 FROM public.room_members rm
    WHERE rm.room_id = (storage.foldername(name))[1]::uuid
    AND rm.user_id = auth.uid()
    AND rm.join_status = 'approved'
  )
);

CREATE POLICY "Room members can upload attachments" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'room_attachments'
  AND EXISTS (
    SELECT 1 FROM public.room_members rm
    WHERE rm.room_id = (storage.foldername(name))[1]::uuid
    AND rm.user_id = auth.uid()
    AND rm.join_status = 'approved'
  )
);

CREATE POLICY "Room members can delete attachments" ON storage.objects
FOR DELETE TO authenticated
USING (
  bucket_id = 'room_attachments'
  AND EXISTS (
    SELECT 1 FROM public.room_members rm
    WHERE rm.room_id = (storage.foldername(name))[1]::uuid
    AND rm.user_id = auth.uid()
    AND rm.join_status = 'approved'
  )
);

-- ============================================================================
-- 6. SECURITY DEFINER FUNCTION - Restrict access (D-4)
-- ============================================================================

-- The get_room_by_identifier function is SECURITY DEFINER and currently accessible to everyone
-- Revoke execute from anonymous users
REVOKE EXECUTE ON FUNCTION public.get_room_by_identifier(text) FROM anon;

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================

-- After running this migration, verify the policies:
-- SELECT tablename, policyname, cmd, roles, qual, with_check
-- FROM pg_policies
-- WHERE tablename IN ('messages', 'room_members', 'temporary_media', 'room_messages')
-- ORDER BY tablename, policyname;
