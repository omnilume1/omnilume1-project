-- Action 04 repair (D9), found by the 2026-11-05 Action 04 probes
-- (scripts/security/authorization-probe.mjs). Additive and narrowly scoped:
-- one SELECT policy, no data, grants or functions change.
--
-- posts_select_visible (007) is
--   deleted_at IS NULL AND can_view_post(author_id, visibility)
-- and can_view_post has no "the author sees their own post" clause. PostgREST
-- runs every insert/update with RETURNING, which requires the new row to pass
-- the SELECT policy. Reproduced in production with a disposable account:
--   * createPost with visibility 'followers' fails (42501): the author is
--     neither their own follower nor friend. The same would happen for a
--     'public' post by a private author.
--   * an author cannot read their own followers-only posts.
--   * deletePost (soft delete, deleted_at = now()) always fails (42501): the
--     deleted row no longer passes the policy. Count-only updates fail too.
--
-- Fix: authors may read their own posts, including soft-deleted ones. Every
-- application read already filters deleted_at IS NULL
-- (src/actions/profiles.ts), so deleted posts stay hidden in the UI. Other
-- readers keep exactly the previous rule. INSERT, UPDATE and DELETE policies
-- are unchanged.
ALTER POLICY "posts_select_visible" ON public.posts
USING (
  auth.uid() = author_id
  OR (deleted_at IS NULL AND public.can_view_post(author_id, visibility))
);
