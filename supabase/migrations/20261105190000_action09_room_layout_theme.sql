-- Action 09: owner-controlled room layout and theme.
--
-- The room's default layout preset, whether members may change it, and the
-- room theme live with the other room controls. Only members with
-- manage_settings change them (update_room_appearance); every approved
-- member reads them through the existing room_control_settings policy.
-- Changes are announced as a settings_changed room control event, which
-- members already receive, so layouts update live without a new channel.
-- Personal presets and panel sizes stay in the member's own browser storage,
-- keyed by room and user.

ALTER TABLE public.room_control_settings
  ADD COLUMN IF NOT EXISTS default_layout text NOT NULL DEFAULT 'balanced',
  ADD COLUMN IF NOT EXISTS layout_locked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS theme text NOT NULL DEFAULT 'violet';

ALTER TABLE public.room_control_settings DROP CONSTRAINT IF EXISTS room_control_settings_default_layout_check;
ALTER TABLE public.room_control_settings ADD CONSTRAINT room_control_settings_default_layout_check
  CHECK (default_layout IN ('balanced', 'stage', 'chat'));
ALTER TABLE public.room_control_settings DROP CONSTRAINT IF EXISTS room_control_settings_theme_check;
ALTER TABLE public.room_control_settings ADD CONSTRAINT room_control_settings_theme_check
  CHECK (theme IN ('violet', 'ocean', 'emerald', 'amber', 'rose', 'graphite'));

CREATE OR REPLACE FUNCTION public.update_room_appearance(
  p_room_id uuid,
  p_default_layout text,
  p_layout_locked boolean,
  p_theme text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.room_has_capability(p_room_id, auth.uid(), 'manage_settings') THEN
    RAISE EXCEPTION 'Only members who manage room settings can change the layout and theme.' USING ERRCODE = '42501';
  END IF;
  IF p_default_layout IS NULL OR p_default_layout NOT IN ('balanced', 'stage', 'chat')
     OR p_theme IS NULL OR p_theme NOT IN ('violet', 'ocean', 'emerald', 'amber', 'rose', 'graphite')
     OR p_layout_locked IS NULL THEN
    RAISE EXCEPTION 'Choose a valid layout and theme.' USING ERRCODE = '22023';
  END IF;

  UPDATE public.room_control_settings settings
  SET default_layout = p_default_layout,
      layout_locked = p_layout_locked,
      theme = p_theme,
      updated_at = now(),
      updated_by = auth.uid()
  WHERE settings.room_id = p_room_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Room settings were not found.' USING ERRCODE = 'P0002';
  END IF;

  PERFORM public.record_room_control_event(p_room_id, 'settings_changed', NULL, jsonb_build_object('kind', 'appearance'));
  RETURN jsonb_build_object('default_layout', p_default_layout, 'layout_locked', p_layout_locked, 'theme', p_theme);
END;
$$;

REVOKE ALL ON FUNCTION public.update_room_appearance(uuid, text, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_room_appearance(uuid, text, boolean, text) TO authenticated;
