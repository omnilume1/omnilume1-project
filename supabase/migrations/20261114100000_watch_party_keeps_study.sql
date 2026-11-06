-- Watch party no longer turns Study off: a room can run the study tools
-- (timer, notes, whiteboard) while a video plays. Data only, no schema change.

UPDATE public.room_templates
SET description = 'Watch together with chat; Files off.',
    config = jsonb_set(config, '{feature_flags,study}', 'true'::jsonb)
WHERE builtin_key = 'watch-party';

-- Rooms created from the template so far still carry its exact flag set;
-- turn Study on for those (a room whose owner changed any flag is left alone).
UPDATE public.room_control_settings
SET feature_flags = jsonb_set(feature_flags, '{study}', 'true'::jsonb),
    updated_at = now()
WHERE feature_flags = '{"chat": true, "watch": true, "files": false, "study": false, "announcements": true}'::jsonb;
