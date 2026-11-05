-- Owner decisions recorded 2026-11-05 (docs/action-01-10-evidence-ledger.md):
--
-- 1. Recovery period: a recoverable room that expires can be recovered for
--    7 days (was 24 hours). A recovery request submitted inside that window
--    keeps the room recoverable until the request is reviewed, so a room whose
--    owner asked in time is never destroyed while waiting. A room that leaves
--    the window without a request is destroyed: the cleanup route deletes its
--    storage objects and then the room row, and every room-owned table
--    cascades (verified: all 21 foreign keys to public.rooms are ON DELETE
--    CASCADE). Irreversible rooms keep their existing rule (destroyed at
--    expiry).
-- 5. Minimum age: profiles cannot store a date of birth less than 13 years
--    ago. Existing rows are not rewritten; the check applies when a date of
--    birth is first set or changed.
--
-- Additive and forward-only. No data is modified by this migration itself;
-- deletion happens only through public.destroy_expired_room, which the
-- service-role cleanup route calls.

-- 1a. Lifecycle state: 7-day recovery window, held open by a pending request.
CREATE OR REPLACE FUNCTION public.room_lifecycle_state(p_room_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
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
       )
     ) THEN
    RETURN 'recovery-window';
  END IF;

  RETURN 'destroyed';
END;
$$;

-- 1b. Rooms whose lifecycle has ended. Read by the cleanup route only.
CREATE OR REPLACE FUNCTION public.list_rooms_due_for_destruction(p_limit integer DEFAULT 100)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT r.id
  FROM public.rooms r
  WHERE r.expiration_type IN ('recoverable', 'irreversible')
    AND r.expires_at IS NOT NULL
    AND r.expires_at <= now()
    AND public.room_lifecycle_state(r.id) = 'destroyed'
  ORDER BY r.expires_at
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
$$;

-- 1c. Deletes one room after re-checking its state under a row lock, so a
-- recovery approved between listing and deletion is never overridden. The
-- caller removes the room's storage objects first (storage rows are not
-- children of public.rooms); every room-owned table cascades from this
-- delete.
CREATE OR REPLACE FUNCTION public.destroy_expired_room(p_room_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM 1 FROM public.rooms r WHERE r.id = p_room_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF public.room_lifecycle_state(p_room_id) <> 'destroyed' THEN
    RETURN false;
  END IF;

  DELETE FROM public.rooms r
  WHERE r.id = p_room_id
    AND r.expiration_type IN ('recoverable', 'irreversible');
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.list_rooms_due_for_destruction(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.destroy_expired_room(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_rooms_due_for_destruction(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.destroy_expired_room(uuid) TO service_role;

-- 5. Minimum age 13, enforced in the database as well as the profile form.
CREATE OR REPLACE FUNCTION public.enforce_profile_minimum_age()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
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

REVOKE ALL ON FUNCTION public.enforce_profile_minimum_age() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS profiles_enforce_minimum_age ON public.profiles;
CREATE TRIGGER profiles_enforce_minimum_age
BEFORE INSERT OR UPDATE OF date_of_birth ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.enforce_profile_minimum_age();
