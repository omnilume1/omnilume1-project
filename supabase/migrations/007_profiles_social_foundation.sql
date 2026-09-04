-- OmniLume Action 04: profiles, privacy, relationships, posts, and account deletion.
-- This migration is additive with respect to application data. It preserves the
-- existing profile-completed marker used by Action 02 and exposes only safe
-- profile fields through public_profiles.

-- -----------------------------------------------------------------------------
-- Profile identity and privacy fields
-- -----------------------------------------------------------------------------

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS display_name text,
  ADD COLUMN IF NOT EXISTS username text,
  ADD COLUMN IF NOT EXISTS date_of_birth date,
  ADD COLUMN IF NOT EXISTS gender text,
  ADD COLUMN IF NOT EXISTS avatar_url text,
  ADD COLUMN IF NOT EXISTS bio text,
  ADD COLUMN IF NOT EXISTS is_private boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS profile_details_completed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_gender_check'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_gender_check
      CHECK (gender IS NULL OR gender IN ('female', 'male', 'non_binary', 'prefer_not_to_say', 'other'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_bio_length_check'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_bio_length_check
      CHECK (bio IS NULL OR char_length(bio) <= 500);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_display_name_length_check'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_display_name_length_check
      CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 120);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_avatar_url_length_check'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_avatar_url_length_check
      CHECK (avatar_url IS NULL OR char_length(avatar_url) <= 2048);
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_lower_unique_idx
  ON public.profiles (lower(username))
  WHERE username IS NOT NULL;

CREATE INDEX IF NOT EXISTS profiles_private_idx
  ON public.profiles (is_private);

CREATE OR REPLACE FUNCTION public.validate_profile_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
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
$$;

DROP TRIGGER IF EXISTS validate_profile_fields ON public.profiles;
CREATE TRIGGER validate_profile_fields
BEFORE INSERT OR UPDATE ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.validate_profile_fields();

-- -----------------------------------------------------------------------------
-- Social relationships
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.follows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  follower_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  following_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  accepted_at timestamptz,
  CONSTRAINT follows_not_self CHECK (follower_id <> following_id),
  CONSTRAINT follows_status_check CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled')),
  CONSTRAINT follows_pair_unique UNIQUE (follower_id, following_id)
);

CREATE TABLE IF NOT EXISTS public.friend_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  responded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT friend_requests_not_self CHECK (requester_id <> recipient_id),
  CONSTRAINT friend_requests_status_check CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS friend_requests_pending_pair_unique_idx
  ON public.friend_requests (
    LEAST(requester_id, recipient_id),
    GREATEST(requester_id, recipient_id)
  )
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS public.friendships (
  user_one uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  user_two uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_one, user_two),
  CONSTRAINT friendships_normalized_pair CHECK (user_one < user_two)
);

CREATE TABLE IF NOT EXISTS public.posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content text NOT NULL,
  media_url text,
  visibility text NOT NULL DEFAULT 'profile',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT posts_content_length_check CHECK (char_length(content) BETWEEN 1 AND 5000),
  CONSTRAINT posts_visibility_check CHECK (visibility IN ('profile', 'public', 'followers')),
  CONSTRAINT posts_media_url_length_check CHECK (media_url IS NULL OR char_length(media_url) <= 2048)
);

