# Actions 01–10 completion plan (branch `feat/actions-01-10-complete`)

Resume point for the completion run started 2026-11-05. Tick an item only
with its commit hash; evidence goes in `docs/action-01-10-evidence-ledger.md`.
Specs: `OmniLume_Final_Corrected_Roadmap.pdf` (Actions 05, 06, 08, 09, 10),
`OMNILUME_MASTER_PLAN.md` §9, and the owner decisions below (they override
the PDFs).

Owner decisions: Action 02 COMPLETE (Google sign-in confirmed by owner).
Action 06 production cron verified by owner (2026-11-05 08:00 UTC logs).
GIPHY env renamed and under-13 profiles deleted by owner (do not touch).
Recovery window 7 days; no Ghost Mode; E2EE untouched; AI is Action 17;
lyrics owner-dropped; minimum age 13. Site owners (only they review
recovery): `09e1232f-e1c5-4e4d-bb12-e9a9f95a3c1f`,
`ca4a2221-e712-4962-9d11-5776c4f3e021`.

Rules: additive migrations; RLS on every new table; FKs/unique/status
constraints; SECURITY DEFINER with fixed search_path and minimal grants;
never trust the client; Server Actions return errors as values; one realtime
path per scope (room: useRoomSync; user: the existing personal channel).
Commit after each section; typecheck + lint + tests before moving on.

## Orientation facts (Step 0)
- `room_notifications` exists (room-scoped, recipient RLS, free-text type,
  `read_at`; recipients may UPDATE any column; not in the realtime
  publication). Writers: recovery-decision trigger, permanent conversion.
- User-level realtime: `usePersonalMessageNotifications` owns the single
  per-user channel (`personal_message_notifications_<uid>`), used by
  FloatingDock and Messages. Room-level: `useRoomSync` channels.
- `message_reactions` references the legacy `room_messages` table, not
  `messages` (the table room chat uses), so it cannot back chat reactions.
- `room_has_capability` enforces feature flags (chat/watch/files/study/
  announcements) server-side. Capabilities: manage_members, manage_invites,
  manage_settings, manage_announcements, chat, watch, watch_control, files,
  study.
- MembersTab already has a per-member "more" menu (kick/ban/role/transfer).
- Study timer: `timer_start` Broadcast + snapshot; `study_sessions` rows are
  written on completion (`logStudySession`).
- No scheduled deletion for permanent rooms (§9); join surfaces do not show
  the deletion policy (§9).

## 1. Action 06 — cleanup overlap bug
- [x] (b84f68f) Overlapping cleanup runs: FK 23503 on `room_cleanup_jobs` upsert (room
      already destroyed) is "already destroyed", skipped and not a failure;
      real failures still 207/500.
- [x] (b84f68f) Unit tests: overlap case, real failure case (tests/room-cleanup.test.ts).
- [x] Leave rooms `023cab03…` and `3ffa29d8…` (pending requests) untouched (no data change made).
- [ ] Ledger: Action 06 cron evidence (owner) + fix.

## 2. Site-owner recovery (security-critical) + §9 lifecycle gaps
- [x] (38b1503) `site_owners` table (PK → auth.users), RLS (select own row only, no
      client writes), seeded with the two IDs that exist; fails if neither.
- [x] (38b1503) `is_site_owner(uid)` STABLE SECURITY DEFINER.
- [x] (38b1503) `review_recovery_request`: site owners only; pending; inside window;
      approve → 7-day reopen + reviewed_by/at; reject → requester notified;
      irreversible rooms unrecoverable for everyone.
- [x] (38b1503) Requests: any approved member of the expired recoverable room, one
      pending per user per room, inside the window only (DB + action).
- [x] (38b1503) Pending requests keep the room out of cleanup (unchanged, re-verified).
- [x] (38b1503) Notifications: site owners on a new request; requester on decision.
- [x] (38b1503) `/admin/recovery` (site owners only, server guard → 404): room name,
      expired at, requester, window left, Approve/Reject.
- [x] (38b1503) Room owners/admins see only their own request status.
- [x] (38b1503) §9 permanent rooms: owner schedules deletion (7-day grace), can cancel;
      members notified; cleanup deletes after the grace period.
- [x] (38b1503) §9 deletion policy shown before joining (explore cards, invite/code
      preview, room info).
- [x] (38b1503) Tests: unit; RPC probe (member/admin/owner/anon denied; disposable site
      owner in a rolled-back transaction allowed; double review, after
      window, non-pending).

## 3. Notification system + bell
- [x] (38b1503) Typed notifications (extend `room_notifications`): type CHECK (mention,
      reply, announcement, pdf_shared, timer, recovery_request,
      recovery_decision, access, security, permanent_conversion), actor,
      entity, idempotency key; recipients may update `read_at` only.
- [x] (764bc0a) DND/mute prefs (global + per room), applied server-side in the single
      enqueue function; access/security/recovery never suppressed.
- [x] (764bc0a) Unread count + mark read / mark all read (actions return values).
- [x] (764bc0a) Live delivery over the existing per-user channel (publication add).
- [x] (764bc0a) Bell popover (anchored, ~16px radius, spring-like 180ms enter / 120ms
      exit, stagger, reduced-motion fade, mobile sheet, full a11y, states).
- [ ] Tests: popover logic unit tests; RLS probe; two-account browser test +
      screenshot.

## 4. Action 08 — room messaging
- [x] (bfb9d2e) Edit own messages (edited marker) / delete own (exists, re-verify).
- [x] (bfb9d2e) Replies (reply_to, quoted preview, reply notification).
- [x] (bfb9d2e) Reactions on `messages` (new linked table, toggle, live).
- [x] (bfb9d2e) Mentions (@username of room members only; private notification).
- [x] (bfb9d2e) Pinned messages (manage_announcements; pinned bar; live).
- [x] (bfb9d2e) Announcements (authorized roles only) + member notifications.
- [ ] Member 3-dot actions (server-gated; re-verify).
- [x] (bfb9d2e) DND controls UI (global + per room).
- [x] (bfb9d2e) Unread/read state (per member last read; badge + divider).
- [x] (bfb9d2e) Shared-PDF notification; timer notifications (room owner on start,
      starter on completion).
- [ ] GIFs re-verified with GIPHY_API_KEY.

## 5. Action 09 — adaptive workspace
- [ ] Layout presets (user-scoped), owner-controlled default/lock.
- [ ] Themes/appearance (user preference, CSS variables).
- [ ] Room dashboard/home activity (no empty gaps).
- [ ] Saved panel sizes (user-scoped, re-verify).
- [ ] Mobile rules (narrow-width layout).
- [ ] No remounting of existing stages; disabled features denied by
      server/RLS/realtime (re-verify).

## 6. Action 10 — media metadata
- [ ] Provider-neutral metadata from embedded tags (MP3 ID3, FLAC, MP4/M4A)
      + filename fallback; artwork thumbnail; cached with the media row;
      attribution ("from file tags"/"from file name"); generated fallback art.
- [ ] Subtitles/audio tracks re-verified.
- [ ] PDF-share notification (section 3/4).

## Verification
- [ ] typecheck, lint, all tests, production build, route smoke.
- [ ] Extended two-account RLS probe (every new table/function).
- [ ] Browser walkthrough, desktop and mobile width, every feature.
- [ ] Migrations: rolled-back dry run → `npx supabase db push` → lists match.
- [ ] Ledger evidence per item; final verdict table.
