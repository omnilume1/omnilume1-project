-- Push notifications while the app is closed (standard Web Push).
--
-- A new room notification, direct message or group message queues one small HTTP call
-- (pg_net) to the app's /api/internal/push route with only {"kind", "id"}. The route asks
-- push_deliveries() who should hear about it and sends the pushes. No name, text or
-- ciphertext ever leaves the database in the webhook, and message text is never returned
-- for a direct or group message.
--
-- Secrets (the webhook URL and its bearer secret) live in Supabase Vault as
-- 'push_webhook_url' and 'push_webhook_secret'. Until both exist, nothing is queued.

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- ---------------------------------------------------------------------------
-- Subscriptions: one row per browser or installed app that asked for pushes.
-- ---------------------------------------------------------------------------
CREATE TABLE public.push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT push_subscriptions_endpoint_https CHECK (endpoint ~ '^https://' AND char_length(endpoint) <= 1000),
  CONSTRAINT push_subscriptions_p256dh_format CHECK (p256dh ~ '^[A-Za-z0-9_-]{87}$'),
  CONSTRAINT push_subscriptions_auth_format CHECK (auth ~ '^[A-Za-z0-9_-]{22}$')
);
CREATE INDEX push_subscriptions_user_seen_idx ON public.push_subscriptions (user_id, last_seen_at DESC);
CREATE INDEX push_subscriptions_last_seen_idx ON public.push_subscriptions (last_seen_at);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.push_subscriptions FROM PUBLIC, anon, authenticated;
-- A member may see and delete their own devices. Writes go only through the RPCs below.
GRANT SELECT, DELETE ON TABLE public.push_subscriptions TO authenticated;
CREATE POLICY push_subscriptions_select_own ON public.push_subscriptions
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY push_subscriptions_delete_own ON public.push_subscriptions
  FOR DELETE TO authenticated USING (user_id = (SELECT auth.uid()));

-- ---------------------------------------------------------------------------
-- save_push_subscription: the only way a row is written.
-- The endpoint pattern is the SSRF guard (the server POSTs to this URL) and is the same
-- string as PUSH_ENDPOINT_PATTERN in src/lib/push-endpoint.ts; a unit test compares them.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = ''
  AS $$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Sign in to turn on notifications.' USING ERRCODE = '42501';
  END IF;
  IF p_endpoint IS NULL OR char_length(p_endpoint) > 1000
     OR p_endpoint !~ '^https://(fcm\.googleapis\.com|[a-z0-9-]+\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com|web\.push\.apple\.com|[a-z0-9-]+\.push\.apple\.com)/[!-~]*$' THEN
    RAISE EXCEPTION 'This browser''s push service is not supported.' USING ERRCODE = '22023';
  END IF;
  IF p_p256dh IS NULL OR p_auth IS NULL OR p_p256dh !~ '^[A-Za-z0-9_-]{87}$' OR p_auth !~ '^[A-Za-z0-9_-]{22}$' THEN
    RAISE EXCEPTION 'The notification keys are not valid.' USING ERRCODE = '22023';
  END IF;

  -- A phone can change accounts: the endpoint moves to whoever is signed in now.
  INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth)
  VALUES (v_user, p_endpoint, p_p256dh, p_auth)
  ON CONFLICT (endpoint) DO UPDATE
    SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, last_seen_at = now();

  -- At most 10 devices per member: the ones seen longest ago go first.
  DELETE FROM public.push_subscriptions s
  WHERE s.user_id = v_user
    AND s.id IN (
      SELECT o.id FROM public.push_subscriptions o
      WHERE o.user_id = v_user
      ORDER BY o.last_seen_at DESC, o.created_at DESC, o.id
      OFFSET 10
    );
