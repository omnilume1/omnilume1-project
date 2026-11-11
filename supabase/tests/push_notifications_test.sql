-- Push notifications (migration 20261116100000). Runs inside one transaction and rolls back.
-- Every behaviour is exercised as the role that meets it in production: `authenticated`
-- (with a JWT subject), `anon` and `service_role`. Running as the owner would prove nothing.
BEGIN;
SELECT plan(63);

-- ---------------------------------------------------------------- fixtures (owner role)
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-4000-8000-0000000000a1', 'push-test-a@example.invalid'),
  ('00000000-0000-4000-8000-0000000000b1', 'push-test-b@example.invalid'),
  ('00000000-0000-4000-8000-0000000000c1', 'push-test-c@example.invalid'),
  ('00000000-0000-4000-8000-0000000000d1', 'push-test-d@example.invalid');
DO $$ BEGIN
  INSERT INTO public.profiles (id, display_name, username) VALUES ('00000000-0000-4000-8000-0000000000a1', 'Push Tester', 'push_tester_a1')
  ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name;
EXCEPTION WHEN OTHERS THEN NULL; -- the label then falls back to 'OmniLume member'
END $$;
CREATE TEMP TABLE push_test_ctx AS
  SELECT (SELECT r.id FROM public.rooms r ORDER BY r.created_at LIMIT 1) AS room_id,
         (SELECT r.id FROM public.rooms r WHERE NOT EXISTS (SELECT 1 FROM public.groups g WHERE g.source_room_id = r.id) ORDER BY r.created_at LIMIT 1) AS group_room_id,
         NULL::uuid AS mention_id, NULL::uuid AS security_id, NULL::uuid AS group_message_id;
GRANT ALL ON push_test_ctx TO PUBLIC;

-- ---------------------------------------------------------------- 1. privileges
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.push_subscriptions'::regclass), 'push_subscriptions enforces RLS');
SELECT ok(NOT has_table_privilege('anon', 'public.push_subscriptions', 'SELECT') AND NOT has_table_privilege('anon', 'public.push_subscriptions', 'INSERT')
  AND NOT has_table_privilege('anon', 'public.push_subscriptions', 'UPDATE') AND NOT has_table_privilege('anon', 'public.push_subscriptions', 'DELETE'), 'anon has no access to the table');
SELECT ok(has_table_privilege('authenticated', 'public.push_subscriptions', 'SELECT') AND has_table_privilege('authenticated', 'public.push_subscriptions', 'DELETE')
  AND NOT has_table_privilege('authenticated', 'public.push_subscriptions', 'INSERT') AND NOT has_table_privilege('authenticated', 'public.push_subscriptions', 'UPDATE'), 'members may read and delete, never insert or update directly');
