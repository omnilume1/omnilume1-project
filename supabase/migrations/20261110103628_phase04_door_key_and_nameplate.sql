-- Phase 04 (hostel roadmap): door key and nameplate.
--
-- rooms.nameplate: a short door sign such as "B-204" (1–12 of A–Z, a–z,
-- 0–9, space, dash). Existing rooms are backfilled from a hash of their id;
-- a BEFORE INSERT trigger fills it for new rooms. Only manage_settings
-- holders rename it, through set_room_nameplate.
--
-- room_invites.is_door_key: the room's one standing invite (no expiry, no use
-- cap). At most one live door key per room (partial unique index).
--
-- get_room_door_link: returns the live door-key token, creating it on first
-- share. Any approved non-guest member may read and share it (decision D1),
-- as may manage_invites holders. Creating it logs one invite_created event
-- (meta.from = 'door').
--
-- change_room_lock: manage_invites holders only. Revokes the current door
-- key (the old link stops working for joining) and returns a new token.

ALTER TABLE public.rooms ADD COLUMN nameplate text;

UPDATE public.rooms
SET nameplate = chr(65 + (abs(hashtext(id::text)::bigint) % 8)::int)
  || '-' || (101 + (abs(hashtext(id::text)::bigint) / 8) % 399)
WHERE nameplate IS NULL;

CREATE FUNCTION public.fill_room_nameplate()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF NEW.nameplate IS NULL THEN
    NEW.nameplate := chr(65 + (abs(hashtext(NEW.id::text)::bigint) % 8)::int)
      || '-' || (101 + (abs(hashtext(NEW.id::text)::bigint) / 8) % 399);
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.fill_room_nameplate() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER fill_room_nameplate
  BEFORE INSERT ON public.rooms
  FOR EACH ROW EXECUTE FUNCTION public.fill_room_nameplate();

ALTER TABLE public.rooms
  ALTER COLUMN nameplate SET NOT NULL,
  ADD CONSTRAINT rooms_nameplate_check
    CHECK (nameplate ~ '^[A-Za-z0-9 -]{1,12}$' AND btrim(nameplate) <> '');

ALTER TABLE public.room_invites ADD COLUMN is_door_key boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX room_invites_one_door_key_idx
  ON public.room_invites (room_id)
  WHERE is_door_key AND revoked_at IS NULL;

CREATE FUNCTION public.get_room_door_link(p_room_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_invite_id uuid;
  v_token text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in first.' USING ERRCODE = '42501';
  END IF;
  IF p_room_id IS NULL THEN
    RAISE EXCEPTION 'Room is required.' USING ERRCODE = '22023';
  END IF;

  v_role := public.room_user_role(p_room_id, v_uid);
  IF NOT public.room_has_active_access(p_room_id)
     OR v_role IS NULL
     OR (v_role = 'guest' AND NOT public.room_has_capability(p_room_id, v_uid, 'manage_invites')) THEN
    RAISE EXCEPTION 'Not allowed to share this room.' USING ERRCODE = '42501';
  END IF;

  SELECT i.token INTO v_token
  FROM public.room_invites i
  WHERE i.room_id = p_room_id AND i.is_door_key AND i.revoked_at IS NULL;
  IF v_token IS NOT NULL THEN
    RETURN v_token;
  END IF;

  INSERT INTO public.room_invites (room_id, token, created_by, is_door_key)
  VALUES (p_room_id, encode(extensions.gen_random_bytes(24), 'hex'), v_uid, true)
  ON CONFLICT (room_id) WHERE is_door_key AND revoked_at IS NULL DO NOTHING
  RETURNING id, token INTO v_invite_id, v_token;

  IF v_token IS NULL THEN
    -- Another member created it at the same moment: share theirs.
    SELECT i.token INTO v_token
    FROM public.room_invites i
    WHERE i.room_id = p_room_id AND i.is_door_key AND i.revoked_at IS NULL;
    RETURN v_token;
  END IF;

  INSERT INTO public.product_events (event, room_id, meta)
  VALUES ('invite_created', p_room_id, jsonb_build_object('from', 'door'));

  PERFORM public.record_room_control_event(
    p_room_id, 'invite_changed', NULL,
    jsonb_build_object('invite_id', v_invite_id, 'state', 'created')
  );

  RETURN v_token;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_room_door_link(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_room_door_link(uuid) TO authenticated;

CREATE FUNCTION public.change_room_lock(p_room_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_old_id uuid;
  v_invite_id uuid;
  v_token text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in first.' USING ERRCODE = '42501';
  END IF;
  IF p_room_id IS NULL OR NOT public.room_has_capability(p_room_id, v_uid, 'manage_invites') THEN
    RAISE EXCEPTION 'Not allowed to change this room''s lock.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.room_invites
  SET revoked_at = now(), revoked_by = v_uid
  WHERE room_id = p_room_id AND is_door_key AND revoked_at IS NULL
  RETURNING id INTO v_old_id;

  IF v_old_id IS NOT NULL THEN
    PERFORM public.record_room_control_event(
      p_room_id, 'invite_changed', NULL,
      jsonb_build_object('invite_id', v_old_id, 'state', 'revoked')
    );
  END IF;

  INSERT INTO public.room_invites (room_id, token, created_by, is_door_key)
  VALUES (p_room_id, encode(extensions.gen_random_bytes(24), 'hex'), v_uid, true)
  ON CONFLICT (room_id) WHERE is_door_key AND revoked_at IS NULL DO NOTHING
  RETURNING id, token INTO v_invite_id, v_token;

  IF v_token IS NULL THEN
    -- A concurrent change already fitted a new lock: return that one.
    SELECT i.token INTO v_token
    FROM public.room_invites i
    WHERE i.room_id = p_room_id AND i.is_door_key AND i.revoked_at IS NULL;
    RETURN v_token;
  END IF;

  PERFORM public.record_room_control_event(
    p_room_id, 'invite_changed', NULL,
    jsonb_build_object('invite_id', v_invite_id, 'state', 'created')
  );

  RETURN v_token;
END;
$function$;

REVOKE ALL ON FUNCTION public.change_room_lock(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.change_room_lock(uuid) TO authenticated;

CREATE FUNCTION public.set_room_nameplate(p_room_id uuid, p_text text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_text text := btrim(regexp_replace(COALESCE(p_text, ''), '\s+', ' ', 'g'));
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in first.' USING ERRCODE = '42501';
  END IF;
  IF p_room_id IS NULL OR NOT public.room_has_capability(p_room_id, v_uid, 'manage_settings') THEN
    RAISE EXCEPTION 'Not allowed to rename this room''s nameplate.' USING ERRCODE = '42501';
  END IF;
  IF v_text !~ '^[A-Za-z0-9 -]{1,12}$' THEN
    RAISE EXCEPTION 'A nameplate is 1–12 letters, numbers, spaces or dashes.' USING ERRCODE = '22023';
  END IF;

  UPDATE public.rooms SET nameplate = v_text WHERE id = p_room_id;

  PERFORM public.record_room_control_event(
    p_room_id, 'settings_changed', NULL, jsonb_build_object('field', 'nameplate')
  );

  RETURN v_text;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_room_nameplate(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_room_nameplate(uuid, text) TO authenticated;
