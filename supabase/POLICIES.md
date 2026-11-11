# OmniLume Supabase security policy reference

This file documents the effective policy model. The executable sources are
`01_schema.sql` plus the ordered migrations in `migrations/`; the final
canonical rebuild applies `003_room_lifecycle.sql` and
`004_security_remediation.sql` after the base dump.

## Effective access rules

| Resource | Effective rule |
|---|---|
| `rooms` | Public rooms are visible only while active. Private rooms require an approved member, owner, or authorized recovery manager. Expired irreversible rooms are hidden. |
| `room_members` | Approved members can see active-room membership. Owners/admins manage other memberships only in active rooms. Users cannot change identity, room, or role to escalate access. |
| `messages` | Private-chat rows are limited to participants. Room rows require approved membership and active/reopened room access. Updates require the current approved sender. |
| `room_messages` | The legacy table remains protected for compatibility, but its application writer is removed. Reads/inserts require approved membership and active/reopened room access. |
| `temporary_media` | Reads/inserts require approved membership, active room access, and an unexpired media row. |
| `message_reactions` / `study_sessions` | Operations are limited to the authenticated user and an approved member of the active room where the record is room-scoped. |
| `storage.objects` | Room attachment paths are scoped by the first path segment as the room UUID, the private bucket, approved membership, and active/reopened room access. |
| `recovery_requests` | Only the current approved owner/admin may submit during the 24-hour recovery window. Requests are reviewed through the protected database function. |
| `room_permanent_requests` | Any current approved member may request permanence during the seven-day reopened period. Only the current owner/admin may review it. |
| `room_notifications` | Notifications are readable and markable only by their intended recipient. |
| `push_subscriptions` | A member may read and delete only their own devices. Rows are written only by `save_push_subscription` (signed-in members; the endpoint must be a known push service) and removed by `remove_push_subscription`. `push_deliveries`, `prune_push_subscription` and `prune_stale_push_subscriptions` are for the service role only. The `queue_push` trigger sends only `{kind, id}` to the app's webhook, using the URL and secret stored in Vault (`push_webhook_url`, `push_webhook_secret`), and can never fail the insert it follows. |

## Server-side helpers and lifecycle

The lifecycle migration uses database time (`now()`) for access decisions. The
security migration provides restricted `SECURITY DEFINER` helpers with an
explicit `public` search path and removes public execution from lifecycle and
review functions.

Temporary-room lifecycle:

1. Original expiry starts a 24-hour recovery-request window.
2. Approved recovery reopens preserved data for seven days.
3. Approved members may request permanent conversion during that period.
4. Only an owner/admin may approve conversion.
5. Permanent conversion clears temporary expiry fields and remains available
   indefinitely.
6. A pending recovery request holds an expired room only for 7 days after it
   was filed. Unanswered after that, it lapses: the room is `destroyed`, the
   daily cleanup deletes it, and its requests cascade. Lapsed requests are
   hidden from the review queue and refused by `review_recovery_request`
   (`20261110070802_recovery_request_lapse.sql`, phase 01b).

Identity and scope protections prevent room-membership identity changes and
message sender/room/chat reassignment. The cleanup endpoint is separately
protected by its server-only secret and service-role configuration.

## Product metrics and live status (hostel roadmap phases 02–03)

- `product_events` (phase 02, `20261110071321_phase02_product_events.sql`):
  anonymous counts only, with no user ids, IPs, message text or titles. RLS is on with no
  policies and every table privilege is revoked from `anon` and
  `authenticated`, so no client can read or write it directly. The only
  client write path is `log_product_event` (`authenticated` only), which
  validates the event, `ref` and meta, and requires approved membership for a
  room-scoped event. `room_tick` is not accepted from clients.
- `night_date(ts)`: a night runs 06:00–06:00 Asia/Kolkata.
- `room_live_status` (phase 03, `20261110071805_phase03_room_live_status.sql`):
  per-room counts and door only. RLS is on with no policies and privileges are revoked. Written only by
  `room_heartbeat` and read only through `get_my_rooms_live`; both are
  `authenticated` only and approved-member only. The heartbeat writes at most
  one `room_tick` per room per 10 minutes, and only while 2+ people are in.

## Door key, nameplate and public invite card (hostel roadmap phases 04–05)

- `rooms.nameplate` (phase 04, `20261110103628_phase04_door_key_and_nameplate.sql`):
  1–12 of `[A-Za-z0-9 -]`, backfilled from a hash of the room id and filled
  by a BEFORE INSERT trigger. Renamed only through `set_room_nameplate`
  (`manage_settings` holders).
- `room_invites.is_door_key`: at most one live door key per room (partial
  unique index). `get_room_door_link` returns it, creating it on first share;
  any approved non-guest member may call it (decision D1), and guests only if
  they hold `manage_invites`. `change_room_lock` (`manage_invites` only)
  revokes the key, so the old link stops joining, and mints a new one. All
  three functions are `authenticated` only; `room_invites` still has no client
  policies, so tokens are never readable directly.
- `get_public_invite_card` (phase 05, `20261110105146_phase05_public_invite_card.sql`)
  is the **only** function `anon` can call from these phases. For a valid
  invite to a room that still exists it returns the room name, nameplate,
  member count, fresh live counts and door, visitor-pass expiry and a running
  timer's end. It never returns ids, names, avatars, the timer subject or
  media titles. It logs `join_viewed` only when `p_log` is true.
- `invite_card_hits`: per-token rate-limit buckets (SHA-256 of the token, never
  the token). RLS on, no policies, privileges revoked. 60 reads per token per
  10 minutes; the 61st raises `PT429` (HTTP 429). Buckets older than a day are
  deleted as the function runs.

## Gate board (hostel roadmap phase 15)

- `get_gate_metrics(p_since date)` (`20261111092811_phase15_gate_metrics.sql`)
  returns one jsonb object of counts and ratios over `product_events` for
  nights on or after `p_since`: activated nights and groups, hostel-proof
  nights, G-D7, G-W4, median minutes, card shares and spots per night, the
  funnel by `ref`, the `lp-a` / `lp-b` A/B and the K-factor inputs. The
  migration's header defines each one.
- It is SECURITY DEFINER with `search_path = ''`. Its first statement raises
  `42501` unless `is_site_owner(auth.uid())`. EXECUTE is revoked from `PUBLIC`
  and `anon` and granted to `authenticated` only, so a signed-in member gets
  `42501` and a signed-out caller gets "permission denied for function".
- It never returns a room id, and `product_events` holds no user ids. The only
  strings returned are `ref` tags, which the table's CHECK limits to
  `^[a-z0-9-]{1,40}$`.
- `/admin/metrics` shows it. The page returns 404 to anyone who is not a site
  owner, like `/admin/recovery`.

## Rebuild and deployment notes

- Do not run only the historical base object dump when rebuilding a project.
- Use `01_schema.sql` with `psql`, which includes the lifecycle/security
  overlays, or apply the ordered migrations through the Supabase migration
  workflow.
- Keep `SUPABASE_SERVICE_ROLE_KEY` and `CRON_SECRET` server-only.
- The `room_messages` table is intentionally retained for database
  compatibility; removing its application writer is separate from dropping
  the table.

## Auth settings

- Leaked-password protection (HaveIBeenPwned) is **off**: the project is on
  the Free plan and the setting needs Pro or above (checked 10 Nov 2026).
  After upgrading, turn it on at Dashboard → Authentication → Attack
  Protection → "Prevent use of leaked passwords".
- Anonymous sign-ins are available on the Free plan. The app never calls
  `signInAnonymously` and there are 0 anonymous users.
