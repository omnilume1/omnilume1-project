# Actions 13–14 plan (branch `feat/actions-13-14`)

Resume point. Tick an item only with its commit hash; evidence goes in
`docs/action-01-10-evidence-ledger.md` (section "Actions 13–14").
Specs: `OmniLume_Final_Corrected_Roadmap.pdf` (Actions 13, 14),
`OMNILUME_MASTER_PLAN.md` §6, §10. Owner decisions: 7-day recovery; no Ghost
Mode work; E2EE unchanged (ciphertext never rewritten); AI is Action 17
(skipped); minimum age 13; site owners = `site_owners` rows. External
providers not configured → provider-neutral free path, noted in the ledger.

Rules: additive migrations; RLS on every new table; FKs/unique/status checks;
SECURITY DEFINER with `search_path = ''`, EXECUTE only where needed, policy
helpers executable by `authenticated`; every realtime channel `private: true`
(no new channels: activity rides the existing `sync:<room>` channel via
Postgres Changes + RLS); never trust the client; actions return errors as
values; permission-gate by room role; a11y + reduced motion. Dry run every
migration as `authenticated` (rolled back) before `npx supabase db push`.
Never push to git, never merge.

Facts that shape the design: E2EE exists for personal chats only
(`messages.ciphertext`), rooms are plaintext; the Room Dashboard (Action 09)
and `search_room_history` (Action 12) already exist; `room_events` (Action 12)
exist; `room_control_events` is the audited, published control log.

## Action 13 — Activity, discovery, events and management
Privacy: private, locked (invite-only), scheduled, deletion-pending and
converted rooms are never discoverable. Discovery/activity are enforced in
RPC/RLS and probed.
- [ ] 13.1 Room Search + Smart Search/Filters (Explore): `discover_rooms`
      RPC (query, lifespan, min members, feature, sort; public only) and a
      "My rooms" scope. Exists: client-side name filter. Extend: Explore UI.
- [ ] 13.2 Activity / Room History: append-only `room_activity` (kind,
      actor, entity only; labels resolved at read by capability), triggers on
      existing tables, `list_room_activity` RPC, feed UI. Exists:
      `room_control_events` (control log only).
- [ ] 13.3 Live Activity Bar / Room Pulse: `get_room_pulse` + live bar
      (online, recent chat/activity, next event) using presence + activity
      Postgres Changes on the existing channel.
- [ ] 13.4 Room Dashboard / Home: extend RoomDashboard (Action 09) with
      Pulse + recent activity + upcoming event.
- [ ] 13.5 Bookmarks / Saved content: `room_bookmarks` (room, message, file),
      save/remove/list RPCs with per-kind access checks; UI in Explore, chat,
      files and Home.
- [ ] 13.6 Room Templates: `room_templates` (own + built-in), save-from-room,
      apply at create; UI in create-room and room settings.
- [ ] 13.7 Smart Auto-Organization: `list_my_room_overview` + pure bucketing
      (`room-organization.ts`: attention / active / expiring / saved / quiet).
- [ ] 13.8 Reputation / Trust Levels: derived (no stored score)
      `get_room_trust_levels` (managers see all, others only self); badges.
- [ ] 13.9 Cross-Room Personal Dashboard: Home sections from the overview,
      upcoming events, assigned tasks, saved items.
- [ ] 13.10 Backup / Export: `export_room_snapshot` (owner/admin, rate
      limited, audited in `room_exports`, SHA-256 digest, no keys/ciphertext);
      server action + download.
- [ ] 13.11 Event management: RSVPs on `room_events` (`room_event_rsvps`),
      counts + own response, events in Home.
- [ ] 13.12 Unit tests; probes (member/admin/owner/outsider/anon); dry run;
      push; two-account browser (desktop + mobile); ledger.

## Action 14 — Room-to-group conversion
- [ ] 14.1 Schema: `groups` (no username/link; `source_room_id` UNIQUE,
      FK RESTRICT), `group_members`, `room_group_conversions` (audit +
      staged references + counts); RLS; constraints.
- [ ] 14.2 `convert_room_to_group(room)`: one SECURITY DEFINER transaction;
      owner only; eligibility (active, not irreversible, no deletion
      scheduled); row lock → idempotent; exact room name; approved
      non-guest, non-restricted members with roles; E2EE key check; ciphertext
      untouched; source room kept (permanent, private, locked, invites
      revoked, username cleared and recorded).
- [ ] 14.3 Lifecycle: cleanup/destroy/due-list exclude converted rooms,
      `schedule_room_deletion` refuses, pending recovery/permanent requests
      and cleanup jobs resolved; legacy `convert_active_room_to_permanent`
      no longer executable; account deletion handles group rooms.
- [ ] 14.4 Notify migrated members (`group_conversion`) and publish one
      `group_converted` control event.
- [ ] 14.5 UI: conversion dialog (what is preserved, no username), result
      and idempotent retry, group badge; server action returns values.
- [ ] 14.6 Unit tests; probes (member/admin/owner/outsider/anon, double
      call, cleanup-never-deletes, ciphertext hash); dry run; push;
      two-account browser; ledger.