CREATE INDEX IF NOT EXISTS follows_following_status_idx
  ON public.follows (following_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS follows_follower_status_idx
  ON public.follows (follower_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS friend_requests_recipient_status_idx
  ON public.friend_requests (recipient_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS friend_requests_requester_status_idx
  ON public.friend_requests (requester_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS posts_author_created_idx
  ON public.posts (author_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION public.validate_post_fields()
RETURNS trigger
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

DROP TRIGGER IF EXISTS validate_post_fields ON public.posts;
CREATE TRIGGER validate_post_fields
BEFORE INSERT OR UPDATE ON public.posts
FOR EACH ROW
EXECUTE FUNCTION public.validate_post_fields();

CREATE OR REPLACE FUNCTION public.prevent_social_request_tampering()
RETURNS trigger
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

DROP TRIGGER IF EXISTS prevent_follows_tampering ON public.follows;
CREATE TRIGGER prevent_follows_tampering
BEFORE UPDATE ON public.follows
FOR EACH ROW
EXECUTE FUNCTION public.prevent_social_request_tampering();

DROP TRIGGER IF EXISTS prevent_friend_requests_tampering ON public.friend_requests;
CREATE TRIGGER prevent_friend_requests_tampering
BEFORE UPDATE ON public.friend_requests
FOR EACH ROW
EXECUTE FUNCTION public.prevent_social_request_tampering();

CREATE OR REPLACE FUNCTION public.touch_post_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS touch_post_updated_at ON public.posts;
CREATE TRIGGER touch_post_updated_at
BEFORE UPDATE ON public.posts
FOR EACH ROW
EXECUTE FUNCTION public.touch_post_updated_at();

-- -----------------------------------------------------------------------------
-- Privacy helpers and safe public projection
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_current_friend(p_user_one uuid, p_user_two uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.friendships f
    WHERE f.user_one = LEAST(p_user_one, p_user_two)
      AND f.user_two = GREATEST(p_user_one, p_user_two)
  );
$$;

CREATE OR REPLACE FUNCTION public.is_accepted_follower(p_follower_id uuid, p_following_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
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

CREATE OR REPLACE FUNCTION public.can_view_profile(p_profile_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
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

CREATE OR REPLACE FUNCTION public.can_view_post(p_author_id uuid, p_visibility text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
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

DROP VIEW IF EXISTS public.public_profiles;
CREATE VIEW public.public_profiles AS
SELECT
  p.id,
  p.username,
  p.display_name,
  p.avatar_url,
  p.bio,
  p.is_private,
  p.created_at,
  p.updated_at
FROM public.profiles p
WHERE public.can_view_profile(p.id);

GRANT SELECT ON public.public_profiles TO authenticated;

CREATE OR REPLACE FUNCTION public.get_profile_followers(p_profile_id uuid)
RETURNS TABLE (user_id uuid, username text, display_name text, avatar_url text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT p.id, p.username, p.display_name, p.avatar_url
  FROM public.follows f
  JOIN public.profiles p ON p.id = f.follower_id
  WHERE f.following_id = p_profile_id
    AND f.status = 'accepted'
    AND public.can_view_profile(p_profile_id);
$$;

CREATE OR REPLACE FUNCTION public.get_profile_following(p_profile_id uuid)
RETURNS TABLE (user_id uuid, username text, display_name text, avatar_url text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT p.id, p.username, p.display_name, p.avatar_url
  FROM public.follows f
  JOIN public.profiles p ON p.id = f.following_id
  WHERE f.follower_id = p_profile_id
    AND f.status = 'accepted'
    AND public.can_view_profile(p_profile_id);
$$;

-- -----------------------------------------------------------------------------
-- Server-authorized relationship transitions
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.request_follow(p_target_id uuid)
RETURNS public.follows
LANGUAGE plpgsql
SECURITY DEFINER
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

CREATE OR REPLACE FUNCTION public.respond_to_follow_request(p_follow_id uuid, p_decision text)
RETURNS public.follows
LANGUAGE plpgsql
SECURITY DEFINER
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

CREATE OR REPLACE FUNCTION public.cancel_follow_request(p_target_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE public.follows
  SET status = 'cancelled', responded_at = now()
  WHERE follower_id = auth.uid() AND following_id = p_target_id AND status = 'pending';
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.unfollow_user(p_target_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  DELETE FROM public.follows
  WHERE follower_id = auth.uid() AND following_id = p_target_id;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_follower(p_follower_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  DELETE FROM public.follows
  WHERE follower_id = p_follower_id AND following_id = auth.uid();
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.request_friend(p_recipient_id uuid)
RETURNS public.friend_requests
LANGUAGE plpgsql
SECURITY DEFINER
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

CREATE OR REPLACE FUNCTION public.respond_to_friend_request(p_request_id uuid, p_decision text)
RETURNS public.friend_requests
LANGUAGE plpgsql
SECURITY DEFINER
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

CREATE OR REPLACE FUNCTION public.cancel_friend_request(p_request_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE public.friend_requests
  SET status = 'cancelled', responded_at = now(), responded_by = auth.uid()
  WHERE id = p_request_id AND requester_id = auth.uid() AND status = 'pending';
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_friend(p_other_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  DELETE FROM public.friendships
  WHERE user_one = LEAST(auth.uid(), p_other_user_id)
    AND user_two = GREATEST(auth.uid(), p_other_user_id);
  RETURN FOUND;
END;
$$;

-- -----------------------------------------------------------------------------
-- Account deletion preparation
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.prepare_account_deletion(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  room_row record;
  replacement_user uuid;
BEGIN
  IF auth.uid() IS DISTINCT FROM p_user_id
     AND current_setting('request.jwt.claim.role', true) <> 'service_role' THEN
    RAISE EXCEPTION 'Unauthorized account deletion preparation.';
  END IF;

  PERFORM set_config('app.omnilume_account_deletion', 'true', true);
  FOR room_row IN SELECT id FROM public.rooms WHERE created_by = p_user_id LOOP
    SELECT rm.user_id INTO replacement_user
    FROM public.room_members rm
    WHERE rm.room_id = room_row.id
      AND rm.user_id <> p_user_id
      AND rm.join_status = 'approved'
    ORDER BY CASE WHEN rm.role = 'admin' THEN 0 ELSE 1 END, rm.joined_at
    LIMIT 1;

    IF replacement_user IS NULL THEN
      -- No other approved member means this is not a shared room. Removing it
      -- avoids leaving an ownerless room while never deleting shared rooms.
      DELETE FROM public.rooms WHERE id = room_row.id;
    ELSE
      UPDATE public.room_members
      SET role = 'owner'
      WHERE room_id = room_row.id AND user_id = replacement_user;
      UPDATE public.rooms
      SET created_by = replacement_user
      WHERE id = room_row.id;
    END IF;
  END LOOP;
END;
$$;

-- Permit the narrowly scoped owner transfer used by the deletion function.
CREATE OR REPLACE FUNCTION public.prevent_room_membership_escalation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.room_id IS DISTINCT FROM OLD.room_id OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'Room membership identity cannot change.';
  END IF;
  IF NEW.role IS DISTINCT FROM OLD.role
     AND current_setting('app.omnilume_account_deletion', true) <> 'true' THEN
    RAISE EXCEPTION 'Room membership roles cannot be changed through this operation.';
  END IF;
  IF NEW.join_status NOT IN ('pending', 'approved', 'rejected') THEN
    RAISE EXCEPTION 'Invalid room membership status.';
  END IF;
  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- RLS: private base profile, scoped relationships, and relationship-aware posts
-- -----------------------------------------------------------------------------

ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friend_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles are readable by authenticated users" ON public.profiles;
DROP POLICY IF EXISTS "users manage own profile" ON public.profiles;
DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;
DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;

CREATE POLICY "profiles_select_own"
ON public.profiles FOR SELECT TO authenticated
USING (auth.uid() = id);
CREATE POLICY "profiles_insert_own"
ON public.profiles FOR INSERT TO authenticated
WITH CHECK (auth.uid() = id);
CREATE POLICY "profiles_update_own"
ON public.profiles FOR UPDATE TO authenticated
USING (auth.uid() = id)
WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "follows_select_involved" ON public.follows;
CREATE POLICY "follows_select_involved"
ON public.follows FOR SELECT TO authenticated
USING (auth.uid() = follower_id OR auth.uid() = following_id);

DROP POLICY IF EXISTS "friend_requests_select_involved" ON public.friend_requests;
CREATE POLICY "friend_requests_select_involved"
ON public.friend_requests FOR SELECT TO authenticated
USING (auth.uid() = requester_id OR auth.uid() = recipient_id);

DROP POLICY IF EXISTS "friendships_select_involved" ON public.friendships;
CREATE POLICY "friendships_select_involved"
ON public.friendships FOR SELECT TO authenticated
USING (auth.uid() = user_one OR auth.uid() = user_two);

DROP POLICY IF EXISTS "friendships_delete_involved" ON public.friendships;
CREATE POLICY "friendships_delete_involved"
ON public.friendships FOR DELETE TO authenticated
USING (auth.uid() = user_one OR auth.uid() = user_two);

DROP POLICY IF EXISTS "posts_select_visible" ON public.posts;
CREATE POLICY "posts_select_visible"
ON public.posts FOR SELECT TO authenticated
USING (deleted_at IS NULL AND public.can_view_post(author_id, visibility));

DROP POLICY IF EXISTS "posts_insert_own" ON public.posts;
CREATE POLICY "posts_insert_own"
ON public.posts FOR INSERT TO authenticated
WITH CHECK (auth.uid() = author_id);

DROP POLICY IF EXISTS "posts_update_own" ON public.posts;
CREATE POLICY "posts_update_own"
ON public.posts FOR UPDATE TO authenticated
USING (auth.uid() = author_id)
WITH CHECK (auth.uid() = author_id);

DROP POLICY IF EXISTS "posts_delete_own" ON public.posts;
CREATE POLICY "posts_delete_own"
ON public.posts FOR DELETE TO authenticated
USING (auth.uid() = author_id);

-- Social mutations happen through the authorization functions above. No direct
-- client INSERT/UPDATE policy is granted for follows or requests.

REVOKE ALL ON FUNCTION public.can_view_profile(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_view_post(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_current_friend(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_accepted_follower(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_follow(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.respond_to_follow_request(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_follow_request(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.unfollow_user(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.remove_follower(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_friend(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.respond_to_friend_request(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_friend_request(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.remove_friend(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prepare_account_deletion(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_profile_followers(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_profile_following(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.can_view_profile(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_view_post(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_current_friend(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_accepted_follower(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_follow(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.respond_to_follow_request(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_follow_request(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unfollow_user(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_follower(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_friend(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.respond_to_friend_request(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_friend_request(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_friend(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_account_deletion(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_profile_followers(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_profile_following(uuid) TO authenticated;

GRANT SELECT ON public.follows, public.friend_requests, public.friendships, public.posts TO authenticated;