SELECT ok(NOT has_function_privilege('anon', 'public.save_push_subscription(text,text,text)', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.remove_push_subscription(text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.push_deliveries(text,uuid)', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.prune_push_subscription(text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.prune_stale_push_subscriptions(integer)', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.queue_push()', 'EXECUTE'), 'anon can call none of the push functions');
SELECT ok(has_function_privilege('authenticated', 'public.save_push_subscription(text,text,text)', 'EXECUTE') AND has_function_privilege('authenticated', 'public.remove_push_subscription(text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.push_deliveries(text,uuid)', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'public.prune_push_subscription(text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.prune_stale_push_subscriptions(integer)', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'public.queue_push()', 'EXECUTE'), 'members can only save and remove their own device');
SELECT ok(has_function_privilege('service_role', 'public.push_deliveries(text,uuid)', 'EXECUTE') AND has_function_privilege('service_role', 'public.prune_push_subscription(text)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.prune_stale_push_subscriptions(integer)', 'EXECUTE'), 'the server role reads deliveries and prunes');
SELECT ok((SELECT count(*) = 6 AND bool_and(prosecdef AND proconfig @> ARRAY['search_path=""']) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('save_push_subscription', 'remove_push_subscription', 'push_deliveries', 'prune_push_subscription', 'prune_stale_push_subscriptions', 'queue_push')), 'every push function is SECURITY DEFINER with an empty search_path');

-- ---------------------------------------------------------------- 2. save / RLS as member A
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT lives_ok($$SELECT public.save_push_subscription('https://fcm.googleapis.com/fcm/send/push-test-a1', repeat('B', 87), repeat('a', 22))$$, 'a member saves their device');
SELECT is((SELECT count(*) FROM public.push_subscriptions), 1::bigint, 'A sees exactly A''s subscription');
SELECT throws_ok($$SELECT public.save_push_subscription('http://fcm.googleapis.com/fcm/send/x', repeat('B', 87), repeat('a', 22))$$, '22023', NULL, 'a non-https endpoint is refused');
SELECT throws_ok($$SELECT public.save_push_subscription('https://169.254.169.254/latest/meta-data/', repeat('B', 87), repeat('a', 22))$$, '22023', NULL, 'an internal address is refused (SSRF guard)');
SELECT throws_ok($$SELECT public.save_push_subscription('https://fcm.googleapis.com.evil.example/x', repeat('B', 87), repeat('a', 22))$$, '22023', NULL, 'a lookalike host is refused');
SELECT throws_ok($$SELECT public.save_push_subscription('https://fcm.googleapis.com@evil.example/x', repeat('B', 87), repeat('a', 22))$$, '22023', NULL, 'a userinfo trick is refused');
SELECT throws_ok($$SELECT public.save_push_subscription('https://fcm.googleapis.com/fcm/send/' || repeat('a', 2000), repeat('B', 87), repeat('a', 22))$$, '22023', NULL, 'an oversized endpoint is refused');
SELECT throws_ok($$SELECT public.save_push_subscription('https://fcm.googleapis.com/fcm/send/keys', 'short', repeat('a', 22))$$, '22023', NULL, 'badly formed keys are refused');
SELECT throws_ok($$INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (auth.uid(), 'https://fcm.googleapis.com/fcm/send/direct', repeat('B', 87), repeat('a', 22))$$, '42501', NULL, 'direct INSERT is denied');
SELECT throws_ok($$UPDATE public.push_subscriptions SET last_seen_at = now()$$, '42501', NULL, 'direct UPDATE is denied');
RESET ROLE;

-- as member B
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is((SELECT count(*) FROM public.push_subscriptions), 0::bigint, 'B cannot see A''s subscription');
DELETE FROM public.push_subscriptions WHERE endpoint = 'https://fcm.googleapis.com/fcm/send/push-test-a1';
SELECT lives_ok($$SELECT public.remove_push_subscription('https://fcm.googleapis.com/fcm/send/push-test-a1')$$, 'removing someone else''s device is a no-op, not an error');
RESET ROLE;
SELECT is((SELECT count(*) FROM public.push_subscriptions WHERE endpoint = 'https://fcm.googleapis.com/fcm/send/push-test-a1'), 1::bigint, 'B can neither delete nor remove A''s subscription');

-- the same phone, another account: the endpoint moves
SET LOCAL ROLE authenticated;
SELECT lives_ok($$SELECT public.save_push_subscription('https://fcm.googleapis.com/fcm/send/push-test-a1', repeat('B', 87), repeat('a', 22))$$, 'B signs in on the same phone');
RESET ROLE;
SELECT is((SELECT user_id FROM public.push_subscriptions WHERE endpoint = 'https://fcm.googleapis.com/fcm/send/push-test-a1'), '00000000-0000-4000-8000-0000000000b1'::uuid, 'the endpoint now belongs to B only');
SET LOCAL ROLE authenticated;
SELECT lives_ok($$SELECT public.remove_push_subscription('https://fcm.googleapis.com/fcm/send/push-test-a1')$$, 'a member removes their own device');
RESET ROLE;
SELECT is((SELECT count(*) FROM public.push_subscriptions WHERE endpoint = 'https://fcm.googleapis.com/fcm/send/push-test-a1'), 0::bigint, 'and it is gone');

-- no user id, and anon
SELECT set_config('request.jwt.claims', '{"role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.save_push_subscription('https://fcm.googleapis.com/fcm/send/nobody', repeat('B', 87), repeat('a', 22))$$, '42501', NULL, 'no user id, no subscription');
RESET ROLE;
SELECT set_config('request.jwt.claims', '', true);
SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT public.save_push_subscription('https://fcm.googleapis.com/fcm/send/anon', repeat('B', 87), repeat('a', 22))$$, '42501', NULL, 'anon cannot save a subscription');
SELECT throws_ok($$SELECT public.remove_push_subscription('https://fcm.googleapis.com/fcm/send/anon')$$, '42501', NULL, 'anon cannot remove one');
SELECT throws_ok($$SELECT * FROM public.push_deliveries('dm', '00000000-0000-4000-8000-000000000101')$$, '42501', NULL, 'anon cannot read deliveries');
SELECT throws_ok($$SELECT count(*) FROM public.push_subscriptions$$, '42501', NULL, 'anon cannot read the table');
RESET ROLE;

-- at most 10 devices per member
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT public.save_push_subscription('https://fcm.googleapis.com/fcm/send/cap-' || n, repeat('B', 87), repeat('a', 22)) FROM generate_series(1, 10) AS n;
RESET ROLE;
UPDATE public.push_subscriptions SET last_seen_at = now() - interval '2 days' WHERE endpoint = 'https://fcm.googleapis.com/fcm/send/cap-1';
SET LOCAL ROLE authenticated;
SELECT public.save_push_subscription('https://fcm.googleapis.com/fcm/send/cap-11', repeat('B', 87), repeat('a', 22));
RESET ROLE;
SELECT is((SELECT count(*) FROM public.push_subscriptions WHERE user_id = '00000000-0000-4000-8000-0000000000a1'), 10::bigint, 'an 11th device keeps the member at 10');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.push_subscriptions WHERE endpoint = 'https://fcm.googleapis.com/fcm/send/cap-1'), 'and drops the one seen longest ago');

-- ---------------------------------------------------------------- 3. triggers and deliveries
INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth) VALUES
  ('00000000-0000-4000-8000-0000000000b1', 'https://fcm.googleapis.com/fcm/send/dev-b1', repeat('B', 87), repeat('a', 22)),
  ('00000000-0000-4000-8000-0000000000c1', 'https://fcm.googleapis.com/fcm/send/dev-c1', repeat('B', 87), repeat('a', 22)),
  ('00000000-0000-4000-8000-0000000000d1', 'https://fcm.googleapis.com/fcm/send/dev-d1', repeat('B', 87), repeat('a', 22));