END;
$$;
REVOKE ALL ON FUNCTION public.save_push_subscription(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_push_subscription(text, text, text) TO authenticated;

CREATE FUNCTION public.remove_push_subscription(p_endpoint text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = ''
  AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in first.' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.push_subscriptions s WHERE s.endpoint = p_endpoint AND s.user_id = auth.uid();
END;
$$;
REVOKE ALL ON FUNCTION public.remove_push_subscription(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_push_subscription(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- push_deliveries: who gets a push for one event, with what the notification may show.
-- Service role only. Message text is returned only for room notifications (the short
-- server-written line the bell already shows); never for direct or group messages.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.push_deliveries(p_kind text, p_id uuid)
  RETURNS TABLE (
    endpoint text, p256dh text, auth text, kind text, notification_type text, room_id uuid, room_name text,
    sender_label text, group_name text, chat_id uuid, group_id uuid, message text, entity_id uuid, metadata jsonb
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = ''
  AS $$
  -- A room notification: already filtered for mutes and self by enqueue_room_notification.
  SELECT s.endpoint, s.p256dh, s.auth, 'room_notification'::text, rn.notification_type, rn.room_id,
         COALESCE(NULLIF(btrim(rn.metadata ->> 'room_name'), ''), r.name),
         NULL::text, NULL::text, NULL::uuid, NULL::uuid, rn.message, rn.entity_id, rn.metadata
  FROM public.room_notifications rn
  JOIN public.push_subscriptions s ON s.user_id = rn.recipient_id
  LEFT JOIN public.rooms r ON r.id = rn.room_id
  WHERE p_kind = 'room_notification'
    AND rn.id = p_id
    AND rn.read_at IS NULL
    AND rn.created_at > now() - interval '10 minutes'
    AND (
      rn.actor_id IS NULL
      OR rn.notification_type IN ('recovery_request', 'recovery_decision', 'access', 'security', 'room_deletion')
      OR NOT EXISTS (
        SELECT 1 FROM public.user_blocks b
        WHERE (b.blocker_id = rn.recipient_id AND b.blocked_id = rn.actor_id)
           OR (b.blocker_id = rn.actor_id AND b.blocked_id = rn.recipient_id)
      )
    )

  UNION ALL

  -- A direct message: the receiver only. Never room chat, never a deleted message.
  SELECT s.endpoint, s.p256dh, s.auth, 'dm'::text, NULL::text, NULL::uuid, NULL::text,
         COALESCE(NULLIF(btrim(p.display_name), ''), NULLIF(btrim(p.username), ''), 'OmniLume member'),
         NULL::text, m.chat_id, NULL::uuid, NULL::text, NULL::uuid, NULL::jsonb
  FROM public.messages m
  JOIN public.push_subscriptions s ON s.user_id = m.receiver_id
  LEFT JOIN public.profiles p ON p.id = m.sender_id
  WHERE p_kind = 'dm'
    AND m.id = p_id
    AND m.chat_id IS NOT NULL
    AND m.room_id IS NULL
    AND m.receiver_id IS NOT NULL
    AND m.receiver_id <> m.sender_id
    AND COALESCE(m.is_deleted, false) = false
    AND m.created_at > now() - interval '10 minutes'
    AND NOT public.notifications_suppressed(m.receiver_id, NULL)
    AND NOT EXISTS (
      SELECT 1 FROM public.user_blocks b
      WHERE (b.blocker_id = m.receiver_id AND b.blocked_id = m.sender_id)
         OR (b.blocker_id = m.sender_id AND b.blocked_id = m.receiver_id)
    )

  UNION ALL

  -- A group message: every member except the sender.
  SELECT s.endpoint, s.p256dh, s.auth, 'group_message'::text, NULL::text, NULL::uuid, NULL::text,
         COALESCE(NULLIF(btrim(p.display_name), ''), NULLIF(btrim(p.username), ''), 'OmniLume member'),
         g.name, NULL::uuid, gm.group_id, NULL::text, NULL::uuid, NULL::jsonb
  FROM public.group_messages gm
  JOIN public.groups g ON g.id = gm.group_id
  JOIN public.group_members member ON member.group_id = gm.group_id AND member.user_id <> gm.sender_id
  JOIN public.push_subscriptions s ON s.user_id = member.user_id
  LEFT JOIN public.profiles p ON p.id = gm.sender_id
  WHERE p_kind = 'group_message'
    AND gm.id = p_id
    AND gm.created_at > now() - interval '10 minutes'
    AND NOT public.notifications_suppressed(member.user_id, NULL)
    AND NOT EXISTS (
      SELECT 1 FROM public.user_blocks b
      WHERE (b.blocker_id = member.user_id AND b.blocked_id = gm.sender_id)
         OR (b.blocker_id = gm.sender_id AND b.blocked_id = member.user_id)
    );
$$;
REVOKE ALL ON FUNCTION public.push_deliveries(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.push_deliveries(text, uuid) TO service_role;

-- The push service said this subscription is gone (404 or 410).
CREATE FUNCTION public.prune_push_subscription(p_endpoint text) RETURNS void
  LANGUAGE sql SECURITY DEFINER
  SET search_path = ''
  AS $$
  DELETE FROM public.push_subscriptions s WHERE s.endpoint = p_endpoint;
$$;
REVOKE ALL ON FUNCTION public.prune_push_subscription(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_push_subscription(text) TO service_role;

-- Daily cleanup: devices that have not opened the app for a long time.
CREATE FUNCTION public.prune_stale_push_subscriptions(p_days integer DEFAULT 60) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = ''
  AS $$
DECLARE
  v_removed integer;
BEGIN
  DELETE FROM public.push_subscriptions s
  WHERE s.last_seen_at < now() - make_interval(days => GREATEST(COALESCE(p_days, 60), 7));
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  RETURN v_removed;
END;
$$;
REVOKE ALL ON FUNCTION public.prune_stale_push_subscriptions(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_stale_push_subscriptions(integer) TO service_role;

-- ---------------------------------------------------------------------------
-- queue_push: the trigger. It must never fail the insert it follows, so everything is
-- inside an exception block, and the warning carries only the error code.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.queue_push() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = ''
  AS $$
DECLARE
  v_url text;
  v_secret text;
BEGIN
  BEGIN
    SELECT ds.decrypted_secret INTO v_url FROM vault.decrypted_secrets ds WHERE ds.name = 'push_webhook_url' LIMIT 1;
    SELECT ds.decrypted_secret INTO v_secret FROM vault.decrypted_secrets ds WHERE ds.name = 'push_webhook_secret' LIMIT 1;
    IF COALESCE(btrim(v_url), '') = '' OR COALESCE(btrim(v_secret), '') = '' THEN
      RETURN NULL;
    END IF;
    PERFORM net.http_post(
      url := v_url,
      body := jsonb_build_object('kind', TG_ARGV[0], 'id', NEW.id),
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
      timeout_milliseconds := 2000
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'queue_push could not queue a push (%).', SQLSTATE;
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.queue_push() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER queue_push_room_notification
  AFTER INSERT ON public.room_notifications
  FOR EACH ROW EXECUTE FUNCTION public.queue_push('room_notification');

-- Direct messages only: room chat (room_id set) reaches people as room notifications.
CREATE TRIGGER queue_push_dm
  AFTER INSERT ON public.messages
  FOR EACH ROW WHEN (NEW.chat_id IS NOT NULL AND NEW.room_id IS NULL AND NEW.receiver_id IS NOT NULL)
  EXECUTE FUNCTION public.queue_push('dm');

CREATE TRIGGER queue_push_group_message
  AFTER INSERT ON public.group_messages
  FOR EACH ROW EXECUTE FUNCTION public.queue_push('group_message');