INSERT INTO public.friendships (user_one, user_two) VALUES ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1');
INSERT INTO public.private_chats (id, user_one, user_two) VALUES ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1');
INSERT INTO public.groups (id, name, created_by, source_room_id) SELECT '00000000-0000-4000-8000-0000000000f1', 'Push Test Group', '00000000-0000-4000-8000-0000000000a1', group_room_id FROM push_test_ctx;
INSERT INTO public.group_members (group_id, user_id, role) VALUES
  ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000a1', 'owner'),
  ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000b1', 'member'),
  ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000c1', 'member');
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'push_webhook_url') THEN PERFORM vault.create_secret('https://example.invalid/api/internal/push', 'push_webhook_url'); END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'push_webhook_secret') THEN PERFORM vault.create_secret('test-only-secret-0123456789abcdef', 'push_webhook_secret'); END IF;
END $$;

-- a direct message and a group message, sent by A as an ordinary member
SET LOCAL ROLE authenticated;
SELECT lives_ok($$INSERT INTO public.messages (id, chat_id, sender_id, receiver_id, ciphertext, iv) VALUES ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldY', 'QUJDREVGR0hJSktM')$$, 'a member sends a direct message with the push trigger in place');
-- Members may insert only these three columns (as the app does), so the id is looked up afterwards.
SELECT lives_ok($$INSERT INTO public.group_messages (group_id, sender_id, content) VALUES ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000a1', 'the plan is secret')$$, 'and a group message');
RESET ROLE;
UPDATE push_test_ctx SET group_message_id = (SELECT id FROM public.group_messages WHERE group_id = '00000000-0000-4000-8000-0000000000f1' ORDER BY created_at DESC, id DESC LIMIT 1);
SELECT is((SELECT count(*) FROM net.http_request_queue WHERE convert_from(body, 'UTF8')::jsonb = jsonb_build_object('kind', 'dm', 'id', '00000000-0000-4000-8000-000000000101')), 1::bigint, 'the DM queued exactly one webhook call whose body is only kind and id');
SELECT is((SELECT count(*) FROM net.http_request_queue WHERE convert_from(body, 'UTF8')::jsonb = jsonb_build_object('kind', 'group_message', 'id', (SELECT group_message_id FROM push_test_ctx))), 1::bigint, 'the group message queued exactly one, and no text left the database');
SELECT ok((SELECT bool_and(q.headers ->> 'Authorization' LIKE 'Bearer %' AND q.url = (SELECT ds.decrypted_secret FROM vault.decrypted_secrets ds WHERE ds.name = 'push_webhook_url') AND q.timeout_milliseconds = 2000)
  FROM net.http_request_queue q WHERE convert_from(q.body, 'UTF8')::jsonb ->> 'id' IN ('00000000-0000-4000-8000-000000000101', (SELECT group_message_id::text FROM push_test_ctx))), 'calls go to the Vault URL with the bearer secret and a 2 s timeout');

-- a room notification, through the only function that writes them (it is not callable by members)
SELECT ok(public.enqueue_room_notification(p_recipient_id := '00000000-0000-4000-8000-0000000000b1', p_room_id := (SELECT room_id FROM push_test_ctx), p_type := 'mention', p_message := 'Push Tester mentioned you.', p_actor_id := '00000000-0000-4000-8000-0000000000a1'), 'a room notification is written');
UPDATE push_test_ctx SET mention_id = (SELECT id FROM public.room_notifications WHERE recipient_id = '00000000-0000-4000-8000-0000000000b1' AND notification_type = 'mention' ORDER BY created_at DESC, id DESC LIMIT 1);
SELECT is((SELECT count(*) FROM net.http_request_queue WHERE convert_from(body, 'UTF8')::jsonb = jsonb_build_object('kind', 'room_notification', 'id', (SELECT mention_id FROM push_test_ctx))), 1::bigint, 'and queues exactly one webhook call');

SET LOCAL ROLE service_role;
SELECT is((SELECT array_agg(endpoint) FROM public.push_deliveries('dm', '00000000-0000-4000-8000-000000000101')), ARRAY['https://fcm.googleapis.com/fcm/send/dev-b1'], 'a DM targets only the receiver');
SELECT ok((SELECT bool_and(kind = 'dm' AND message IS NULL AND metadata IS NULL AND chat_id = '00000000-0000-4000-8000-0000000000e1' AND sender_label IN ('Push Tester', 'OmniLume member')) FROM public.push_deliveries('dm', '00000000-0000-4000-8000-000000000101')), 'with the sender''s name and never any text');
SELECT is((SELECT array_agg(endpoint ORDER BY endpoint) FROM public.push_deliveries('group_message', (SELECT group_message_id FROM push_test_ctx))), ARRAY['https://fcm.googleapis.com/fcm/send/dev-b1', 'https://fcm.googleapis.com/fcm/send/dev-c1'], 'a group message targets every member except the sender');
SELECT ok((SELECT bool_and(message IS NULL AND group_name = 'Push Test Group' AND group_id = '00000000-0000-4000-8000-0000000000f1') FROM public.push_deliveries('group_message', (SELECT group_message_id FROM push_test_ctx))), 'with the group name and never the text');
SELECT ok((SELECT count(*) = 1 AND bool_and(endpoint = 'https://fcm.googleapis.com/fcm/send/dev-b1' AND notification_type = 'mention' AND message = 'Push Tester mentioned you.' AND room_name IS NOT NULL) FROM public.push_deliveries('room_notification', (SELECT mention_id FROM push_test_ctx))), 'a room notification targets its recipient with the bell''s own line');
SELECT is((SELECT count(*) FROM public.push_deliveries('dm', (SELECT group_message_id FROM push_test_ctx))), 0::bigint, 'an id of the wrong kind matches nothing');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT * FROM public.push_deliveries('dm', '00000000-0000-4000-8000-000000000101')$$, '42501', NULL, 'members cannot read deliveries');
RESET ROLE;

-- blocks, either way
INSERT INTO public.user_blocks (blocker_id, blocked_id) VALUES ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a1');
SET LOCAL ROLE service_role;
SELECT ok((SELECT count(*) FROM public.push_deliveries('dm', '00000000-0000-4000-8000-000000000101')) = 0
  AND (SELECT array_agg(endpoint) FROM public.push_deliveries('group_message', (SELECT group_message_id FROM push_test_ctx))) = ARRAY['https://fcm.googleapis.com/fcm/send/dev-c1']
  AND (SELECT count(*) FROM public.push_deliveries('room_notification', (SELECT mention_id FROM push_test_ctx))) = 0, 'a receiver who blocked the sender gets no DM, group or mention push');
RESET ROLE;
DELETE FROM public.user_blocks WHERE blocker_id = '00000000-0000-4000-8000-0000000000b1';
INSERT INTO public.user_blocks (blocker_id, blocked_id) VALUES ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1');
SET LOCAL ROLE service_role;
SELECT is((SELECT count(*) FROM public.push_deliveries('dm', '00000000-0000-4000-8000-000000000101')), 0::bigint, 'a block by the sender does the same');
RESET ROLE;
DELETE FROM public.user_blocks WHERE blocker_id = '00000000-0000-4000-8000-0000000000a1';

-- do-not-disturb and room mute
INSERT INTO public.notification_preferences (user_id, room_id, muted_until) VALUES ('00000000-0000-4000-8000-0000000000b1', NULL, NULL);
SELECT is(public.enqueue_room_notification(p_recipient_id := '00000000-0000-4000-8000-0000000000b1', p_room_id := (SELECT room_id FROM push_test_ctx), p_type := 'mention', p_message := 'Muted mention.', p_actor_id := '00000000-0000-4000-8000-0000000000a1'), false, 'under do-not-disturb an ordinary notification is not even written');
SELECT ok(public.enqueue_room_notification(p_recipient_id := '00000000-0000-4000-8000-0000000000b1', p_room_id := (SELECT room_id FROM push_test_ctx), p_type := 'security', p_message := 'A new device signed in.'), 'but a security notification is');
UPDATE push_test_ctx SET security_id = (SELECT id FROM public.room_notifications WHERE recipient_id = '00000000-0000-4000-8000-0000000000b1' AND notification_type = 'security' ORDER BY created_at DESC, id DESC LIMIT 1);
SET LOCAL ROLE service_role;
SELECT ok((SELECT count(*) FROM public.push_deliveries('dm', '00000000-0000-4000-8000-000000000101')) = 0
  AND (SELECT array_agg(endpoint) FROM public.push_deliveries('group_message', (SELECT group_message_id FROM push_test_ctx))) = ARRAY['https://fcm.googleapis.com/fcm/send/dev-c1'], 'global do-not-disturb silences DM and group pushes');
SELECT is((SELECT count(*) FROM public.push_deliveries('room_notification', (SELECT security_id FROM push_test_ctx))), 1::bigint, 'and the security notification still arrives');
RESET ROLE;
DELETE FROM public.notification_preferences WHERE user_id = '00000000-0000-4000-8000-0000000000b1';
INSERT INTO public.notification_preferences (user_id, room_id) SELECT '00000000-0000-4000-8000-0000000000b1', room_id FROM push_test_ctx;
SELECT is(public.enqueue_room_notification(p_recipient_id := '00000000-0000-4000-8000-0000000000b1', p_room_id := (SELECT room_id FROM push_test_ctx), p_type := 'mention', p_message := 'Muted room.', p_actor_id := '00000000-0000-4000-8000-0000000000a1'), false, 'a room-muted member gets no notification row, so no push');
DELETE FROM public.notification_preferences WHERE user_id = '00000000-0000-4000-8000-0000000000b1';

-- read, deleted and old sources
UPDATE public.room_notifications SET read_at = now() WHERE id = (SELECT mention_id FROM push_test_ctx);
DO $$ BEGIN
  UPDATE public.messages SET is_deleted = true WHERE id = '00000000-0000-4000-8000-000000000101';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'could not mark the test message deleted: %', SQLERRM; -- the assertion below then fails
END $$;
UPDATE public.group_messages SET created_at = now() - interval '11 minutes' WHERE id = (SELECT group_message_id FROM push_test_ctx);
SET LOCAL ROLE service_role;
SELECT ok((SELECT count(*) FROM public.push_deliveries('room_notification', (SELECT mention_id FROM push_test_ctx))) = 0, 'a read notification is not pushed');
SELECT ok((SELECT count(*) FROM public.push_deliveries('dm', '00000000-0000-4000-8000-000000000101')) = 0, 'a deleted message is not pushed');
SELECT ok((SELECT count(*) FROM public.push_deliveries('group_message', (SELECT group_message_id FROM push_test_ctx))) = 0, 'a source older than 10 minutes is not pushed (replay guard)');
RESET ROLE;
SELECT ok((SELECT pg_get_triggerdef(oid) LIKE '%chat_id IS NOT NULL%' AND pg_get_triggerdef(oid) LIKE '%room_id IS NULL%' FROM pg_trigger WHERE tgname = 'queue_push_dm' AND tgrelid = 'public.messages'::regclass), 'room chat (room_id set) never queues a push');

-- the trigger can never fail an insert
SELECT vault.update_secret(id, new_name := name || '-off') FROM vault.secrets WHERE name IN ('push_webhook_url', 'push_webhook_secret');
SET LOCAL ROLE authenticated;
SELECT lives_ok($$INSERT INTO public.messages (id, chat_id, sender_id, receiver_id, ciphertext, iv) VALUES ('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldY', 'QUJDREVGR0hJSktM')$$, 'without the Vault secrets a message still sends');
RESET ROLE;
SELECT is((SELECT count(*) FROM net.http_request_queue WHERE convert_from(body, 'UTF8')::jsonb ->> 'id' = '00000000-0000-4000-8000-000000000103'), 0::bigint, 'and nothing is queued');
SELECT vault.update_secret(id, new_name := replace(name, '-off', '')) FROM vault.secrets WHERE name IN ('push_webhook_url-off', 'push_webhook_secret-off');
CREATE TEMP TABLE push_probe (note text);
CREATE TRIGGER push_probe_queue AFTER INSERT ON push_probe FOR EACH ROW EXECUTE FUNCTION public.queue_push('dm');
SELECT lives_ok($$INSERT INTO push_probe VALUES ('this table has no id, so building the webhook call fails')$$, 'an error inside the trigger never fails the insert');

-- ---------------------------------------------------------------- 4. clean-up paths
DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-0000000000d1';
SELECT is((SELECT count(*) FROM public.push_subscriptions WHERE endpoint = 'https://fcm.googleapis.com/fcm/send/dev-d1'), 0::bigint, 'deleting an account removes its subscriptions');
UPDATE public.push_subscriptions SET last_seen_at = now() - interval '61 days' WHERE endpoint = 'https://fcm.googleapis.com/fcm/send/dev-c1';
SET LOCAL ROLE service_role;
SELECT ok(public.prune_stale_push_subscriptions(60) >= 1, 'devices not seen for 60 days are pruned');
SELECT lives_ok($$SELECT public.prune_push_subscription('https://fcm.googleapis.com/fcm/send/dev-b1')$$, 'the server prunes a subscription the push service reports gone');
RESET ROLE;
SELECT ok(NOT EXISTS (SELECT 1 FROM public.push_subscriptions WHERE endpoint IN ('https://fcm.googleapis.com/fcm/send/dev-b1', 'https://fcm.googleapis.com/fcm/send/dev-c1'))
  AND EXISTS (SELECT 1 FROM public.push_subscriptions WHERE endpoint = 'https://fcm.googleapis.com/fcm/send/cap-11'), 'both are gone, and a recently seen device is kept');

SELECT * FROM finish();
ROLLBACK;
