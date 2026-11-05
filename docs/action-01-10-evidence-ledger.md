# OmniLume Actions 01-10 Evidence Ledger

**Recorded:** 2026-11-04
**Branch / audit evidence baseline:** `feature/action-05-room-controls-ui` at `2f708ee`
**Scope:** Actions 01-10 only. Existing E2EE remains unchanged; no application
Ghost Mode or member-menu "Block from room" option is introduced. The recovered
historical migration source includes already-deployed presence definitions but
was not executed or modified during this audit.

## Evidence conventions

- `Verified` means the named command, browser flow, or database probe was run
  against the current checkout or linked environment.
- `Unverified` is not a pass. It records source that still requires its named
  runtime or security proof.
- Disposable fixtures must use unique `qa-<date>-<random>` names, be confined
  to a dedicated test room, and be cleaned through the normal lifecycle rather
  than by database reset, truncation, or bulk deletion.
- Database changes are ordered, additive migrations only. Apply through the
  linked Supabase workflow, inspect the remote catalog afterwards, and roll
  back with a new compensating migration rather than changing applied history.
- Logs must contain neither credentials, session tokens, private keys, nor
  plaintext E2EE messages. Service-role credentials stay server-only.

## Current implementation inventory

| Area | Authoritative source | Notes |
| --- | --- | --- |
| App routes | `src/app/**/page.tsx`, `src/app/**/route.ts`, `src/proxy.ts` | App Router, Next.js 16.3.3. Dynamic routes are `/room/[id]` and `/profile/[id]`. |
| Identity | `src/utils/supabase/{client,server}.ts`, `src/actions/auth.ts`, `src/app/login`, `src/app/auth/callback` | Singleton browser client and cookie-backed server client; proxy refreshes and gates authenticated paths. |
| Social | `src/actions/profiles.ts`, `src/components/profile/*` | Profiles, follows, friend requests/friendships and posts use Action 04 RPC/RLS boundaries. |
| Rooms/control | `src/actions/{rooms,members,room-controls,recovery}.ts`, `src/components/room/*`, `src/lib/room-lifecycle.ts` | Room page is the room composition root. Control changes use RPCs; invites and restriction states are server/database enforced. |
| Realtime | `RoomRealtimeProvider`, `useRoomSync`, `useRoomPresence` | One shared room-provider path. It owns `sync:`, `sync-control:` and `presence:` subscriptions; private E2EE chat is a separate, non-room channel. |
| Chat/notifications | `RoomChat`, `src/actions/chat.ts`, `src/actions/notifications.ts` | Room chat and personal E2EE chat are separate. |
| Media/storage | `MediaStage`, `FilesTab`, `src/actions/media.ts`, `src/lib/storage.ts` | Private `room_attachments` paths are room-id prefixed and signed URLs are bounded by the active room lifetime. |
| Lifecycle/cleanup | `room-lifecycle.ts`, recovery actions, `api/internal/cleanup-expired-rooms`, `vercel.json` | Recovery/permanence uses RPCs; Vercel schedules daily cleanup. |
| Database source | `supabase/01_schema.sql`, `supabase/migrations/*.sql`, `supabase/POLICIES.md` | Effective policy state must be verified from ordered migration history and live catalogs, not documentation alone. |

## Remote alignment gate

All migration versions reported by `npx supabase migration list --linked` now
have matching local sources. The seven recovered files are byte-identical to
historical commit `3716a74c` and were restored in `5f4ab0b`; none was applied
or repaired. Linked type generation confirms the deployed Action 08-10 tables
and RPC signatures (`message_requests`, `room_files`, snapshots, cleanup jobs,
study notes, PDF annotations, whiteboards, and their RPCs) exist remotely.

The effective catalog remains only partially verified. The Dashboard export
received on 2026-11-04 contains only the script's final `extensions` helper
result set; it proves those helper functions exist but contains no Action 01-10
RLS, grant, trigger, storage, publication, or authorization results. `db dump`/
`inspect` require `SUPABASE_DB_PASSWORD`, while `db diff` additionally requires
Docker or Podman. Retain all Dashboard result sets from
`supabase/audits/action01-10-remote-security-audit.sql` before treating policy,
grant, trigger, storage, or Realtime checks as verified.

The combined script was split into the read-only pack `supabase/audits/action01-10/`
(committed in `fe082ab`): queries `01`-`07` are each a single catalog `SELECT` so a
Dashboard export cannot silently retain only a final helper result set. The pack's
README carries the run instructions, per-query expected configuration, and the
separate two-account authorization checklist. Catalog output from these queries is
still configuration evidence only. The seven result sets were received on
2026-11-04 and are classified in the next section.

## Remote catalog audit results (2026-11-04)

Source: Dashboard SQL Editor exports of queries `01`-`07`, each run separately
by the project administrator. This is **catalog evidence only**. It shows how
the database is configured, not how an authenticated caller is actually
treated. No authorization behavior was probed.

Automated comparison against `supabase/migrations/`:

- All 83 exported function bodies (SECURITY DEFINER functions, storage path
  parsers, Realtime topic parser) are identical, after whitespace and comment
  normalization, to the latest migration that defines each function. There is
  no function drift.
- All 15 exported triggers and all named constraints have a migration source.
  All indexes do too, except `messages_room_id_idx`, which comes from the
  baseline `supabase/01_schema.sql`. No migration trigger or index on an
  audited table is missing from production.
- The `room_attachments` bucket exactly matches the
  `20260924090000` contract: private, 52428800-byte limit, and the same 17 MIME types.

### Seven audit areas

| Area | Result | Evidence |
| --- | --- | --- |
| 01 RLS policies | **FAIL (1 confirmed defect) + PARTIAL** | RLS is enabled on follows, friend_requests, friendships, message_reactions, message_requests, messages, pdf_annotations, posts, private_chats and profiles. The export stopped partway through the `recovery_requests` row, so the RLS state of the remaining 19 tables is UNVERIFIED (their 46 policies are present). Defect D1 is below. The `room_invites` SELECT policy is absent by design: `012` dropped it in favor of `list_room_invite_history`. |
| 02 SECURITY DEFINER functions | **FAIL (1 confirmed defect)** | All 80 functions have a fixed `search_path` (`public` or empty), owner `postgres`, and no `PUBLIC` EXECUTE. Bodies match the migrations. Internal helpers (`room_user_role`, `room_user_is_restricted`, `record_room_control_event`, `seed_room_controls*`, `notify_room_recovery_decision`) are not executable by client roles. Defect D2 is below. |
| 03 Integrity catalog | **PASS (catalog)** | 18 tables, 105 constraints, 48 indexes and 15 triggers. They include the tampering, escalation, lifecycle-reopen, expiration and schedule guards. The only index without a migration source is `messages_room_id_idx`, which is harmless. |
| 04 Storage | **PASS (catalog)** | The bucket is private and its size and MIME limits match. The read, upload and delete policies match `20260923140000`. They bind the room-id path prefix to `room_has_capability` (`files`, `watch` or `watch_control`); legacy paths are read-only. Design note, not a defect: the uploader can still delete their own `files` object after leaving the room (this mirrors `begin_room_file_delete`). |
| 05 Realtime | **PASS (catalog) + UNVERIFIED** | The Broadcast/Presence policies on `realtime.messages` parse topics with `room_realtime_topic_room_id` and require active access plus membership or capability. Presence excludes ghost-mode members, and `presence-privileged` requires `manage_members`. The app opens its room channels with `private: true`. The publication contains friendships, message_requests and private_chats. Two things are UNVERIFIED: whether `messages` and `room_control_events` (also subscribed by the app) are in the publication, and the project's Realtime "Allow public access" setting. |
| 06 Message and Action 08-10 RPCs | **PASS + 1 confirmed hardening defect** | All 23 RPCs are present, executable only by authenticated, postgres and service_role, and identical to the migrations. `message_requests` has RLS, a participant-only SELECT, and no INSERT/UPDATE/DELETE grant to authenticated. Defect D3: authenticated still holds `TRUNCATE`, `TRIGGER`, `REFERENCES` and `MAINTAIN`. |
| 07 Lifecycle and access | **PASS (catalog) + D2/D3** | The 12 lifecycle and authorization functions match the migrations. `room_user_role` requires approved status, an unexpired guest window and no active restriction, so a departed or restricted user loses every `room_has_capability`/`is_approved_room_member` gate. Notification SELECT and UPDATE are scoped to `recipient_id = auth.uid()`, and there are no INSERT or DELETE policies. Table grants show D3 on messages, recovery_requests, room_members, room_messages, room_notifications, room_permanent_requests, rooms and temporary_media. |

### Confirmed findings

| ID | Classification | Finding | Disposition |
| --- | --- | --- | --- |
| D1 | CONFIRMED DEFECT (medium) | **Room chat capability bypass.** `019` rewrote `"Users can insert messages"` on `public.messages` and replaced `011`'s room branch, `room_has_capability(room_id, auth.uid(), 'chat')`, with `room_has_active_access` plus `is_approved_room_member`. Production matches `019`. An approved member whose role lacks `chat`, or who is in a room with chat disabled, can insert room messages with a direct Data API insert that does not return the row (`RoomChat` writes to `messages` from the browser). Reads and updates still require the capability. | Migration `20261104120000` item 1 restores the capability check and leaves the `019` private-chat branch unchanged. |
| D2 | CONFIRMED DEFECT (low) | **Anon EXECUTE drift.** `004` revoked only `PUBLIC`, but Supabase also grants EXECUTE directly to `anon`. As a result, `anon` can execute `is_room_admin_or_owner`, `get_room_for_join`, `review_recovery_request`, `review_permanent_room_request` and `convert_active_room_to_permanent`. The three mutating RPCs reject `auth.uid() IS NULL`. However, `is_room_admin_or_owner` accepts a caller-supplied user id, which gives anon a room-role oracle, and `get_room_for_join` reveals active-room lifecycle data by username or id. No anonymous app path uses any of them. | Migration `20261104120000` item 2 revokes them from `anon`, matching `008`/`013`/`019`. |
| D3 | CONFIRMED DEFECT (low, hardening) | **Residual client table privileges.** `anon` and/or `authenticated` hold `TRUNCATE`, `TRIGGER`, `REFERENCES` and `MAINTAIN` on public tables. `TRUNCATE` is not subject to RLS. None of these privileges is reachable through the Data API, but they contradict the "no direct mutation grants" contract, and `008` already removed them from the Action 04 tables. | Migration `20261104120000` item 3 revokes these four privileges from client roles on every public table. SELECT/INSERT/UPDATE/DELETE grants and policies are unchanged. |
| U1 | UNVERIFIED | RLS state of the 19 tables missing from the truncated 01 export (including rooms, room_members, room_messages, room_notifications, room_files and study_notes), publication membership of `messages`/`room_control_events`, and the Realtime public-access setting. | Run `supabase/audits/action01-10/08-followup-rls-grants-publication.sql`; check the Realtime setting in the Dashboard. |
| U2 | UNVERIFIED | All authorization behavior: former-member denial, owner/admin versus member, notification isolation, unauthorized RPC/storage access, Realtime revocation, and cross-room isolation. | Two-account plan below. |
| X1 | UNRELATED | The `extensions` lint helper mismatch recorded above. | No Action 01-10 change. |
| N1 | Hardening note | SECURITY DEFINER functions pinned to `search_path=public` do not list `pg_temp` last. This is only exploitable from a raw SQL session that can create temporary objects, which the Data API does not provide. | No change. Prefer `search_path=''` for new functions. |

Audit-pack defect found during analysis: query `01` named `room_restrictions`
instead of `room_member_restrictions` and omitted `room_control_events`. Both
are corrected, and query `08` covers them.

### Migration `20261104120000_action03_remote_audit_remediation.sql`

**Status: APPLIED (`supabase db push`; remote history confirmed on 2026-11-05) and VERIFIED; see "Post-deployment verification".** The migration is additive, changes no data,
and leaves function bodies untouched. Before deployment:

1. Run query `08` as a baseline and keep the export.
2. Apply the migration through the linked workflow (`npx supabase db push`)
   after review. Do not edit applied history.
3. Re-run query `08`. Expected results: no `client_grant` rows, none of the five
   D2 functions under `anon_execute`, and `messages_insert` reporting that the
   room branch requires the chat capability.
4. Run the D1 behavior probe: a member with `chat` denied
   (`set_room_role_permission`) gets an RLS error on a direct `messages` insert,
   and a member with `chat` still sends normally.
5. Rollback, if ever needed, is a new compensating migration: re-grant the
   specific privilege, or re-alter the policy to the `019` expression.

Impact: room chat is unchanged for every role holding `chat`, which all roles
do by default (`seed_room_controls`). Members whose `chat` permission or the
room's chat feature is off can no longer post. This already matches what they
can read.

### Two-user security test plan (executed 2026-11-05; results under "Post-deployment verification")

Run these in a disposable staging/preview project, or in a dedicated
`qa-<date>-<random>` room, with two browser profiles: A (owner) and B (second
account). Record only pass/fail and the HTTP/Postgres error code. Never record
tokens, signed URLs or message content.

| # | Scenario | Steps | Expected |
| --- | --- | --- | --- |
| T1 | Member versus former member | A creates a private room and approves B. B loads chat, files, study and watch. B leaves (or A removes B). B repeats every read and calls `get_room_file_download_path`, `list_study_notes` and `get_room_realtime_snapshots`. | Before: success. After: zero rows or an authorization error everywhere, and B's open `sync:`/`presence:` channels stop receiving. |
| T2 | Owner/admin versus ordinary member | B is an approved `member`. B calls `set_room_member_role`, `set_room_role_permission`, `update_room_controls`, `create_room_invite`, `revoke_room_invite`, `review_room_member` and `transfer_room_ownership` on A's room. | Every call raises an authorization error, and a post-check by A shows no state change. |
| T3 | D1 chat capability | A runs `set_room_role_permission(room, 'member', 'chat', false)`. B inserts into `messages` with `room_id` through the Data API with `Prefer: return=minimal`. | Before migration: succeeds (confirms D1). After migration: RLS violation (42501). After A restores `chat`, B sends normally. |
| T4 | Notification isolation | Trigger a recovery-decision notification for A. B selects and updates `room_notifications` filtered by A's notification id. | B gets 0 rows, and its update affects 0 rows. A reads it and marks it read. |
| T5 | Unauthorized RPC calls | B (non-member) calls the A-room RPCs with A's ids: `begin_room_file_delete`, `update_study_note`, `delete_pdf_annotation`, `save_room_whiteboard`, `review_recovery_request`, `accept_message_request`/`reject_message_request`/`cancel_message_request` on requests B is not party to. Also call `is_room_admin_or_owner` with the anon key only. | Authorization error, no state change. The anon call is denied after the migration (confirms D2). |
| T6 | Private storage | A uploads a valid room file. B (non-member) issues a storage download of the object path, `createSignedUrl`, and a `DELETE` on that path. | All denied. A's download still works. |
| T7 | Realtime revocation | B is subscribed to `sync:<room>` and `presence:<room>`. A removes B. A broadcasts. B also tries to subscribe to a new channel. | B receives nothing new after removal, and the new subscription is rejected. |
| T8 | Cross-room isolation | A owns room R1. B owns room R2 and is not in R1. B queries `messages`, `room_messages`, `room_members`, `study_notes` and `temporary_media` with `room_id=R1`, and subscribes to `sync:R1`. | 0 rows and the subscription is rejected. Requests B makes with R2 ids never return R1 data. |

## Post-deployment verification and two-account probes (2026-11-05)

### Deployment and alignment

- `supabase db push` applied `20261104120000`. The user's
  `migration list --linked` capture, and the query 08 export pasted with it,
  were taken **before** the push: that list showed an empty remote column, and
  the export still showed all of D1-D3. Re-run on 2026-11-05 through the linked
  CLI, `npx supabase migration list --linked` reports
  `20261104120000 | 20261104120000`, so local and remote history match.
- Query 08 was re-run through `npx supabase db query --linked` (read-only)
  after the push. Its results are the deployed-state evidence below.

### D1-D3 verification

| Fix | Catalog (query 08, post-push) | Behavior (real API calls) | Result |
| --- | --- | --- | --- |
| D1 chat capability | `messages_insert`: room branch requires the chat capability | Member insert without the `chat` permission: `42501`. Chat feature off: member `42501` and owner `42501`. Permission or feature restored: inserts succeed. Owner and member chat works normally. | **PASS** |
| D2 anon EXECUTE | None of the five functions is listed under `anon_execute` | Anon key RPC calls to all five return `42501` (privilege denial, not a function-body error) | **PASS** |
| D3 client table privileges | **0** `client_grant` rows (the pre-push baseline had 161) | All member/owner SELECT, INSERT and UPDATE paths exercised by T1-T8 still work | **PASS** |
| Remaining `anon_execute` rows | 14 trigger functions (callable only as triggers) and 2 IMMUTABLE path parsers | Not applicable | UNRELATED. Accepted, and allow-listed in the contract test. |
| RLS on 30 Action tables | `rls=true` on all 30; the 19 previously unverified tables are now confirmed | Not applicable | **PASS** (closes U1, together with the next row) |
| Publication | `messages` and `room_control_events` present | Not applicable | **PASS** |

### Two-account probe results

Method: `node scripts/security/authorization-probe.mjs full`, run three times
on 2026-11-05 with two disposable accounts supplied by the user (separate
sessions). It made real Data API, Storage and Realtime calls with the anon key
and each account's own session. The fixtures were new private
`qa-2026-11-04-*` rooms (irreversible, 2-hour expiry) plus one recoverable
15-second room per run. Last run: 88 pass, 4 fail, 0 blocked. Server actions
were not driven through a browser. The probes test the database, storage and
realtime boundaries that those actions rely on, and UI hiding was not counted
as evidence.

| Test | Result | Evidence |
| --- | --- | --- |
| T1 Member vs former member | **PASS** | While a member, B reads messages, study notes and signed media. After the owner kicks B: 0 messages, insert `42501`, no signed URL, 0 temporary media, and `list_study_notes`/`get_room_realtime_snapshots` raise. |
| T2 Role boundaries | **PASS** | A member's calls to `set_room_member_role`, `set_room_role_permission`, `update_room_controls`, `create_room_invite`, `review_room_member` (kick owner), `transfer_room_ownership` and `create_room_announcement` all raise. Direct role escalation and room update change 0 rows, and a direct permission insert is rejected with `42501`. A post-check confirms the roles are unchanged. Owner promote/demote works. An admin can create and revoke invites but cannot kick or replace the owner. |
| T3 Chat permission bypass | **PASS** | See D1. |
| T4 Notification isolation | **FAIL**: notifications cannot be created (D5), so isolation is UNVERIFIED | `review_recovery_request` fails with `42702 column reference "notification_type" is ambiguous` (reproduced 3 times). No notification is produced to test against. The catalog policies remain recipient-scoped. |
| T5 Unauthorized function calls | **PASS** (message-request RPCs not exercised) | Anon calls to the five functions return `42501`. Anon reads return 0 rows or `42501`, and anon inserts return `42501`. Non-member calls to `update_study_note`, `delete_study_note`, `save_room_whiteboard` and `begin_room_file_delete`, and an unrelated user's `review_recovery_request`, all raise. Message-request accept/reject/cancel needs a follow-relationship fixture and was not run. |
| T6 Private storage | **PASS** for access control; **FAIL** for owner delete (D6) | A non-member's signed URL, download, upload, path traversal from its own room, and delete are all refused, and the object stays intact. A member (watch) gets a signed URL. A member without `watch_control` cannot upload or delete. An anon list returns nothing. However, the owner's delete fails: `permission denied for table room_files` (D6). |
| T7 Realtime revocation | **FAIL** (D7) | A member receives broadcasts. Anon and non-member joins return `CHANNEL_ERROR`, and a fresh re-join after removal returns `CHANNEL_ERROR`. However, **the existing subscription keeps receiving after removal** (`received=[1,2]`, reproduced 3 times). It stops only once the client pushes a refreshed token. |
| T8 Cross-room isolation | **PASS** | B, who owns R2 and is not in R1, reads 0 R1 messages, members, temporary media, room messages, notifications and rooms. `list_study_notes`, `get_room_realtime_snapshots`, `get_room_whiteboard` and `get_room_member_identities` all raise, and `sync:`/`presence:` joins return `CHANNEL_ERROR`. Positive control: B reads its own R2. |

### Defects found by the probes

| ID | Classification | Finding | Disposition |
| --- | --- | --- | --- |
| F1 | CONFIRMED DEFECT (high, functional, fails closed) | **Watch media, subtitles and URL-cast history have been broken since `20260923140000`.** The app still inserted into `temporary_media` directly (that grant was revoked) and uploaded to `<room>/temp-*` and `<room>/sub-*` paths. The storage policy treats those as read-only `legacy`. Production evidence: `authenticated` has no `INSERT`, and there are 0 `temporary_media` rows and 0 objects since Action 09. Probe: the legacy upload is `AccessDenied` and the direct insert `42501`. | **FIXED in app code** (no migration). Uploads now use `<room>/media/<uuid>.<ext>` and `<room>/subtitles/<uuid>.<ext>`, send contract MIME types, and register through `register_temporary_media`. Signed URLs check `watch` for media and subtitles, mirroring the storage policy. The probe confirms the new call shape is accepted in production. Regression tests are in `tests/room-file-validation.test.ts` and `tests/security-migration-contract.test.ts`. |
| D5 | CONFIRMED DEFECT (high, functional) | **Every recovery approval and rejection fails.** `notify_room_recovery_decision` (`20260923120000`) declares a variable `notification_type` that clashes with its `ON CONFLICT` column, which raises `42702` and rolls back the review. | Migration `20261105090000` item 1 (**prepared, NOT applied; needs review/approval**). Regression test: "no PL/pgSQL variable shadows an ON CONFLICT target column". |
| D6 | CONFIRMED DEFECT (low, functional, fails closed) | **No authenticated user can delete any `room_attachments` object.** The DELETE policy's `files` branch reads `room_files`, which clients cannot select. No current UI deletes objects; the cleanup job uses the service role. | Migration `20261105090000` item 2 (**prepared, NOT applied**) moves the check into the `room_file_owned_by_caller` SECURITY DEFINER helper, with the same policy meaning. Regression test: "no current policy reads a table that client roles cannot select". |
| D7 | CONFIRMED DEFECT (medium, security) | **A removed member's open Realtime subscription kept receiving room data** (chat text, signed URLs, titles) until token refresh or expiry. | **FIXED in code 2026-11-05, not yet deployed.** Chat moved to RLS-checked Postgres Changes; Broadcast now carries only ids and state through an allow-list contract; media resolves through `resolveRoomMedia`. Verified with a hostile non-refreshing client: no content, URLs or chat rows after removal. The metadata residual is accepted (see "D5/D6 review and D7 Realtime remediation"). |

Probe fixtures: rooms R1/R2/R3 from each run expire on their own and are
removed by the cleanup job. Each run left one probe media object in its R1,
because the owner cannot delete it (D6). The cleanup job removes it when its
`temporary_media` row expires.

### Migration `20261105090000_action06_09_recovery_notice_and_storage_delete_repair.sql`

**Status: prepared, NOT applied. It requires review and approval before
`supabase db push`.** It renames the two trigger variables (the body is
otherwise identical, and grants and the trigger binding are kept), adds
`room_file_owned_by_caller` (SECURITY DEFINER, `search_path=''`, executable by
authenticated and service_role only, not anon), and alters only the USING
expression of the storage DELETE policy. After applying it, re-run
`node scripts/security/authorization-probe.mjs full`. T4 should then pass
end-to-end, and the "owner deletes the probe media object" check should pass.

## D5/D6 review and D7 Realtime remediation (2026-11-05)

### Part 1: review of `20261105090000` (no deployment)

The prepared SQL was reviewed by machine against its sources and the deployed
catalog. **No defect was found, and the file is unchanged.**

| Check | Result |
| --- | --- |
| D5 trigger header (`RETURNS trigger`, `plpgsql`, `SECURITY DEFINER`, `search_path=''`) | Identical to `20260923120000` |
| D5 body | Identical after reverting only the two variable renames. The declared variables (`v_notification_type`, `v_notification_message`) no longer collide with the `ON CONFLICT (room_id, recipient_id, notification_type)` columns. |
| D5 grants and trigger binding | `CREATE OR REPLACE` keeps the ACL (service_role only) and the trigger's function oid. Production confirms the trigger is bound `AFTER UPDATE OF status`. |
| D5 latent-failure check | The production unique index `room_notifications_unique_conversion (room_id, recipient_id, notification_type)` is **not partial**, so `ON CONFLICT` has a matching arbiter. The type check only requires a non-empty value. Every `NOT NULL` column is supplied. No second failure hides behind 42702. |
| D6 policy | Identical to `20260923140000` after substituting `room_file_owned_by_caller(bucket_id, name)` for the `EXISTS (... public.room_files ...)` subquery. The room-prefix check, path kind, admin/owner branch and `watch_control` media branch are unchanged. |
| D6 helper | `STABLE SECURITY DEFINER`, `search_path=''`, an exact `storage_bucket` + `object_path` + `owner_id = auth.uid()` match with `deleted_at IS NULL`, `auth.uid() IS NOT NULL` required. `REVOKE ALL FROM PUBLIC, anon`, and `GRANT EXECUTE TO authenticated, service_role`. Because it is bound to `auth.uid()`, it reveals only the caller's own ownership. |
| Execution | The SQL was not executed (no local Postgres or Docker, and no production DDL without approval). |

**Decision for the owner (not decided here):** today an uploader can delete
their own `files` object after leaving the room, and `begin_room_file_delete`
behaves the same way. Should D6 also require current room membership? If yes,
the storage DELETE policy's owner branch **and** `begin_room_file_delete` must
both add `public.is_approved_room_member(room_id, auth.uid())` in one new
migration. No UI deletes room files today, so there is no user-visible impact
either way.

**New defect D8 (found while redesigning Watch for D7):**
`set_temporary_media_subtitle` (`20260923140000:417`) validates paths with
`\\.(vtt|srt)# OmniLume Actions 01-10 Evidence Ledger

**Recorded:** 2026-11-04
**Branch / audit evidence baseline:** `feature/action-05-room-controls-ui` at `2f708ee`
**Scope:** Actions 01-10 only. Existing E2EE remains unchanged; no application
Ghost Mode or member-menu "Block from room" option is introduced. The recovered
historical migration source includes already-deployed presence definitions but
was not executed or modified during this audit.

## Evidence conventions

- `Verified` means the named command, browser flow, or database probe was run
  against the current checkout or linked environment.
- `Unverified` is not a pass. It records source that still requires its named
  runtime or security proof.
- Disposable fixtures must use unique `qa-<date>-<random>` names, be confined
  to a dedicated test room, and be cleaned through the normal lifecycle rather
  than by database reset, truncation, or bulk deletion.
- Database changes are ordered, additive migrations only. Apply through the
  linked Supabase workflow, inspect the remote catalog afterwards, and roll
  back with a new compensating migration rather than changing applied history.
- Logs must contain neither credentials, session tokens, private keys, nor
  plaintext E2EE messages. Service-role credentials stay server-only.

## Current implementation inventory

| Area | Authoritative source | Notes |
| --- | --- | --- |
| App routes | `src/app/**/page.tsx`, `src/app/**/route.ts`, `src/proxy.ts` | App Router, Next.js 16.3.3. Dynamic routes are `/room/[id]` and `/profile/[id]`. |
| Identity | `src/utils/supabase/{client,server}.ts`, `src/actions/auth.ts`, `src/app/login`, `src/app/auth/callback` | Singleton browser client and cookie-backed server client; proxy refreshes and gates authenticated paths. |
| Social | `src/actions/profiles.ts`, `src/components/profile/*` | Profiles, follows, friend requests/friendships and posts use Action 04 RPC/RLS boundaries. |
| Rooms/control | `src/actions/{rooms,members,room-controls,recovery}.ts`, `src/components/room/*`, `src/lib/room-lifecycle.ts` | Room page is the room composition root. Control changes use RPCs; invites and restriction states are server/database enforced. |
| Realtime | `RoomRealtimeProvider`, `useRoomSync`, `useRoomPresence` | One shared room-provider path. It owns `sync:`, `sync-control:` and `presence:` subscriptions; private E2EE chat is a separate, non-room channel. |
| Chat/notifications | `RoomChat`, `src/actions/chat.ts`, `src/actions/notifications.ts` | Room chat and personal E2EE chat are separate. |
| Media/storage | `MediaStage`, `FilesTab`, `src/actions/media.ts`, `src/lib/storage.ts` | Private `room_attachments` paths are room-id prefixed and signed URLs are bounded by the active room lifetime. |
| Lifecycle/cleanup | `room-lifecycle.ts`, recovery actions, `api/internal/cleanup-expired-rooms`, `vercel.json` | Recovery/permanence uses RPCs; Vercel schedules daily cleanup. |
| Database source | `supabase/01_schema.sql`, `supabase/migrations/*.sql`, `supabase/POLICIES.md` | Effective policy state must be verified from ordered migration history and live catalogs, not documentation alone. |

## Remote alignment gate

All migration versions reported by `npx supabase migration list --linked` now
have matching local sources. The seven recovered files are byte-identical to
historical commit `3716a74c` and were restored in `5f4ab0b`; none was applied
or repaired. Linked type generation confirms the deployed Action 08-10 tables
and RPC signatures (`message_requests`, `room_files`, snapshots, cleanup jobs,
study notes, PDF annotations, whiteboards, and their RPCs) exist remotely.

The effective catalog remains only partially verified. The Dashboard export
received on 2026-11-04 contains only the script's final `extensions` helper
result set; it proves those helper functions exist but contains no Action 01-10
RLS, grant, trigger, storage, publication, or authorization results. `db dump`/
`inspect` require `SUPABASE_DB_PASSWORD`, while `db diff` additionally requires
Docker or Podman. Retain all Dashboard result sets from
`supabase/audits/action01-10-remote-security-audit.sql` before treating policy,
grant, trigger, storage, or Realtime checks as verified.

The combined script was split into the read-only pack `supabase/audits/action01-10/`
(committed in `fe082ab`): queries `01`-`07` are each a single catalog `SELECT` so a
Dashboard export cannot silently retain only a final helper result set. The pack's
README carries the run instructions, per-query expected configuration, and the
separate two-account authorization checklist. Catalog output from these queries is
still configuration evidence only. The seven result sets were received on
2026-11-04 and are classified in the next section.

## Remote catalog audit results (2026-11-04)

Source: Dashboard SQL Editor exports of queries `01`-`07`, each run separately
by the project administrator. This is **catalog evidence only**. It shows how
the database is configured, not how an authenticated caller is actually
treated. No authorization behavior was probed.

Automated comparison against `supabase/migrations/`:

- All 83 exported function bodies (SECURITY DEFINER functions, storage path
  parsers, Realtime topic parser) are identical, after whitespace and comment
  normalization, to the latest migration that defines each function. There is
  no function drift.
- All 15 exported triggers and all named constraints have a migration source.
  All indexes do too, except `messages_room_id_idx`, which comes from the
  baseline `supabase/01_schema.sql`. No migration trigger or index on an
  audited table is missing from production.
- The `room_attachments` bucket exactly matches the
  `20260924090000` contract: private, 52428800-byte limit, and the same 17 MIME types.

### Seven audit areas

| Area | Result | Evidence |
| --- | --- | --- |
| 01 RLS policies | **FAIL (1 confirmed defect) + PARTIAL** | RLS is enabled on follows, friend_requests, friendships, message_reactions, message_requests, messages, pdf_annotations, posts, private_chats and profiles. The export stopped partway through the `recovery_requests` row, so the RLS state of the remaining 19 tables is UNVERIFIED (their 46 policies are present). Defect D1 is below. The `room_invites` SELECT policy is absent by design: `012` dropped it in favor of `list_room_invite_history`. |
| 02 SECURITY DEFINER functions | **FAIL (1 confirmed defect)** | All 80 functions have a fixed `search_path` (`public` or empty), owner `postgres`, and no `PUBLIC` EXECUTE. Bodies match the migrations. Internal helpers (`room_user_role`, `room_user_is_restricted`, `record_room_control_event`, `seed_room_controls*`, `notify_room_recovery_decision`) are not executable by client roles. Defect D2 is below. |
| 03 Integrity catalog | **PASS (catalog)** | 18 tables, 105 constraints, 48 indexes and 15 triggers. They include the tampering, escalation, lifecycle-reopen, expiration and schedule guards. The only index without a migration source is `messages_room_id_idx`, which is harmless. |
| 04 Storage | **PASS (catalog)** | The bucket is private and its size and MIME limits match. The read, upload and delete policies match `20260923140000`. They bind the room-id path prefix to `room_has_capability` (`files`, `watch` or `watch_control`); legacy paths are read-only. Design note, not a defect: the uploader can still delete their own `files` object after leaving the room (this mirrors `begin_room_file_delete`). |
| 05 Realtime | **PASS (catalog) + UNVERIFIED** | The Broadcast/Presence policies on `realtime.messages` parse topics with `room_realtime_topic_room_id` and require active access plus membership or capability. Presence excludes ghost-mode members, and `presence-privileged` requires `manage_members`. The app opens its room channels with `private: true`. The publication contains friendships, message_requests and private_chats. Two things are UNVERIFIED: whether `messages` and `room_control_events` (also subscribed by the app) are in the publication, and the project's Realtime "Allow public access" setting. |
| 06 Message and Action 08-10 RPCs | **PASS + 1 confirmed hardening defect** | All 23 RPCs are present, executable only by authenticated, postgres and service_role, and identical to the migrations. `message_requests` has RLS, a participant-only SELECT, and no INSERT/UPDATE/DELETE grant to authenticated. Defect D3: authenticated still holds `TRUNCATE`, `TRIGGER`, `REFERENCES` and `MAINTAIN`. |
| 07 Lifecycle and access | **PASS (catalog) + D2/D3** | The 12 lifecycle and authorization functions match the migrations. `room_user_role` requires approved status, an unexpired guest window and no active restriction, so a departed or restricted user loses every `room_has_capability`/`is_approved_room_member` gate. Notification SELECT and UPDATE are scoped to `recipient_id = auth.uid()`, and there are no INSERT or DELETE policies. Table grants show D3 on messages, recovery_requests, room_members, room_messages, room_notifications, room_permanent_requests, rooms and temporary_media. |

### Confirmed findings

| ID | Classification | Finding | Disposition |
| --- | --- | --- | --- |
| D1 | CONFIRMED DEFECT (medium) | **Room chat capability bypass.** `019` rewrote `"Users can insert messages"` on `public.messages` and replaced `011`'s room branch, `room_has_capability(room_id, auth.uid(), 'chat')`, with `room_has_active_access` plus `is_approved_room_member`. Production matches `019`. An approved member whose role lacks `chat`, or who is in a room with chat disabled, can insert room messages with a direct Data API insert that does not return the row (`RoomChat` writes to `messages` from the browser). Reads and updates still require the capability. | Migration `20261104120000` item 1 restores the capability check and leaves the `019` private-chat branch unchanged. |
| D2 | CONFIRMED DEFECT (low) | **Anon EXECUTE drift.** `004` revoked only `PUBLIC`, but Supabase also grants EXECUTE directly to `anon`. As a result, `anon` can execute `is_room_admin_or_owner`, `get_room_for_join`, `review_recovery_request`, `review_permanent_room_request` and `convert_active_room_to_permanent`. The three mutating RPCs reject `auth.uid() IS NULL`. However, `is_room_admin_or_owner` accepts a caller-supplied user id, which gives anon a room-role oracle, and `get_room_for_join` reveals active-room lifecycle data by username or id. No anonymous app path uses any of them. | Migration `20261104120000` item 2 revokes them from `anon`, matching `008`/`013`/`019`. |
| D3 | CONFIRMED DEFECT (low, hardening) | **Residual client table privileges.** `anon` and/or `authenticated` hold `TRUNCATE`, `TRIGGER`, `REFERENCES` and `MAINTAIN` on public tables. `TRUNCATE` is not subject to RLS. None of these privileges is reachable through the Data API, but they contradict the "no direct mutation grants" contract, and `008` already removed them from the Action 04 tables. | Migration `20261104120000` item 3 revokes these four privileges from client roles on every public table. SELECT/INSERT/UPDATE/DELETE grants and policies are unchanged. |
| U1 | UNVERIFIED | RLS state of the 19 tables missing from the truncated 01 export (including rooms, room_members, room_messages, room_notifications, room_files and study_notes), publication membership of `messages`/`room_control_events`, and the Realtime public-access setting. | Run `supabase/audits/action01-10/08-followup-rls-grants-publication.sql`; check the Realtime setting in the Dashboard. |
| U2 | UNVERIFIED | All authorization behavior: former-member denial, owner/admin versus member, notification isolation, unauthorized RPC/storage access, Realtime revocation, and cross-room isolation. | Two-account plan below. |
| X1 | UNRELATED | The `extensions` lint helper mismatch recorded above. | No Action 01-10 change. |
| N1 | Hardening note | SECURITY DEFINER functions pinned to `search_path=public` do not list `pg_temp` last. This is only exploitable from a raw SQL session that can create temporary objects, which the Data API does not provide. | No change. Prefer `search_path=''` for new functions. |

Audit-pack defect found during analysis: query `01` named `room_restrictions`
instead of `room_member_restrictions` and omitted `room_control_events`. Both
are corrected, and query `08` covers them.

### Migration `20261104120000_action03_remote_audit_remediation.sql`

**Status: APPLIED (`supabase db push`; remote history confirmed on 2026-11-05) and VERIFIED; see "Post-deployment verification".** The migration is additive, changes no data,
and leaves function bodies untouched. Before deployment:

1. Run query `08` as a baseline and keep the export.
2. Apply the migration through the linked workflow (`npx supabase db push`)
   after review. Do not edit applied history.
3. Re-run query `08`. Expected results: no `client_grant` rows, none of the five
   D2 functions under `anon_execute`, and `messages_insert` reporting that the
   room branch requires the chat capability.
4. Run the D1 behavior probe: a member with `chat` denied
   (`set_room_role_permission`) gets an RLS error on a direct `messages` insert,
   and a member with `chat` still sends normally.
5. Rollback, if ever needed, is a new compensating migration: re-grant the
   specific privilege, or re-alter the policy to the `019` expression.

Impact: room chat is unchanged for every role holding `chat`, which all roles
do by default (`seed_room_controls`). Members whose `chat` permission or the
room's chat feature is off can no longer post. This already matches what they
can read.

### Two-user security test plan (executed 2026-11-05; results under "Post-deployment verification")

Run these in a disposable staging/preview project, or in a dedicated
`qa-<date>-<random>` room, with two browser profiles: A (owner) and B (second
account). Record only pass/fail and the HTTP/Postgres error code. Never record
tokens, signed URLs or message content.

| # | Scenario | Steps | Expected |
| --- | --- | --- | --- |
| T1 | Member versus former member | A creates a private room and approves B. B loads chat, files, study and watch. B leaves (or A removes B). B repeats every read and calls `get_room_file_download_path`, `list_study_notes` and `get_room_realtime_snapshots`. | Before: success. After: zero rows or an authorization error everywhere, and B's open `sync:`/`presence:` channels stop receiving. |
| T2 | Owner/admin versus ordinary member | B is an approved `member`. B calls `set_room_member_role`, `set_room_role_permission`, `update_room_controls`, `create_room_invite`, `revoke_room_invite`, `review_room_member` and `transfer_room_ownership` on A's room. | Every call raises an authorization error, and a post-check by A shows no state change. |
| T3 | D1 chat capability | A runs `set_room_role_permission(room, 'member', 'chat', false)`. B inserts into `messages` with `room_id` through the Data API with `Prefer: return=minimal`. | Before migration: succeeds (confirms D1). After migration: RLS violation (42501). After A restores `chat`, B sends normally. |
| T4 | Notification isolation | Trigger a recovery-decision notification for A. B selects and updates `room_notifications` filtered by A's notification id. | B gets 0 rows, and its update affects 0 rows. A reads it and marks it read. |
| T5 | Unauthorized RPC calls | B (non-member) calls the A-room RPCs with A's ids: `begin_room_file_delete`, `update_study_note`, `delete_pdf_annotation`, `save_room_whiteboard`, `review_recovery_request`, `accept_message_request`/`reject_message_request`/`cancel_message_request` on requests B is not party to. Also call `is_room_admin_or_owner` with the anon key only. | Authorization error, no state change. The anon call is denied after the migration (confirms D2). |
| T6 | Private storage | A uploads a valid room file. B (non-member) issues a storage download of the object path, `createSignedUrl`, and a `DELETE` on that path. | All denied. A's download still works. |
| T7 | Realtime revocation | B is subscribed to `sync:<room>` and `presence:<room>`. A removes B. A broadcasts. B also tries to subscribe to a new channel. | B receives nothing new after removal, and the new subscription is rejected. |
| T8 | Cross-room isolation | A owns room R1. B owns room R2 and is not in R1. B queries `messages`, `room_messages`, `room_members`, `study_notes` and `temporary_media` with `room_id=R1`, and subscribes to `sync:R1`. | 0 rows and the subscription is rejected. Requests B makes with R2 ids never return R1 data. |

## Post-deployment verification and two-account probes (2026-11-05)

### Deployment and alignment

- `supabase db push` applied `20261104120000`. The user's
  `migration list --linked` capture, and the query 08 export pasted with it,
  were taken **before** the push: that list showed an empty remote column, and
  the export still showed all of D1-D3. Re-run on 2026-11-05 through the linked
  CLI, `npx supabase migration list --linked` reports
  `20261104120000 | 20261104120000`, so local and remote history match.
- Query 08 was re-run through `npx supabase db query --linked` (read-only)
  after the push. Its results are the deployed-state evidence below.

### D1-D3 verification

| Fix | Catalog (query 08, post-push) | Behavior (real API calls) | Result |
| --- | --- | --- | --- |
| D1 chat capability | `messages_insert`: room branch requires the chat capability | Member insert without the `chat` permission: `42501`. Chat feature off: member `42501` and owner `42501`. Permission or feature restored: inserts succeed. Owner and member chat works normally. | **PASS** |
| D2 anon EXECUTE | None of the five functions is listed under `anon_execute` | Anon key RPC calls to all five return `42501` (privilege denial, not a function-body error) | **PASS** |
| D3 client table privileges | **0** `client_grant` rows (the pre-push baseline had 161) | All member/owner SELECT, INSERT and UPDATE paths exercised by T1-T8 still work | **PASS** |
| Remaining `anon_execute` rows | 14 trigger functions (callable only as triggers) and 2 IMMUTABLE path parsers | Not applicable | UNRELATED. Accepted, and allow-listed in the contract test. |
| RLS on 30 Action tables | `rls=true` on all 30; the 19 previously unverified tables are now confirmed | Not applicable | **PASS** (closes U1, together with the next row) |
| Publication | `messages` and `room_control_events` present | Not applicable | **PASS** |

### Two-account probe results

Method: `node scripts/security/authorization-probe.mjs full`, run three times
on 2026-11-05 with two disposable accounts supplied by the user (separate
sessions). It made real Data API, Storage and Realtime calls with the anon key
and each account's own session. The fixtures were new private
`qa-2026-11-04-*` rooms (irreversible, 2-hour expiry) plus one recoverable
15-second room per run. Last run: 88 pass, 4 fail, 0 blocked. Server actions
were not driven through a browser. The probes test the database, storage and
realtime boundaries that those actions rely on, and UI hiding was not counted
as evidence.

| Test | Result | Evidence |
| --- | --- | --- |
| T1 Member vs former member | **PASS** | While a member, B reads messages, study notes and signed media. After the owner kicks B: 0 messages, insert `42501`, no signed URL, 0 temporary media, and `list_study_notes`/`get_room_realtime_snapshots` raise. |
| T2 Role boundaries | **PASS** | A member's calls to `set_room_member_role`, `set_room_role_permission`, `update_room_controls`, `create_room_invite`, `review_room_member` (kick owner), `transfer_room_ownership` and `create_room_announcement` all raise. Direct role escalation and room update change 0 rows, and a direct permission insert is rejected with `42501`. A post-check confirms the roles are unchanged. Owner promote/demote works. An admin can create and revoke invites but cannot kick or replace the owner. |
| T3 Chat permission bypass | **PASS** | See D1. |
| T4 Notification isolation | **FAIL**: notifications cannot be created (D5), so isolation is UNVERIFIED | `review_recovery_request` fails with `42702 column reference "notification_type" is ambiguous` (reproduced 3 times). No notification is produced to test against. The catalog policies remain recipient-scoped. |
| T5 Unauthorized function calls | **PASS** (message-request RPCs not exercised) | Anon calls to the five functions return `42501`. Anon reads return 0 rows or `42501`, and anon inserts return `42501`. Non-member calls to `update_study_note`, `delete_study_note`, `save_room_whiteboard` and `begin_room_file_delete`, and an unrelated user's `review_recovery_request`, all raise. Message-request accept/reject/cancel needs a follow-relationship fixture and was not run. |
| T6 Private storage | **PASS** for access control; **FAIL** for owner delete (D6) | A non-member's signed URL, download, upload, path traversal from its own room, and delete are all refused, and the object stays intact. A member (watch) gets a signed URL. A member without `watch_control` cannot upload or delete. An anon list returns nothing. However, the owner's delete fails: `permission denied for table room_files` (D6). |
| T7 Realtime revocation | **FAIL** (D7) | A member receives broadcasts. Anon and non-member joins return `CHANNEL_ERROR`, and a fresh re-join after removal returns `CHANNEL_ERROR`. However, **the existing subscription keeps receiving after removal** (`received=[1,2]`, reproduced 3 times). It stops only once the client pushes a refreshed token. |
| T8 Cross-room isolation | **PASS** | B, who owns R2 and is not in R1, reads 0 R1 messages, members, temporary media, room messages, notifications and rooms. `list_study_notes`, `get_room_realtime_snapshots`, `get_room_whiteboard` and `get_room_member_identities` all raise, and `sync:`/`presence:` joins return `CHANNEL_ERROR`. Positive control: B reads its own R2. |

### Defects found by the probes

| ID | Classification | Finding | Disposition |
| --- | --- | --- | --- |
| F1 | CONFIRMED DEFECT (high, functional, fails closed) | **Watch media, subtitles and URL-cast history have been broken since `20260923140000`.** The app still inserted into `temporary_media` directly (that grant was revoked) and uploaded to `<room>/temp-*` and `<room>/sub-*` paths. The storage policy treats those as read-only `legacy`. Production evidence: `authenticated` has no `INSERT`, and there are 0 `temporary_media` rows and 0 objects since Action 09. Probe: the legacy upload is `AccessDenied` and the direct insert `42501`. | **FIXED in app code** (no migration). Uploads now use `<room>/media/<uuid>.<ext>` and `<room>/subtitles/<uuid>.<ext>`, send contract MIME types, and register through `register_temporary_media`. Signed URLs check `watch` for media and subtitles, mirroring the storage policy. The probe confirms the new call shape is accepted in production. Regression tests are in `tests/room-file-validation.test.ts` and `tests/security-migration-contract.test.ts`. |
| D5 | CONFIRMED DEFECT (high, functional) | **Every recovery approval and rejection fails.** `notify_room_recovery_decision` (`20260923120000`) declares a variable `notification_type` that clashes with its `ON CONFLICT` column, which raises `42702` and rolls back the review. | Migration `20261105090000` item 1 (**prepared, NOT applied; needs review/approval**). Regression test: "no PL/pgSQL variable shadows an ON CONFLICT target column". |
| D6 | CONFIRMED DEFECT (low, functional, fails closed) | **No authenticated user can delete any `room_attachments` object.** The DELETE policy's `files` branch reads `room_files`, which clients cannot select. No current UI deletes objects; the cleanup job uses the service role. | Migration `20261105090000` item 2 (**prepared, NOT applied**) moves the check into the `room_file_owned_by_caller` SECURITY DEFINER helper, with the same policy meaning. Regression test: "no current policy reads a table that client roles cannot select". |
| D7 | CONFIRMED DEFECT (medium, security) | **A removed member's open Realtime subscription keeps receiving.** Supabase Realtime evaluates private-channel policies at join time and re-checks only when the client sends a new token. A former member that keeps its connection and does not refresh therefore receives `room_message` broadcasts (full message content) and `cast`/`subtitle_upload` events (signed URLs, valid up to 1 hour) until its JWT expires. New joins are denied. | **Not fixed. Needs a design decision.** Options: (a) shorten the Auth JWT expiry to bound the window (Dashboard setting); (b) stop sending content and signed URLs over broadcast, sending ids instead that clients re-fetch through RLS and `getSignedStorageUrl`; (c) per-membership topic epochs that rotate on removal (needs a migration). Recommended: (a) now, plus (b). Whether an expired JWT closes the channel is UNVERIFIED (it would take 1 hour). |

Probe fixtures: rooms R1/R2/R3 from each run expire on their own and are
removed by the cleanup job. Each run left one probe media object in its R1,
because the owner cannot delete it (D6). The cleanup job removes it when its
`temporary_media` row expires.

### Migration `20261105090000_action06_09_recovery_notice_and_storage_delete_repair.sql`

**Status: prepared, NOT applied. It requires review and approval before
`supabase db push`.** It renames the two trigger variables (the body is
otherwise identical, and grants and the trigger binding are kept), adds
`room_file_owned_by_caller` (SECURITY DEFINER, `search_path=''`, executable by
authenticated and service_role only, not anon), and alters only the USING
expression of the storage DELETE policy. After applying it, re-run
`node scripts/security/authorization-probe.mjs full`. T4 should then pass
end-to-end, and the "owner deletes the probe media object" check should pass.

. In a `$` body that is a regex for a literal backslash, so it
rejects every valid subtitle path. Verified read-only in production: a valid
path is `false`, and the deployed body contains the doubled backslash.
`20260924093000` fixed the same bug in the two registration RPCs but missed
this one. Fix: `20261105100000_action09_subtitle_association_regex_repair.sql`
(**prepared, NOT applied**), which is identical to the source except `\\.` →
`\.`. Read-only evaluation of the corrected regex in production: valid
`.vtt`/`.SRT` paths are accepted; non-dot, `..` traversal and other-room paths
are rejected.

**Post-apply verification:** `supabase/audits/action01-10/09-d5-d6-post-apply.sql`
(read-only, 11 rows, all must be `ok`). It was run before applying on
2026-11-05: the 6 repair rows report `FAIL` and the 5 invariant rows report
`ok`, as expected. After `supabase db push`, re-run it, then
`node scripts/security/authorization-probe.mjs full`. T4 and
"owner (watch_control) deletes the probe media object" must then pass.

Deployment order: apply `20261105090000` and `20261105100000`, verify with
query 09, then deploy the app. Subtitle attachment depends on D8.

### Part 2: D7 Realtime inventory (before the change)

| Path | Channel / transport | Publisher → subscribers | Payload | Sensitive | Protected replacement |
| --- | --- | --- | --- | --- | --- |
| `room_message` | `sync:` Broadcast | RoomChat sender → all joined | Full message row (`content`) | **Yes** | Postgres Changes INSERT on `messages` (RLS `chat`) |
| `room_message_update` | `sync:` Broadcast | RoomChat delete → all | id, `content`, `is_deleted` | **Yes** | Postgres Changes UPDATE (soft-delete) |
| `cast` | `sync-control:` Broadcast | MediaStage/FilesTab → all | `url` (signed or external), `title`, mediaId, playback | **Yes** | mediaId + `resolveRoomMedia` (RLS `watch` + server capability) |
| `play`/`pause`/`seek`/`mute` | `sync-control:` | controller → all | **also `url` and `title`** on every event | **Yes** | mediaId + playback state only |
| `force_sync` | `sync-control:` | controller → late joiner (all) | `url`, `subtitleUrl`, `title`, state | **Yes** | mediaId + state |
| `subtitle_upload` | `sync-control:` | caster → all | signed `subtitleUrl` | **Yes** | `set_temporary_media_subtitle` + re-resolve |
| `stop_cast`, `request_sync` | Broadcast | any → all | none | No | — |
| `typing` | `sync:` | any → all | `sender_id` (also in the envelope) | Low | Envelope only |
| `timer_*` | `sync:` | timer owner → all | Study subject text, session id, owner id, times | Low (user text) | Kept (capped and not URL-like) |
| Presence | `presence:` | each member → all | `user_id`, `online_at` | Low | Kept (ghost mode is excluded by policy) |
| `room_control_events` | `sync:` Postgres Changes | DB → members, plus the removed subject's own event | event type, subject, action | Low | Already RLS-filtered (`017` lets the removed subject see its own event) |
| Media snapshot | sessionStorage `room-media-state:<room>` | local | Signed URL, title | Local copy of the user's own data | Re-resolved on restore; cleared on removal |
| `get_room_realtime_snapshots` / `upsert_room_realtime_snapshot` | RPC | — | — | — | **Not used by the app** (grep) |
| `realtime.messages` policies | — | — | `sync-chat:`/`sync-study:`/`sync-watch:`/`presence-privileged:` topics are authorized but unused | — | — |

### Part 3: chosen design and rationale

- **Chat (persistent):** Postgres Changes INSERT/UPDATE on `public.messages`
  filtered by `room_id`, on the existing `sync:` channel (no new channel).
  Realtime evaluates the `messages` SELECT policy (`room_has_capability
  'chat'`) for each event and each subscriber, so revocation applies to the
  next row. `room_message`/`room_message_update` were removed from Broadcast.
  DELETE is never subscribed (it is not RLS-filtered, and room chat
  soft-deletes). Rows are de-duplicated by id and ordered by `created_at`.
  The optimistic local merge is kept. E2EE private chat is untouched.
- **Watch (ephemeral, high-frequency):** Broadcast is preserved, but every
  payload passes through `src/lib/room-broadcast-contract.ts`, an allow-list
  of ids, playback and timer fields applied on **send and receive**. URLs,
  titles, subtitle URLs, chat text and storage paths cannot be sent, and
  receivers ignore them from clients that have not updated. Each receiver
  resolves the mediaId through the new `resolveRoomMedia` server action:
  active room, `watch` capability, an RLS read of `temporary_media`, and a
  signed URL capped at 1 hour and the room's expiry. Results are cached per
  mediaId for 45 minutes. URL casts register before broadcasting, so they have
  a mediaId. Subtitles bind to the media row (`attachRoomMediaSubtitle` →
  `set_temporary_media_subtitle`, which needs D8). The revision, ordering and
  late-join relay rules are unchanged; `force_sync` now relays ids and state
  only.
- **Snapshots:** a restored sessionStorage state is re-resolved under current
  authorization. A state without a mediaId is dropped, which also fixes
  restoring expired signed URLs.
- **Missed-update fix (found by the probe):** Postgres Changes starts
  delivering 0.8–1.6 s **after** `SUBSCRIBED` (measured), when Realtime sends
  a `system` `postgres_changes ok` message, and never replays earlier rows.
  `useRoomSync` exposes `connectionGeneration`, which increments on each such
  confirmation (first join and every rejoin). RoomChat then re-reads the
  newest page through RLS, and merge-by-id prevents duplicates.
- **Removal UX (not the security boundary):** the page already leaves the
  room on its own kick/ban/block event. It now also clears the room's media
  and timer cache (`clearRoomRealtimeCache`), as does leaving the room.
  Unmounting closes every room channel.
- **Timer subject** is capped at 120 characters and rejected if it looks like
  a URL. The Study input enforces the same limit.

### Residual metadata (measured on a removed, non-refreshing connection)

After removal, the hostile connection still received:
- `cast`/`play`/`pause`/`seek`/`mute`/`force_sync` with `{castId, controllerId, mediaId, muted, playing, sourceType, speed, time, volume}`;
- `subtitle_upload {mediaId}`;
- `timer_start` with Study subject text, timer timings and owner id;
- `typing {}` and `request_sync {}` envelopes (sender ids);
- its own `membership_changed` event (the removal signal).

It did **not** receive any chat row, message text, media title, URL, signed
URL or storage path, and it cannot resolve the mediaId (0 rows, signing
denied). The leak window for this metadata is bounded by the access-token
lifetime (3600 s measured) or the next token refresh (measured: refresh
revokes the existing subscription).

### Part 4: epoch/topic rotation evaluation (not implemented)

- **Migration needed:** a `rooms.realtime_epoch bigint` column (or a
  `room_realtime_epochs` table), bumped in the same transaction as kick, ban,
  leave and access-reducing permission or feature changes (`review_room_member`,
  `leave_room`, `set_room_role_permission`, `update_room_controls`,
  `set_room_member_role`). The topic grammar in `room_realtime_topic_room_id`
  becomes `<kind>:<room>:<epoch>`, and **both** `realtime.messages` policies
  must also require `epoch = current`. Rollback is a compensating migration
  that restores the 2-segment grammar, and clients must ship first in a
  compatible form.
- **Learning the new epoch:** the existing RLS-filtered `room_control_events`
  Postgres Changes (members only), or a protected RPC on reconnect.
- **Switchover race:** clients move at different times. Events sent on the
  old topic between the bump and each publisher's switch still reach the
  removed connection, and remaining members on the new topic miss them. This
  would need dual-publish/dual-subscribe during a grace window plus a
  `request_sync`/snapshot handshake after the switch. That is complexity
  against a shared provider that currently has no server snapshot. Every
  access-reducing change would also drop and rejoin three channels for every
  member.
- **Benefit after Part 3:** it would remove only the residual metadata above,
  which contains no content, URLs or resolvable references.
- **Recommendation: do not implement now. Accept the residual**, bounded by
  the token lifetime. Revisit if timer subjects or presence identities are
  classified as sensitive. Cheaper alternatives then would be to drop
  `subject` from the timer Broadcast (re-fetch it from study history) or to
  shorten the JWT lifetime.

### JWT and session findings

The measured access-token lifetime is **3600 s** (`exp - iat`, read from a QA
session). The browser client (`@supabase/ssr`) auto-refreshes before expiry,
and Realtime re-evaluates channel authorization when the new token is pushed
(measured: the existing subscription stopped after refresh). A hostile client
can avoid refreshing, so the residual window is at most 1 hour after removal.
Unverified: whether Realtime closes the channel exactly at `exp` (it would
take an hour to observe). Recommendation, not applied: keep 3600 s.
Shortening to 900–1800 s would only shrink the metadata window, at the cost of
more refresh traffic and more realtime re-authorization. It is supplementary
and not needed for content safety.

### Part 5: results (2026-11-05)

`node scripts/security/authorization-probe.mjs full`: **103 pass, 3 fail,
0 blocked, 4 info.** The hostile connection is a separate raw supabase-js
session for the removed account. It mirrors the app's `sync:`, `sync-control:`
and `presence:` subscriptions, never refreshes, ignores removal, and records
everything. A publishes through the app's real contract module.

| Check | Result |
| --- | --- |
| Positive controls (B still a member): chat row via Postgres Changes, cast by mediaId; no title or URL in Broadcast even to members | PASS |
| Removed connection: no chat rows (insert or soft-delete) after removal | PASS (0) |
| Removed connection: no message text, titles, URLs or storage paths in any received payload | PASS (11 payloads inspected) |
| Removed connection: protected fetches (messages, mediaId resolution, signing, snapshots, study notes) | PASS (all denied or 0 rows) |
| Removed account: fresh join of `sync:` | PASS (`CHANNEL_ERROR`) |
| Remaining member: new chat row exactly once, soft-delete exactly once, every Watch/timer/typing/sync event, media resolves under RLS | PASS |
| Late joiner reads the current chat state through RLS | PASS |
| Transport: an existing Broadcast subscription still delivers after removal | INFO, as designed; content-free (see residual) |
| Token refresh revokes the existing subscription | PASS |

T1-T8 (same run): **T1 PASS, T2 PASS, T3 PASS, T5 PASS, T8 PASS.** T6 PASS
for access control, FAIL for owner delete (D6, pending). **T4 FAIL** (D5,
pending). **T7 PASS for content revocation (D7)**; the transport-level residual
is accepted.

**D7 status: FIXED in code (verified against production Realtime/RLS with a
hostile client), NOT YET DEPLOYED.** Until the new app is deployed and old
tabs are refreshed, a not-yet-updated publisher still broadcasts URLs and chat
text. During a mixed rollout, old tabs also cannot play new mediaId-only casts.

### Performance impact

- Postgres Changes on `messages`: for each room message, Realtime evaluates
  the SELECT policy (`room_has_capability`, a few indexed lookups) once per
  subscriber on that room filter. This replaces one Broadcast fan-out. It is
  expected to be fine at current room sizes but was not load-tested.
  Broadcast traffic for chat drops to zero.
- One extra newest-page chat read when the feed becomes ready, and on each
  rejoin.
- Watch: one `resolveRoomMedia` call (auth, room check, capability RPC, one
  row read, one or two signings) per viewer per new media item, cached for
  45 minutes. Playback events add no extra calls. For uploads, the first frame
  waits about one server round trip longer.

### Not verified

- Browser two-profile removal UX (blocked: no second browser profile, and
  passwords are deliberately kept out of the agent's context). Manual steps:
  run `npm run dev`, then sign in as A and B in two profiles. As B, open the
  room with Watch playing and chat open. As A, remove B. B should land on
  `/explore?roomNotice=kicked`, and the `room-media-state:<room>` and
  `timer:<room>` sessionStorage keys should be gone. A keeps chat, Watch,
  presence and a late-join tab working.
- The `resolveRoomMedia`/`attachRoomMediaSubtitle` server actions under the
  Next runtime. The probe exercises their RLS and storage calls directly.
- Subtitle attachment end-to-end (needs D8 applied).
- Message-request RPC probes (need a follow relationship between the QA
  accounts).
- The Realtime "Allow public access" setting; channel close at JWT `exp`;
  load behaviour of Postgres Changes.

## Final verification and close-out run (2026-11-05)

### Inputs

| Input | State | Owner / next step |
| --- | --- | --- |
| `20261105090000`, `20261105100000` applied | **Confirmed**: `migration list --linked` shows both locally and remotely | — |
| QA accounts A and B | Available (private secret files; never printed) | — |
| "A follows B, accepted" | **Was not true**: the database held no follow, friendship or friend request between them (`send_message_request` raised "not connected through a follow relationship"). The probe now creates it through `request_follow`. Standing fixture after the run: A follows B, accepted; no friendship. | — |
| Vercel Preview URL | **BLOCKED: not supplied** | Owner: you. Provide the URL and the commit it was built from. |
| Specs for Actions 03 and 05–10 (`docs/specs/`) | **BLOCKED: directory does not exist** | Owner: you. Add the original action prompts. |

### Phase 1: post-migration verification

- Query 09: the 11 D5/D6/D8 rows are all `ok`. The new 12th row (D9) is
  `FAIL` until `20261105110000` is applied.
- `node scripts/security/authorization-probe.mjs full` (final run):
  **149 pass, 3 fail, 0 blocked, 9 info.** The 3 failures are D9 (below).
  - T4: the recovery decision creates the notification; the recipient reads
    it and marks it read; an unrelated user cannot read, mark or reassign it.
    **PASS** (D5 verified).
  - D6: owner/member file upload and registration; a member cannot delete
    another user's file; a file owner deletes their own file through
    `begin` → storage delete → `complete`; the room owner deletes a member
    file; cross-room and traversal deletes change nothing; the owner deletes
    Watch media. **PASS.**
  - D8: the owner attaches a valid subtitle; a subtitle path from another room
    is rejected; a member without `watch_control` cannot attach; a member
    resolves the subtitle under RLS; a removed member cannot sign it.
    **PASS.**
  - T5 message requests: the requester cannot accept or reject; the
    recipient's cancel returns `false` and changes nothing; a direct status
    update is denied; the recipient rejects; the requester cancels; friends
    cannot open a request. **PASS.**
  - D6 decision, measured: a **former uploader cannot delete** their own file
    after removal. The storage SELECT policy hides the object, so the delete
    matches nothing. Storage deletion already requires current access, so no
    change is recommended. Unmeasured: `begin_room_file_delete` can still mark
    the former uploader's row `delete_pending`.

### Phase 2: public-channel bypass

A separate connection for B joined `sync:`, `sync-control:` and `presence:` for
R1 **without** `private: true` and stayed joined while B was a non-member, a
member and a removed member. A published on the private topics throughout.

- Public joins: `CHANNEL_ERROR` / `CHANNEL_ERROR` / `NO_RESPONSE`.
- Broadcasts received: **0** in every phase. Presence syncs exposing members:
  **0**.
- **PASS: the topics are isolated.** "Allow public access" stays enabled. It
  is still required by the public `messages_inbox`, `chat_<id>` and
  `personal_message_notifications_*` Postgres Changes channels, which are
  RLS-filtered.

### New defect D9 (Action 04): post author visibility

| | |
| --- | --- |
| Classification | CONFIRMED DEFECT (medium, functional; fails closed) |
| Root cause | `posts_select_visible` = `deleted_at IS NULL AND can_view_post(...)`, and `can_view_post` has no "author sees own post" clause. PostgREST runs every insert/update with RETURNING, which requires the new row to pass the SELECT policy. |
| Reproduced (disposable account B) | `createPost('followers')` → `42501`; the author reads 0 of their own followers-only posts; `deletePost` (soft delete) → `42501`; count-only updates also → `42501`. A `public` post by a private author would fail the same way. |
| Fix | `20261105110000_action04_post_author_visibility_repair.sql`, **prepared, NOT applied, needs approval.** One `ALTER POLICY`: `auth.uid() = author_id OR (deleted_at IS NULL AND can_view_post(...))`. Every app read already filters `deleted_at IS NULL` (enforced by a contract test). Other readers keep the previous rule. |
| Regression test | "post authors can read their own posts, so create and soft-delete can return rows" (fails on `007` without the fix). Query 09 row `d9_posts_select_includes_author`. |
| Pending cleanup | One followers-only probe post ("qa debug followers plain") on QA account B, visible only to QA account A. Neither account can delete it until D9 is applied; after that, B can delete it normally. No admin access to production data was used. |

### Phase 3: requirement audit

**Action 01** (spec: `docs/action-01-foundation-and-evidence.md`): its own
definition of done is COMPLETE, as documented. Handed-off gates:

| Gate | Result | Evidence |
| --- | --- | --- |
| Private-room isolation | VERIFIED | T1/T8 probes: non-member, former member and anon |
| Independent two-user testing | VERIFIED (API); browser BLOCKED | Probe uses two independent accounts and sessions |
| Watch/presence/reconnect | VERIFIED (API, D7 observer + feed re-read); browser BLOCKED | D7 probe |
| Lifecycle/recovery | VERIFIED: recoverable room reaches `recovery-window`; recovery request, rejection and notification. UNVERIFIED: denial of member data after expiry, 7-day reopen approval, permanent conversion | T4 |
| Cron/cleanup | BLOCKED | Needs the Preview URL and `CRON_SECRET` status (owner: you) |
| SSR token refresh | BLOCKED | Authenticated browser session (owner: you) |
| E2EE runtime | BLOCKED | Two-identity browser (owner: you) |
| Schema alignment | VERIFIED | `migration list`; catalog queries 01–09 |
| Duplicate realtime paths / legacy `room_messages` | VERIFIED (static) | Inventory in "D5/D6 review and D7" |

**Action 02** (spec: `docs/action-02-authentication-and-identity.md`):
**PARTIAL.**

| Requirement | Result | Evidence |
| --- | --- | --- |
| Google OAuth entry point | VERIFIED (rendered) | Built-in browser on a local `next start`: "Continue with Google" present, no console errors |
| Google OAuth runtime | BLOCKED | Provider configuration and a person's Google sign-in (owner: you) |
| Password compatibility | Auth API VERIFIED (probe signs in by password); app UI BLOCKED | Probe |
| Protected routes | VERIFIED | `authorization-probe.mjs routes`: 7 protected routes → `/login` with a same-origin `next` |
| Safe redirects (callback) | VERIFIED | External, protocol-relative, backslash, encoded-backslash, encoded-`//` and oversized `next` values stay same-origin |
| Public auth pages | VERIFIED | `/login`, `/forgot-password`, `/auth/update-password`, `/` → 200 |
| Profile gate (incomplete → setup, complete → app) | BLOCKED | Authenticated browser (owner: you) |
| Authenticated profile RLS | VERIFIED | A02 probe: own row readable; another user's row unreadable and unwritable |
| Account switching, password-recovery email, production SSR refresh | BLOCKED | Browser/email/production (owner: you) |

**Action 04** (spec: `docs/action-04-profiles-privacy-follows-friends-posts.md`):
**PARTIAL (D9 open).**

| Requirement | Result | Evidence |
| --- | --- | --- |
| Private columns not in the public projection | VERIFIED | `date_of_birth` → `42703` |
| Projection visible to accepted followers | VERIFIED | A04 probe |
| Private profile hidden from non-followers / pending follow path | UNVERIFIED | QA account B is public (`is_private=false`); needs B set to private for one run (owner decision) |
| Follows and friends are RPC-only; self-accept denied; accept/remove transitions | VERIFIED | A04 probe |
| Posts: create every visibility, author reads own, soft delete | **FAIL (D9)** | Fix prepared |
| Posts: non-author cannot edit or delete; follower sees profile and public posts | VERIFIED | A04 probe |
| Message requests | VERIFIED | T5 probe |
| Account deletion runtime | UNVERIFIED | Destructive; needs a dedicated third disposable account and your decision on Google re-authentication |
| Profile/social UI (`src/components/profile/*`) | BLOCKED | Authenticated browser (owner: you) |

**Actions 03 and 05–10:** requirement-level audit **BLOCKED (specs missing)**.
Evidence recorded so far:
- **03:** catalog verified, D1–D3 and D5–D8 fixed and verified, D9 pending.
- **05:** T1/T2 verified (API).
- **06:** recovery decision verified; reopen/permanent/expiry runtime and Cron unverified.
- **07:** D7 verified with a hostile client; browser unverified.
- **08:** chat capability, delivery and notification isolation verified. The scope of replies, reactions, mentions, pins, edits and DND is unknown without the spec.
- **09:** preference scoping covered by unit tests only.
- **10:** T6/D6/D8/F1 verified (API); browser upload unverified.

### Phase 4: browser

- Verified: the unauthenticated login page renders (built-in browser, local
  production build).
- **BLOCKED (owner: you):** every authenticated two-identity flow. The agent
  does not handle passwords, so you need to sign in to both browser
  identities, or sign in to the built-in browser while I drive it. Scope: the
  Phase 4 list in the close-out prompt.

### Phase 5: deployment

**BLOCKED:** no Preview URL was supplied, and Vercel Cron runs only on
production. Needed: the Preview URL, its commit and build status, and the
HTTP status of a manual `CRON_SECRET` call to
`/api/internal/cleanup-expired-rooms` against an expired qa room.

### Validation (this run)

Typecheck PASS; lint 0 errors (13 existing warnings); unit and contract tests
**25/25**; production build PASS; `git diff --check` PASS; probes as above.

## Requirement audit: Final Corrected Roadmap and Feature Guide (2026-11-05)

**Sources (owner-designated specs):** `OmniLume_Final_Corrected_Roadmap.pdf`
(Actions 01–18: per action "What must be fixed or built" and "Definition of
Done") and `OmniLume_Feature_Guide.pdf` (54-feature coverage table with
owning actions). The text was extracted locally; nothing was sent to an
external service. Source presence was measured with code scans of `src/` and
`supabase/migrations/`, and behaviour with the two-account probe.

**Owner decisions recorded in this run:**
- Account deletion: **Option A**. A recent sign-in is required, and it is
  implemented (below).
- QA accounts: free use. QA account B was made private for the probe run and
  then restored (`is_private=false`).
- **Steps 3 (browser) and 4 (Preview/Cron) were waived by the owner.**
  Everything those steps would prove stays **UNVERIFIED**, not PASS: Google
  OAuth runtime, UI flows, mobile layout, deployed build and Cron execution.

**Probe (final, D9 applied):** `authorization-probe.mjs full`: **156 pass,
0 fail, 0 blocked, 8 info.** Query 09: **12/12 ok** (the D9 check pattern was
corrected after it gave a false `FAIL` against the applied policy). No
visible qa posts remain.

### Decision A: account deletion re-authentication (implemented)

- `deleteMyAccount` reads the **verified** access-token claims (`getClaims`)
  for the current session and requires the session's `amr` sign-in time to be
  within **10 minutes**. The check runs before any deletion work. It fails
  closed when the timestamp is missing, implausible or older than the window.
- Measured on this project: the `amr` timestamp stays fixed across token
  refresh, while `iat` advances. So an old or stolen session cannot refresh
  its way past the check, and a fresh password or Google sign-in satisfies it.
- A stale session receives `{ reauthRequired: true }` and nothing is deleted.
  The dialog then offers "Sign in again", which ends the local session and
  returns the user to the same page.
- Tests: `tests/account-deletion.test.ts` (5) covers the window, fail-closed
  handling, clock skew, and a static guard that the check precedes all
  deletion work; the guard fails on the previous code.
- Not run: an actual end-to-end deletion. It is destructive and would need a
  third throwaway account.

### Per-action audit (roadmap "must be fixed or built" + feature guide)

Legend: **DONE+V** = implemented and verified at the database/API layer;
**DONE** = implemented, runtime unverified (browser waived); **DB-ONLY** =
database/RPC exists but no app UI or action; **MISSING** = not in source;
**DECIDE** = needs an owner decision.

**01 Foundation and Evidence: COMPLETE.** Inventory, ledger, evidence
levels, fixture rules, the reusable probe and audit pack exist. Destructive
tests use disposable fixtures only.

**02 Authentication and Identity: DONE (runtime partly waived).**

| Requirement | State |
| --- | --- |
| Google OAuth, callback, loading/error states | DONE (button renders; runtime waived) |
| Safe `next` redirects; protected routes | DONE+V (routes 17/17) |
| Profile-completion gate | DONE (unauthenticated gate verified; incomplete-profile path waived) |
| Existing password accounts | DONE+V (Auth API sign-in) |
| Account switching; recovery/password policy | DONE (runtime waived) |
| Profile RLS (own row only) | DONE+V |
| DoD "Google + legacy flows work, no duplicate users, SSR/client agree" | UNVERIFIED (waived) |

**03 Database, RLS, Storage: COMPLETE (database/security layer).** Remote and
local history match. Catalog audit 01–09 passes. D1–D9 were found, fixed and
verified. SECURITY DEFINER search_path/grants are hardened. Storage is scoped
by actual object path, public channels are isolated, and the probes deny
every unauthorized path tested.

**04 Profiles, Privacy, Follows, Friends, Posts: DONE+V at the
database/API layer.**

| Requirement | State |
| --- | --- |
| Private profile hidden from non-followers; pending follow; requester cannot self-accept | DONE+V |
| Directional follows; RPC-only writes | DONE+V |
| Normalized friendships; accept creates friendship; remove | DONE+V |
| Posts: every visibility, author reads own, follower visibility, soft delete | DONE+V (after D9) |
| Private author's `public` post hidden from followers | DONE+V (current `can_view_post` rule; confirm this is intended) |
| Message requests (role rules) | DONE+V |
| Account deletion with re-authentication | DONE (Decision A); runtime deletion unverified |
| Derived age rules | **DECIDE**: no minimum age is defined in the spec or code |
| UI matrix (DoD requires UI and database tests) | UNVERIFIED (waived) |

**05 Rooms, Membership, Roles, Invitations, Control: mostly DONE+V.**

| Requirement | State |
| --- | --- |
| Invite links/codes | DONE (Control Center + join via invite) |
| Leave/rejoin, kick/ban/block, ownership transfer | DONE+V (T1/T2) |
| Rules and welcome, room lock, temporary guests, announcements | DONE (Control Center UI) |
| Control Center; granular permissions | DONE+V (T2/T3) |
| Room-specific profiles | DONE (Control Center UI) |
| Feature enable/disable | DONE+V (T3 chat feature) |
| Member 3-dot actions | MISSING |
| **Ghost Mode** | DB-ONLY (`set_room_ghost_mode`). The earlier owner scope note excluded the UI, but the roadmap and guide list it: **DECIDE** |
| Feature guide 05/09: layout presets, owner-controlled layout, themes, presence states, bookmarks, guest identity mode | MISSING |
| Feature guide lists "Live AI Meeting Assistant" under 05/09 | **DECIDE**: conflicts with "AI is Action 17, last"; treated as out of scope for 01–10 |

**06 Lifecycle, Expiry, Recovery, Guests, Locks, Scheduling, Cleanup:
PARTIAL.**

| Requirement | State |
| --- | --- |
| State machine (active, expired, recovery-window, reopened, permanent, locked, scheduled, destroyed) | DONE (`room_lifecycle_state`) |
| 24-hour recovery window; request immutability; recovery decision and notification | DONE+V (T4, D5) |
| Exact 7-day reopen on approval; permanent conversion without fake expiry | DONE (in RPCs); runtime unverified |
| Guests and locks | DONE |
| Scheduled rooms | DB-ONLY (`scheduled_for`, validation trigger; no create UI) |
| Idempotent cleanup | **GAP**: the route deletes only `irreversible` rooms. Destroyed `recoverable` rooms keep their messages, files and storage indefinitely (inaccessible, but never cleaned). **DECIDE** (production deletion behaviour). |
| Cron execution | UNVERIFIED (waived) |

**07 Shared Realtime Foundation: DONE+V (API, hostile client).** Typed
allow-list wire contract, chat over RLS-checked Postgres Changes, revision
ordering and dedupe, feed-ready and reconnect re-read, late-join resolution,
removal isolation (D7), and public-topic isolation. Event types for features
that do not exist yet (polls, Music, notes) are pending those features.
Browser verification waived.

**08 Room Messaging and Notifications: mostly MISSING.**

| Requirement | State |
| --- | --- |
| Delete for everyone/me; history pagination; announcements | DONE |
| Room notifications panel with read state | DONE+V (T4) |
| Edit own messages | MISSING |
| Replies/threads | MISSING |
| Reactions | DB-ONLY (`message_reactions` + policies; no UI) |
| GIFs | MISSING (**DECIDE**: needs a GIF provider and API key) |
| Mentions | MISSING |
| Pinned messages | MISSING |
| Notification Center (cross-room) | MISSING (only the per-room panel exists) |
| DND/mute | MISSING |
| Chat unread/read state | MISSING |
| Member 3-dot actions | MISSING |
| Timer-owner and shared-PDF notifications | MISSING |

**09 Adaptive Room Workspace: PARTIAL.**

| Requirement | State |
| --- | --- |
| Resizable chat/sidebar, saved user-scoped panel sizes, feature visibility | DONE (unit-tested preferences) |
| Layout presets, dashboard, themes | MISSING |
| "No empty feature gaps" | **GAP**: the Whiteboard tab renders a "Whiteboard coming soon..." placeholder (`room/[id]/page.tsx:583-589`), although `room_whiteboards` RPCs exist |
| Mobile rules | UNVERIFIED (waived) |

**10 Files, PDFs, Media, Storage Lifecycle: PARTIAL.**

| Requirement | State |
| --- | --- |
| Temporary media upload, register, play, signed URLs bounded by room expiry, subtitles, audio tracks | DONE+V (F1, D6, D8, T6) |
| Upload progress (sequential multi-file) | DONE |
| Upload retry/cancel | MISSING |
| Permanent room files | DB-ONLY (`room_files` RPCs; no UI or action) |
| Shared PDFs with room-wide visibility/notification; PDF annotations | DB-ONLY (`pdf_annotations` RPCs; no viewer or action) |
| Study notes | DB-ONLY (RPCs; no UI) |
| Metadata/artwork/lyrics/attribution | MISSING (**DECIDE**: lyrics need a licensed provider) |
| Abandoned-upload cleanup | PARTIAL (expired temporary media cleaned; orphaned uploads not tracked) |

### Backlog to finish Actions 01–10 (owner to prioritise)

Rough effort, assuming one agent pass each with tests and probes. Items marked
with migration need a reviewed migration and approval.

| # | Item | Action | Effort | Needs |
| --- | --- | --- | --- | --- |
| 1 | Clean up destroyed recoverable rooms | 06 | — | **DONE** (7-day window, migration 20261105120000, not yet applied) |
| 2 | Replace the whiteboard placeholder | 09/10 | — | **DONE** (vector whiteboard) |
| 3 | Edit own messages (+ edited marker) | 08 | S | Migration |
| 4 | Reactions UI on the existing table | 08 | M | — |
| 5 | Replies | 08 | M | Migration |
| 6 | Pinned messages | 08 | M | Migration |
| 7 | Mentions + mention notifications | 08 | M | Migration |
| 8 | Member 3-dot actions | 05/08 | S–M | — |
| 9 | Notification Center + DND/mute + timer/PDF notifications | 08 | L | Migration |
| 10 | Chat unread/read state | 08 | M | Migration |
| 11 | GIFs | 08 | — | **DONE** (GIPHY, room chat) |
| 12 | Permanent room files UI (RPCs exist) | 10 | M–L | — |
| 13 | Shared PDFs viewer + annotations (RPCs exist; native browser viewer, no new dependency) | 10 | L | — |
| 14 | Study notes UI (RPCs exist) | 10 | M | — |
| 15 | Upload retry/cancel | 10 | S–M | — |
| 16 | Scheduled room creation UI (DB exists) | 06 | S–M | — |
| 17 | Layout presets, owner layout, themes, dashboard | 09 | L | — |
| 18 | Presence states, bookmarks, guest identity mode | 05/09 | M each | Design detail |
| 19 | Ghost Mode UI (DB exists) | 05/09 | — | **WON'T DO** (owner decision) |
| 20 | Media metadata/artwork/lyrics | 10 | L | Provider decision |
| 21 | Minimum-age rule | 04 | — | **DONE** (13; migration 20261105120000, not yet applied) |

S ≈ under half a day, M ≈ about a day, L ≈ two or more days.

## Owner decisions implemented and main reconciled (2026-11-05)

### Merge with `main`

`origin/main` carried a separate Actions 05–10 build: Study notes, a PDF
panel, a raster whiteboard, the permanent room-file library, upload
cancel/retry, a server storage provider and persisted realtime snapshots.
It was merged into this branch, and six conflicting files were resolved so
that both sides survive:

- Kept from `main`: the features above, the `sync-chat`, `sync-study` and
  `sync-watch` topics, and server-side verification of stored metadata
  before media is registered.
- Kept from this branch (D7): Broadcast **and the persisted snapshot**
  carry only the wire contract (ids and playback/timer state). Each viewer
  resolves URLs through `resolveRoomMedia`. Media is re-typed to its storage
  contract MIME type before `assertRoomFileInput`.
- Hardened during the merge: `cleanupUnregisteredTemporaryMedia` (a
  service-role delete) now refuses objects that a `temporary_media` row
  references.
- `main`'s `tests/action09-flac-contract.test.mjs` asserted the storage-path
  design. It now asserts the media-id design.

**This changes the requirement audit above for Actions 09 and 10.** Study
notes, the PDF panel and annotations, the permanent file library and upload
retry/cancel exist after the merge. Backlog items 12, 13 (viewer), 14 and 15
are no longer missing. They are unverified in the browser.

### Decisions

| # | Decision | Implementation | Verification |
| --- | --- | --- | --- |
| 1 | Recovery period of 1 week; after it, delete everything | Migration `20261105120000`: `room_lifecycle_state` keeps a recoverable room in `recovery-window` for 7 days after expiry, and for as long as a recovery request is `pending`. `list_rooms_due_for_destruction` and `destroy_expired_room` (service role only; the room is locked and re-checked before the delete) replace the irreversible-only cleanup. The cron route removes the room's storage prefix, then deletes the room, and all 21 room foreign keys cascade. UI copy now says 7 days. | Dry run on the linked project inside a rolled-back transaction: `due=8`, `recovery_window=11`, grants `anon:false, authenticated:false, service_role:true`. Afterwards the function still says 24 hours and `destroy_expired_room` does not exist (not persisted). Static tests in `tests/owner-decisions.test.ts`. |
| 2 | Very good, interactive whiteboard | `StudyWhiteboardPanel` rebuilt as a vector board (`src/lib/whiteboard-model.ts`). Tools: select/move/resize, pan, pen, highlighter, eraser, line, arrow, rectangle, ellipse, text, sticky notes, colours, widths and fill. Also: zoom and pinch, fit, grid, PNG export, undo/redo and shortcuts. Opened from a new room-rail button and from the Study tab. A lost version race merges local edits onto the newer board and retries. Live updates use a version-only `whiteboard_changed` Broadcast followed by `getRoomWhiteboard`, so no drawing content travels over Broadcast. | `tests/whiteboard-model.test.ts` (sanitising, hostile rows, merge, legacy raster, simplification, wire payload). Browser runtime **UNVERIFIED** (browser step waived). |
| 3 | No Ghost Mode | No UI added. `set_room_ghost_mode` stays DB-only and is unreachable from the app. | — |
| 4 | GIFs via GIPHY | Room chat GIF picker (`GifPicker`, `searchGifs` server action). The key is in server-only `GIPHY_API_KEY`, search is limited to signed-in users, and the rating is `pg-13`. A GIF is sent as `[gif:<id>|<title>]` through the normal RLS-checked insert, and the image URL is built from the id. | Live GIPHY call: trending and search each returned 24 of 24 usable results, and the id-built image URL returned `200 image/gif`. `tests/gif-message.test.ts`. |
| 5 | Minimum age 13 | Form validation and `max` date (`latestAllowedDateOfBirth`). Trigger `profiles_enforce_minimum_age` on insert and on date-of-birth change. The trigger error maps to a clear message. | Dry run: an under-13 update was `blocked` and an update to exactly 13 was `allowed`. Unit tests. **Note:** 2 existing profiles are under 13. They are not changed (the trigger only checks new or changed dates of birth), and the owner must decide what to do with them. |
| 6 | All AI features in Action 17 | Recorded. "Live AI Meeting Assistant" is out of scope for 01–10. | — |

### Deployment notes

- Migration `20261105120000` is **prepared, not applied**. Until it is
  applied, the new cleanup route returns an error, because its RPCs do not
  exist, and nothing is deleted. Recovery stays at 24 hours in the database,
  even though the UI says 7 days.
- Once it is applied, the **next cron run permanently deletes 8 rooms**
  (measured 2026-11-05) with all of their data and storage.
- Two irreversible rooms were still present past expiry, so the existing
  cron may not be running in production. Check `CRON_SECRET` and the Vercel
  Cron logs.
- `GIPHY_API_KEY` must be added to the Vercel project environment (it is
  only in the gitignored `.env.local`).

### Validation (this run)

- `npm run test:unit`: 44 of 44 pass. The `main` contract tests
  (`node --test tests/*.mjs`): 5 of 5 pass.
- `npx tsc --noEmit`, `npm run lint` (0 errors) and `npm run build` pass.
- `authorization-probe.mjs full` against the linked project after the merge:
  **156 pass, 0 fail, 0 blocked, 7 info.**
- Not run: browser flows for the whiteboard, GIF picker and merged `main`
  panels (waived), Preview deployment and Cron execution.

## Phase 1 final audit of Actions 01–10 (2026-11-05)

### State
- Branch `fix/actions-01-10-final-audit`, cut from `main` at 65755a7 (PR #17 merge).
- Migration `20261105120000` (7-day recovery, room destruction functions,
  minimum age 13): re-run in a rolled-back transaction (`due=8,
  recovery_window=12, under13_update=blocked, exactly13_update=allowed`,
  delete grants service-role only), then applied with `npx supabase db push`.
  `supabase migration list --linked`: local and remote match for every
  timestamped migration. Live catalog after the push: 7-day window, no
  24-hour text, age trigger present, `destroy_expired_room` and
  `list_rooms_due_for_destruction` executable by `service_role` only.
- `GIPHY_API_KEY` present in `.env.local`.

### Automated checks (after the fixes below)
| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | pass |
| `npm run lint` | 0 errors, 13 warnings (unchanged pre-existing `<img>`/unused warnings) |
| `npm run test:unit` | 48/48 pass (adds `server-action-results.test.ts`) |
| `node --test tests/*.mjs` | 5/5 pass |
| `npm run build` | pass |
| `authorization-probe.mjs full` | 173 pass, 1 fail, 0 blocked, 8 info. The one failure (anon EXECUTE `convert_active_room_to_permanent`) had no error code; the catalog shows anon has no EXECUTE, and three `anon` re-runs each PASS with 42501. A later full run hit 3 network errors (empty error code, Realtime `CHANNEL_ERROR`) in checks that passed in the previous run. Risk noted: some denial checks accept any error, so a dropped request can also pass. |
| `authorization-probe.mjs routes http://localhost:3000` (production build) | 17 pass, 0 fail |
| `lifecycle-probe.mjs` (new) | 25 pass, 0 fail |

The authorization probe now also covers A10 (member whiteboard save and
stale-version rejection, personal-note privacy, room-note edits, the
permanent PDF library, PDF annotations, non-admin file delete denied) and
A06 (`destroy_expired_room` / `list_rooms_due_for_destruction` denied to
`anon` and `authenticated`). The lifecycle probe proves, on disposable
fixtures: the database rejects a date of birth under 13 and accepts a 13th
birthday; an expired recoverable room enters the recovery window, its
content is unreadable while quarantined, a non-member cannot request or
approve recovery, approval reopens it for exactly 7 days and restores
access; a pending request keeps a room past 7 days; a room 8 days past
expiry without a request is due and is deleted with every row (rooms,
members, messages, notes, whiteboard, files, controls) and every stored
object; rejecting a held request makes the room due and it is deleted.

### Browser walkthrough (two accounts, production build, real browser)
Run on `next start` with QA account A (owner) and QA account B (approved
member) in separate incognito sessions (`localhost` and `127.0.0.1`).

| Item | Result |
| --- | --- |
| Whiteboard | Room rail opens it. B's pen stroke saves (v1, "All changes saved") and appears on A's open board live. Rectangle and arrow from both accounts persist. Forced version race (a save made behind B's back): B's next stroke merges onto the newer board and saves v6 with 6 elements, no conflict error (after fix 1). |
| GIF picker | 24 trending GIFs load from GIPHY CDNs, search focus, "Powered by GIPHY". Search "thumbs up" returns 24 results with "Load more". Sending one closes the picker; the GIF renders for B and arrives live for A with its title as alt text. |
| Study notes | Empty state, create room note, autosave. Edits typed while a save is in flight are saved (database: new title and full body, version 6) (after fix 2). Concurrent edit shows the conflict with "Keep my version" / "Load latest"; keeping saves over the other member's version (version 8). |
| PDF panel | Lists the room PDF, opens it in the viewer from a signed URL, page controls; annotation added by A is visible to B. |
| File library | Upload of a PDF into the permanent library lists it (name, type, size); Download returns the PDF (`200 application/pdf`, `%PDF-`) from a signed storage URL. |
| Upload cancel/retry | 40 MB cast upload shows progress, Cancel leaves "Upload cancelled." with Retry; Retry completes, the server verifies and registers it; storage holds exactly one object (no orphan from the cancelled attempt). Cast to room: both accounts get a `<video>` with their own signed URL. |
| 7-day recovery screens | Expired recoverable room: "Data is preserved but inaccessible for 7 days. If no recovery is requested…". Request shows pending, and the owner's Approve/Reject appear at once with "Recovery requested by you." (after fix 5). Approve reopens with ~168 h left; Reject shows "Recovery request was rejected."; a non-member gets "Space Not Found". |
| Age-13 form | Date of birth field has `max` = 13 years ago and the help text; the browser blocks an under-13 date; with the limit removed, the server returns "You must be at least 13 years old to use OmniLume." and nothing is saved. |
| Error messages | An invalid invite code shows the server's real message ("This room is unavailable…") instead of a minified React error (after fix 1). |

### Bugs found and fixed in this run
1. **Server Action errors were hidden in production.** React replaces any
   error thrown by a Server Action with "Minified React error #441", so
   every error message in 80 throw-style actions (study, files, room
   controls, rooms, members, profiles, messages, chat) reached users as that
   code, and the whiteboard and study-note conflict handling could never see
   "expected version". Actions now return `{ ok, data | error }` through
   `actionResult` (`src/lib/action-result.ts`, Next.js control-flow errors
   re-thrown with `unstable_rethrow`) and every call site unwraps with
   `.then(unwrapAction)`, which re-throws the real message so existing
   `try/catch` blocks keep working. `deleteMyAccount` is wrapped the same
   way. A unit test fails if any exported Server Action can throw to the
   browser again.
2. **Study notes lost edits.** A save that finished cleared the dirty flag
   even when the user typed during the request, so later edits were never
   saved while the panel said "Saved.". Fixed with an edit revision counter;
   conflicts now keep the local text and offer "Keep my version" or "Load
   latest (discard mine)".
3. **File library flicker.** Background refreshes replaced the list with
   "Loading files…" every 60 s; only the first load shows the loading state.
4. **PDF annotation double submit.** "Add annotation" now shows "Adding…"
   and is disabled while saving or empty.
5. **Recovery review.** After requesting recovery the owner had to reload to
   see Approve/Reject, and the requester was shown as a raw user UUID. The
   list refreshes after the request, and requesters are labelled "you" or by
   public display name.
- Whiteboard: a pointer-capture failure no longer aborts drawing.

### Open items
- **Nightly cleanup is not running in production.** Two irreversible rooms
  expired before 00:00 UTC on 2026-11-05 (oldest at 22:05 UTC on 2026-11-04)
  and were still present afterwards, although the code deployed at that time
  deleted such rooms. Vercel's environment and Cron logs cannot be read from
  this session (the Vercel CLI is outside the shell allowlist and the Vercel
  connector is not authorized).
- **2 profiles are under 13** (unchanged; the trigger checks new and changed
  dates of birth only).
- **`GIPHY_API_KEY` on Vercel**: cannot be verified from this session.

### Verdict per action (roadmap "What must be fixed or built" + Definition of Done)
| Action | Verdict | Evidence |
| --- | --- | --- |
| 01 Foundation and Evidence | COMPLETE | Ledger, audit pack 01–09, reusable authorization / lifecycle / route probes on disposable fixtures. |
| 02 Authentication and Identity | INCOMPLETE (blocked on owner) | Routes 17/17, profile gate and safe redirects verified; the DoD's Google OAuth runtime (no duplicate users, SSR/client agree) needs a real Google sign-in, which this session cannot perform. |
| 03 Database, RLS, Storage | COMPLETE | Catalog audit 01–09, D1–D9 fixed, every migration applied (list matches), probe 0 failures. |
| 04 Profiles, Privacy, Follows, Friends, Posts | COMPLETE | Privacy/follow/friend/post/message-request matrix in the probe; age 13 enforced in the browser form, server action and database; deletion re-auth. Data decision pending: 2 existing under-13 profiles. |
| 05 Rooms, Membership, Roles, Control | COMPLETE | Invites, join/approve, roles, kick/ban, transfer, controls and feature toggles probed (T1–T3); member action menus present in the members list; Ghost Mode excluded by owner decision. |
| 06 Lifecycle, Expiry, Recovery, Cleanup | INCOMPLETE (blocked on owner) | Code and database verified end to end (lifecycle probe 25/25, recovery screens in the browser), but the production cron did not delete rooms due at its last run. |
| 07 Shared Realtime Foundation | COMPLETE | D7 hostile-client probes; browser: live whiteboard hints, live GIF delivery, per-viewer media resolution. |
| 08 Room Messaging and Notifications | INCOMPLETE (fixable) | Missing: edit own messages, replies/threads, reactions UI, mentions, message pins, shared-PDF and timer-owner notifications, Notification Center, DND/mute, chat unread/read state. Present: send/history/delete, announcements, GIFs, room notification read state. |
| 09 Adaptive Room Workspace | INCOMPLETE (fixable) | Missing: layout presets, themes, room dashboard. Present: resizable chat/side panels with saved per-user sizes, feature visibility, whiteboard (no empty tab). |
| 10 Files, PDFs, Media, Storage | INCOMPLETE (fixable + owner decision) | Present and browser-verified: permanent files, shared PDFs, signed links, upload progress/retry/cancel, subtitles. Missing: media metadata/artwork/attribution/fallback and PDF-share notification (fixable); lyrics need a licensed provider (owner decision). |

## Dashboard extensions result (2026-11-04)

| Finding | Classification | Evidence and disposition |
| --- | --- | --- |
| `_query(text)`, `_db_privs()`, `_get_func_privs(text, text)`, all five returned `_get_rel_owner` overloads, `ok(boolean)`, `ok(boolean, text)`, and `plan(integer)` | Confirmed PASS | The Dashboard catalog export lists every helper signature that the linked CLI lint previously reported as absent. |
| `_array_to_sorted_string(name[], text)` | Pre-existing unrelated issue | It exists, but the lint error searched for `_array_to_sorted_string(text[], unknown)`. This is a helper argument-type mismatch, not an OmniLume migration object. |
| Remaining `extensions` lint failures | Pre-existing unrelated issue; root cause UNVERIFIED | No Action 01-10 migration, application source, or test source references any of the returned helper names. The export rules out simple absence; function definition/settings and extension-version output are still needed to distinguish a search-path/runtime resolution issue from an extension-version mismatch. |
| Action 01-10 RLS, grants, SECURITY DEFINER settings, constraints, storage, Realtime, lifecycle/final-member denial, and recipient isolation | Unverified | The supplied export contains none of the corresponding audit query result sets and no independent authenticated authorization probes. |

No confirmed Action 01-10 application or migration security defect was found by
this result set. No production migration is prepared because there is no
confirmed defect to remediate.

## Baseline evidence

| Check | Result | Evidence |
| --- | --- | --- |
| Working tree | Verified clean | `git status --short --branch` |
| TypeScript | PASS | `npm exec tsc -- --noEmit` |
| Lint | PASS with 13 pre-existing warnings | `npm run lint` |
| Production build | PASS | `npm run build`; 18 routes generated |
| Automated test suite | PASS (30 tests) | `npm run test:unit`: Broadcast contract (5), migration/source contract (9), storage contract and validation (6), account deletion (5), auth and preferences (5). |
| Remote migrations | PASS | `npx supabase migration list --linked`; all 27 local/remote versions match |
| Remote schema signatures | PARTIAL | `npx supabase gen types typescript --linked --schema public` confirms recovered Action 08-10 tables/RPCs, not policies or definitions |
| Remote DB lint | PARTIAL | Dashboard confirms the reported `extensions` helpers exist; the remaining lint helper-resolution issue is unrelated to Actions 01-10 and is not a policy pass |
| Remote catalog audit 01-07 | D1-D3 confirmed, fixed by `20261104120000` and verified | Dashboard exports 2026-11-04; query 08 re-run after the push on 2026-11-05 |
| Two-account authorization probes | 156 pass, 0 fail, 0 blocked, 8 info | `scripts/security/authorization-probe.mjs full`, 2026-11-05 (D9 applied, B private run); `routes` 17/17 |
| Full catalog/policy diff | BLOCKED | Linked `db dump`/`inspect` need `SUPABASE_DB_PASSWORD`; `db diff` needs Docker or Podman |
| Local/browser multi-user | Unverified | Independent authenticated identities were not available in the current environment |
| Vercel/production | Unverified | No deployed-commit, Cron-log, or OAuth-provider evidence obtained |

## Action status matrix

| Action | Implementation | Static | Local browser | Multi-user | DB/security | Production | Status / next gate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 01 Foundation and evidence | Inventory, ledger, audit pack 01-09, two-account probe | PASS | N/A | PASS - probe | PASS | N/A | **COMPLETE** |
| 02 Authentication and identity | All roadmap items in source | PASS | PASS - routes 17/17, rendered login | WAIVED by owner | PASS - profile RLS | WAIVED | PARTIAL - runtime DoD (Google, profile gate, switching) unverified by owner choice. |
| 03 Database, RLS, storage docs | D1-D9 fixed; catalog 01-09 verified | PASS - contract tests | N/A | PASS - 156/156 probe | PASS | N/A (production database) | **COMPLETE** (database/security layer) |
| 04 Profiles, privacy, follows, friends, posts | Server, database and UI; D9 applied; deletion re-auth (Decision A) | PASS | WAIVED | PASS - privacy/follow/friend/post/message-request matrix | PASS | WAIVED | PARTIAL - minimum-age decision; UI matrix waived. |
| 05 Rooms, membership, roles, controls | Control Center, invites, roles, moderation, guests, lock, announcements | PASS | WAIVED | PASS - T1/T2/T3 | PASS | WAIVED | PARTIAL - member 3-dot actions; Ghost Mode decision; 05/09 feature-guide items missing. |
| 06 Lifecycle, expiry, recovery, cleanup | State machine; D5 applied | PASS | WAIVED | PASS - recovery window, decision, notification | PASS | WAIVED (Cron) | PARTIAL - destroyed recoverable rooms never cleaned (decision); scheduled-room UI; 7-day/permanent runtime. |
| 07 Shared realtime foundation | Wire contract; Postgres Changes chat; D7 | PASS | WAIVED | PASS - hostile client, observer, public-topic isolation | PASS | WAIVED | DONE at API layer; browser waived. |
| 08 Room messaging and notifications | Send/history/delete/announcements/room notifications | PASS | WAIVED | PASS - T3/T4 | PASS | WAIVED | **MISSING features**: edit, replies, reactions UI, GIFs, mentions, pins, Notification Center, DND, unread, 3-dot, timer/PDF notifications. |
| 09 Adaptive room workspace | Resizable panels, user-scoped sizes, feature visibility | PASS - unit tests | WAIVED | N/A | N/A | WAIVED | PARTIAL - presets, dashboard, themes missing; whiteboard placeholder. |
| 10 Files, PDFs, media, storage lifecycle | Temporary media, subtitles, signed URLs; D6/D8 | PASS | WAIVED | PASS - T6/D6/D8/F1 | PASS | WAIVED | PARTIAL - permanent files, shared PDFs, study notes UI (database only); retry/cancel; metadata/lyrics. |

## Required external access to close gates

1. Prioritise the backlog in "Requirement audit" and answer its decisions:
   destroyed recoverable-room cleanup, whiteboard placeholder, Ghost Mode,
   GIF and lyrics providers, minimum age, and Live AI Meeting Assistant scope.
2. Browser and Preview/Cron verification were waived by the owner on
   2026-11-05. Those gates stay UNVERIFIED until run.
3. Vercel Preview URL/log access for the exact pushed commit, including Cron
   invocation evidence.

## Actions 01–10 completion run (branch `feat/actions-01-10-complete`, 2026-11-05)

Plan and resume point: `docs/action-01-10-completion-plan.md`. Nothing was
pushed. Every migration below had a rolled-back dry run (migration plus
checks run as simulated `authenticated`/`anon` users inside a transaction
that ends in `RAISE EXCEPTION 'DRYRUN_RESULT …'`) before
`npx supabase db push`. Afterwards, `npx supabase migration list --linked`
shows the same 41 migrations locally and remotely.

Evidence labels: **static** = source review and unit tests; **runtime** =
local production build (`next build` + `next start`); **browser** = the
two-account walkthrough (QA A = room owner on `localhost`, QA B = member on
`127.0.0.1`, separate incognito sessions, desktop 1002–1280 px and iPhone 12
Pro 390×844); **database** = live probes with the two disposable QA accounts,
or rolled-back dry runs, against the linked project.

### Owner decisions applied (they override the roadmap)

- Action 02 COMPLETE: Google sign-in confirmed by the owner.
- Action 06 production cron VERIFIED by the owner. Supabase API logs at
  2026-11-05 08:00 UTC show `list_rooms_due_for_destruction`, storage list
  and `destroy_expired_room` all returning 200, and old expired rooms were
  deleted. Vercel `CRON_SECRET` and `SUPABASE_SERVICE_ROLE_KEY` are correct.
  The cleanup-overlap bug is fixed below.
- `GIPHY_API_KEY` renamed on Vercel by the owner (needs a redeploy). The 2
  under-13 profiles were deleted by the owner. Neither was touched.
- 7-day recovery window; no Ghost Mode; E2EE untouched; AI is Action 17;
  lyrics owner-dropped (not a gap); minimum age 13. Site owners (the only
  recovery reviewers): `09e1232f-…3c1f` and `ca4a2221-…e021`.

### Commits

| Commit | Scope |
| --- | --- |
| `b84f68f` | A06: overlapping cleanup runs treated as already cleaned |
| `38b1503` | A06: site-owner recovery review, §9 permanent-room deletion schedule, policy shown before joining |
| `764bc0a` | A08: notification center, bell popover, private per-user channel |
| `bfb9d2e` | A08: edits, replies, reactions, mentions, pins, announcements/PDF/timer notices, unread state |
| `054c985` | A09: room home, centred/docked chat, presets, themes, owner layout lock |
| `718c861` | A10: provider-neutral media metadata, artwork and attribution |
| `53d726f` | Browser-walkthrough fixes and private inbox/DM channels |

### Migrations (dry run → push → lists match)

| Migration | Purpose |
| --- | --- |
| `20261105130000_action06_site_owner_recovery_and_notifications_core` | site_owners, is_site_owner, typed notifications + single writer, site-owner-only review, §9 deletion schedule |
| `20261105140000_action06_invite_preview_deletion_policy` | invite preview shows the deletion policy before joining |
| `20261105150000_action06_fix_recovery_room_visibility_policy` | **hotfix** for the regression disclosed below |
| `20261105160000_action08_notification_preferences_and_delivery` | DND/room mute, read_at-only updates, publication, access notices |
| `20261105170000_action08_private_personal_notification_channel` | private per-user notification topic |
| `20261105180000_action08_room_messaging` | edits, replies, reactions, pins, mentions/reply/announcement/PDF/timer notices, read state |
| `20261105190000_action09_room_layout_theme` | owner default layout, layout lock, room theme (manage_settings) |
| `20261105200000_action10_media_metadata_cache` | cached metadata column with a shape/size/key/artwork CHECK |
| `20261105200500_action10_media_metadata_rpc` | service-role-only metadata cache RPC |
| `20261105210000_action08_private_dm_and_inbox_channels` | private inbox and private-chat topics |

### Section 1: Action 06 cleanup overlap (`b84f68f`)

- Bug: when two cleanup runs overlapped, the second one's
  `room_cleanup_jobs` upsert hit FK `23503` (the room was already destroyed)
  and was reported as a failure (HTTP 207).
- Fix: `src/lib/room-cleanup.ts` counts a missing parent row, or a room
  deleted before its destroy, as `skipped`. The route reports
  `alreadyCleanedSkipped`; real failures still return 207/500.
- Evidence (static): `tests/room-cleanup.test.ts` covers the overlap, race
  and real-failure cases.
- Evidence (database, owner): production cron logs above.
- Pending recovery requests `f5b1e203…` and `f7b05080…` (rooms `023cab03…`,
  `3ffa29d8…`) were left untouched.

### Section 2: site-owner recovery and §9 (`38b1503`, hotfix `20261105150000`)

- Database (`scripts/security/site-owner-probe.mjs`, **43/43**):
  - Member, admin, room owner and anon cannot review, and cannot list the
    queue.
  - `site_owners` is hidden; self-insert is denied.
  - Any approved member, admin or owner can request recovery, one pending
    request per user per room; forged requesters are denied.
  - Site owners are notified of requests.
  - Positive cases ran with a disposable QA account inserted into
    `site_owners` inside a rolled-back transaction. They covered: queue,
    approve, sibling auto-approval, 7-day reopen, decision notice, double
    review denied, review of a non-pending/missing request denied, reject,
    no review or request after the window, and the room destroyed after the
    window. The real site owners' credentials were never used.
- §9:
  - The owner schedules deletion of a permanent room (7–14 day grace) and
    can cancel; non-owners are denied.
  - Members are notified, and a direct column write is blocked by a trigger.
  - Cleanup destroys the room after the grace period (backdated fixture).
  - The policy appears on explore cards and in the invite preview before
    joining.
- Lifecycle probe **26/26**: room-owner approval is now denied (`42501`).
- Static: `tests/site-owner-recovery.test.ts`; `/admin/recovery` returns
  `notFound()` for non-site-owners; `/admin` requires sign-in (route smoke:
  307 → `/login?next=%2Fadmin%2Frecovery`).

### Section 3: notifications and bell (`764bc0a`, `53d726f`)

- Database (`notification-probe.mjs`, **26/26**):
  - Others cannot read, mark or update your notices; recipients can change
    `read_at` only.
  - Clients cannot insert notices or call the writer.
  - Mark-all-read affects only your own rows.
  - Muting needs membership; room mute and DND suppress room updates;
    access and room-deletion notices still arrive during DND.
  - Live delivery reaches only the recipient.
  - The per-user private channel is joinable only by its user.
  - Own inbox and private-chat channels are joinable; another user's inbox
    and a foreign chat are refused.
- Browser (desktop):
  - B's badge went 0→1→2→3 live for an access notice, a mention and a
    reply, and A's for a PDF share.
  - The popover is anchored under the bell (right edges aligned, 10px
    below).
  - It is a dialog with `aria-expanded`/`aria-controls`; focus moves to the
    heading; Esc closes it and returns focus to the bell.
  - Items show type icons, room names and unread markers; the room-mute and
    DND switches are present.
  - Read state survives a refresh.
  - On the fixed build, the unread count appears 0.5s after the bell renders
    (3.0s after navigation).
- Browser (mobile): fixed sheet 12px from the edges, below the header,
  opaque and on top; room modals (z-index 70+) still cover it.
- Static: `tests/notification-center.test.ts` covers the badge, labels,
  icons, merge, read math, arrow keys, motion values (180/120ms, scale
  .96, 8px), reduced motion, migration guarantees and walkthrough
  regressions. The reduced-motion overrides were confirmed in the stylesheet
  the browser loaded; the preview tool cannot emulate
  `prefers-reduced-motion`.
- Screenshots: popover (desktop) and sheet (mobile) saved under
  `C:\Users\DeLL\.t3\userdata\browser-artifacts\` (local only).

### Section 4: Action 08 messaging (`bfb9d2e`, `53d726f`)

- Database (`messaging-probe.mjs`, **37/37**):
  - Scoped, private mentions: a non-member is never notified, the sender
    cannot see the recipient's notice, and GIF messages never mention.
  - Live reply notices; a reply to another room's message is rejected.
  - Edits: the server sets `edited_at` (the client cannot); nobody can edit
    another member's message.
  - Reactions: only through the RPC; counts add up live; toggling removes
    only your own; unsupported emoji are rejected; non-members cannot react.
  - Pins need `manage_announcements` and appear live; a column write is
    denied.
  - Delete for everyone unpins and clears reactions; a deleted message
    cannot be restored or edited.
  - Announcement, PDF-share and timer-start notices arrive live; an early
    "completed" timer claim does not notify.
  - Unread counts and read markers work, are private, and require
    membership.
- Browser:
  - `@` autocomplete is a combobox with a listbox, `aria-activedescendant`
    and Enter-to-pick.
  - Live: the mention highlight ("me"), the reply quote, 👍 reaction with
    `aria-pressed`, the edit with its "edited" marker, the pin bar for the
    member (no Unpin) and the pinned card on the dashboard.
  - Message menus: the owner gets Reply/React/Pin/Delete for me on others'
    messages; a member gets Reply/React/Edit/Delete for me/Delete for
    everyone on their own messages and never Pin.
  - Members 3-dot: the owner sees View profile/Kick/Ban/Change role on a
    member and only View profile on themself; a member sees only View
    profile. Moderation RPCs are server-gated (authorization probe).
  - GIF picker with the local `GIPHY_API_KEY`: 24 trending results from
    `media2.giphy.com` with GIPHY attribution.
  - "New messages" divider (`role="separator"`) appears before the first
    message after the member's last read.
  - DND and room-mute switches are in the bell (room mute inside rooms).
- Static: `tests/room-messaging.test.ts` covers emoji set parity with SQL,
  mention parsing, autocomplete, the unread divider, reply previews, edit
  rights, pins, the migration contract, notifications never copying chat
  text, no new channel, and read markers actually sent.

### Section 5: Action 09 workspace (`054c985`, `53d726f`)

- Database (`workspace-probe.mjs`, **20/20**):
  - Only `manage_settings` changes the shared layout/theme; direct writes
    and invalid presets are refused; changes are announced as a control
    event.
  - With each feature off, the database and Realtime refuse it: chat
    read/send/react plus the `sync-chat` join; files list/register; study
    timer plus the `sync-study` join; the `sync-watch` join; announcements
    read/post.
  - The general room channel still works, and re-enabling restores access.
  - The files table is never directly readable.
- Browser:
  - Room home: dashboard plus centred chat (720px default, resizable).
    Opening Watch docks chat at the side (320px); Chat focus is wide (44%).
  - Stage focus collapses the panel, which stays mounted (`display:none`),
    with Show/Hide controls.
  - The chat DOM node is identical across all modes, so nothing remounts.
  - Personal preset and theme are saved per room and user (localStorage
    keys).
  - The owner's lock and Emerald theme reached the member live: the
    member's own preset was overridden, the picker was disabled with
    "Locked by the room", and "Room theme (Emerald)" applied (#6ee7b7).
  - Watch turned off: the member fell back to home live, the Watch button
    became disabled, and the dashboard reported "Turned off by the room:
    Watch". No empty stage was visible.
- Browser (mobile): no horizontal overflow; the home page shows the
  dashboard then chat; Watch shows the stage then the panel.
- Static: `tests/room-workspace.test.ts`.

### Section 6: Action 10 media (`718c861`)

- Database (`media-probe.mjs`, **12/12**):
  - A real tagged MP3 was uploaded. The server pipeline read it through a
    signed URL plus HTTP Range (provider-neutral; reads ≤ 64 KB) and got the
    title, artist, album, year and JPEG artwork.
  - Members and the owner cannot write the cache; only the service-role RPC
    can, and the database refuses SVG/invalid artwork even from the server.
  - Members who can watch read the cache; it is hidden while Watch is off.
- Browser:
  - The owner uploaded the MP3 in Watch. Both accounts saw the now-playing
    card with "Walkthrough Theme", "The QA Players · Actions 01-10 · 2026",
    the decoded artwork, and the attribution "Details from the file's
    embedded tags".
  - Player settings offer Subtitles/Audio ("Only the default audio track is
    available").
- Static: `tests/media-metadata.test.ts` covers ID3v2.3/2.4 (UTF-16,
  multi-value, APIC), ID3v1, FLAC (STREAMINFO, Vorbis comments, PICTURE),
  MP4 (moov after mdat via ranged reads), unsafe or oversized art, the
  file-name fallback, deterministic fallback art, and server-side extraction
  contracts.
- No lyrics; no hard-coded storage provider (`openRangeReader` lives behind
  the storage provider interface).
- PDF-share notification: section 4.

### Verification results

| Check | Result | Label |
| --- | --- | --- |
| `tsc --noEmit` | clean | static |
| `npm run lint` | 0 errors; 13 warnings, none from this run's code (`<img>` avatars, unused vars in untouched files) | static |
| `npm run test:unit` | **89/89** | static |
| `next build` | success | runtime |
| Route smoke (`next start`) | `/admin/recovery`, `/home`, `/messages`, `/room/<id>` → 307 sign-in; `/`, `/login`, `/forgot-password` 200; cron without or with a wrong secret → 401. `/explore` is public by design. The login page renders a session check first and "Continue with Google" after hydration (seen in the browser). | runtime |
| authorization probe (`full`) | **175 pass, 0 fail, 0 blocked** | database |
| lifecycle / site-owner / notification / messaging / workspace / media probes | **26 / 43 / 26 / 37 / 20 / 12**, all pass | database |
| Migrations | local and remote lists identical (41) | database |
| Two-account walkthrough, desktop and mobile | all features above; defects fixed in `53d726f` and re-verified on a rebuilt server | browser |

### Defects found during this run (all fixed)

1. **Production regression, about 25 minutes (disclosed).** Migration
   `20261105130000` added a `rooms` SELECT policy that called
   `public.room_user_role`, which client roles cannot execute (RLS runs
   with the caller's privileges). Every authenticated rooms query, and room
   creation, failed with "permission denied for function room_user_role".
   It was fixed by hotfix `20261105150000` (a SECURITY DEFINER wrapper
   granted to `authenticated`; the policy is scoped to `authenticated`).
   Since then every dry run also runs its checks as a simulated
   `authenticated` user.
2. **Private-only Realtime.** The project now refuses public channels. The
   per-user notification channel (`20261105170000`) and the inbox and
   private-chat channels (`20261105210000`) were still public and silently
   failed in production. Personal-message toasts, the inbox refresh and
   live E2EE DM delivery were affected. All three are now private, with
   own-topic or participant-only policies. Encryption is unchanged.
3. Header popovers painted under the chat (the header's stacking context).
   Fixed with header `z-index: 60`.
4. The bell waited 6–10s on room pages behind the page's queued server
   actions. Notification data now goes directly through RLS.
5. Room read markers were never sent (a lazy Supabase builder behind
   `void`). Fixed; a pending marker is flushed on leave.
6. "Former member" was shown while names loaded. Names now load directly;
   "Member" is shown until they arrive.
7. Stage focus kept a panel opened in another layout. Fixed.

### Limits and items not run

- The **encrypted DM browser exchange was not re-run**: QA A and B are no
  longer friends, so RLS blocks DMs between them by design, and creating a
  friendship would be a data change nobody asked for. Private DM and inbox
  channel authorization is verified live (probe); the Postgres Changes path
  on private channels is the one proven live for room chat.
- `prefers-reduced-motion` is verified statically and in the served
  stylesheet only.
- A timer completion notice needs the starter's client to record
  completion. There is no server scheduler; a completion claim earlier than
  the session duration is ignored.
- Unread badges appear in Messages › Groups (group rooms) and in room chat
  (divider).
- Other room panels still use the page's sequential server actions
  (pre-existing, about 1.2s each); the bell and chat no longer depend on
  them.
- Production: not deployed and not pushed. The owner must redeploy Vercel
  for `GIPHY_API_KEY`, and two pending recovery requests await review at
  `/admin/recovery`.

### Verdict

| Action | Verdict | Basis |
| --- | --- | --- |
| 01 Foundation | COMPLETE | Phase 1 ledger; probes above |
| 02 Authentication | COMPLETE | owner confirmed Google sign-in; route smoke |
| 03 Schema/RLS alignment | COMPLETE | Phase 1 remote audit; migration lists match |
| 04 Profiles/social | COMPLETE | Phase 1 (D9 fixed and applied earlier) |
| 05 Room controls | COMPLETE | authorization probe 175/175; member 3-dot verified in browser |
| 06 Lifecycle/recovery | COMPLETE | overlap fix, site-owner recovery, §9, owner cron evidence |
| 07 Realtime | COMPLETE | capability-scoped channels; private-only gaps fixed (`170000`, `210000`) |
| 08 Messaging/notifications | COMPLETE | sections 3–4 |
| 09 Adaptive workspace | COMPLETE | section 5 |
| 10 Files/media | COMPLETE | section 6; lyrics owner-dropped |

## Actions 11–12

**Branch:** `feat/actions-11-12` from `main` at `b72e19e`. Plan and resume
point: `docs/action-11-12-plan.md`. Labels: **static** (source/unit),
**local runtime** (production build on :3000), **multi-user** (two real
accounts, two browser tabs), **database-security** (linked project, probes
and rolled-back dry runs as `authenticated`).

### Part A — Actions 01–10 re-verified on main (2026-11-05)

- static: `tsc` clean; lint 0 errors / 13 warnings (pre-existing); unit
  tests 89/89; `next build` ok.
- database-security: `supabase migration list --linked` local = remote
  (42 rows before Action 11). Probe suite, all `authenticated`/anon
  disposable-account probes: authorization 175, lifecycle 26, site-owner 43,
  notification 26, messaging 37, workspace 20, media 12 — all pass, 0 fail.
- local runtime: `/admin/recovery` signed in as a non-owner → 404. Route
  smoke 9/10 gated as expected (`/explore` is public by design).
- Cleanup cron: overlap safety covered by the existing unit tests; the due
  list was read with a read-only query (4 due). The route was not invoked
  (a run deletes rooms).
- GIPHY: a real search request with the local `GIPHY_API_KEY` returned 200.
  The Vercel environment could not be inspected (Vercel connector not
  authorised); the owner redeploy note above still applies.
- Result: no regressions, so no fix commit was needed.

### Action 11 — Watch and shared media reliability

Database (`20261106100000_action11_watch_queue_clips.sql`, applied):
`room_media_queue` and `room_media_clips` with FKs (`temporary_media`
`ON DELETE CASCADE`), unique `(room_id, media_id)`, CHECKs (position ≥ 0,
start/end range, label 1–120). RLS: SELECT only where
`room_has_capability(room_id, auth.uid(), 'watch')`; `REVOKE ALL` + `GRANT
SELECT` (no direct writes). Writes only through SECURITY DEFINER RPCs with
`search_path = ''`, `GRANT EXECUTE … TO authenticated`: add (watch, live
media in this room, max 50, duplicate → 23505), remove (own with watch, or
watch_control; positions repacked), move (watch_control), create clip
(watch, max 200 per media), delete clip (own or watch_control).

- database-security, dry run (BEGIN … `SET LOCAL ROLE authenticated` with
  JWT claims … RAISE → ROLLBACK): member add/clip ok; member move refused
  42501; owner move ok; outsider add refused and sees 0 rows; anon has no
  EXECUTE; Watch feature off → add refused, rows hidden; deleting the media
  cascades queue and clips. Then `npx supabase db push`; migration list
  local = remote (43 rows).
- database-security, `scripts/security/watch-probe.mjs` (disposable room,
  owner/member/admin/outsider/anon): **20 pass, 0 fail** — queue/clip rules
  per role, direct table writes refused, a member's heartbeat on
  `sync-control` is not delivered (watch_control required to publish), the
  owner's heartbeat and queue hint reach the member, Watch off hides clips
  and refuses queueing.
- static, `tests/watch-sync.test.ts` (in the 97/97 unit run): expected
  position (speed, restored snapshots, cap, no rewind), drift threshold,
  echo-free native broadcast rules, seek coalescing, queue reorder, wire
  contract (heartbeat carries only ids + playback state; hints only a
  version), player contract (`src`/`currentTime`; no `url=`,
  `getInternalPlayer`, `config.file`, ` as any`), heartbeat on the
  control topic, controller-only heartbeat acceptance, still exactly five
  room channels, migration RLS/grant/search_path contract, and the three
  walkthrough regressions below.

Walkthrough (multi-user, local runtime): owner A = `user4` on
`localhost:3000`, member B = `rohan` on `127.0.0.1:3000`, disposable room
`qa-2026-11-05-browser-walkthrough`, generated 240 s / 12 s tagged MP3s and a
VTT. Desktop (1002–1280 px) and mobile (390 × 844).

| Check | Result |
| --- | --- |
| Play/pause/seek parity | B paused at A's exact position (125.28 s); seek back/forward followed |
| Throttled seeking | listener on `sync-control`: pause, seek 100, seek 20, four rapid seeks → **one** seek 80, play |
| Drift correction | B nudged 4 s behind → corrected within one heartbeat (< 2 s) to 0.17 s of A |
| Speed | 1.5x on A → B `playbackRate` 1.5, 0.25 s apart |
| Late join | B reloaded while A played at 1.5x → joined at the live position, 0.37 s off; paused room → joined at 60.00 s |
| Permissions | B (member) has no speed/stop/force-sync/subtitle controls; clip "Jump" disabled with reason; Realtime refuses member heartbeats (probe) |
| Subtitles | A uploaded VTT → B track `showing`, cue active; audio casts now show the cue text |
| External / unsupported | YouTube cast plays in sync on B (heartbeats received); missing URL → error + Retry on both, Retry re-attempts |
| Queue | Queue from history (A and B), "Added by" names, B sees reorder live, A removes B's item, auto-advance at end plays next and empties queue on both |
| Clips | B saved "Key definition" (15 s) → A saw it live, jumped the room, B followed; B deleted own clip → removed on A |
| Now Playing | outside Watch: title/artist, Playing/Paused + position, next item; A paused/resumed the room from the bar, B followed; B's bar has no toggle |
| Mobile 390 px | no horizontal overflow on either account; queue panel, viewer controls, YouTube player fit; bar pinned above the dock |

Bugs found in the walkthrough and fixed (all re-verified above):

1. A controller who reloaded came back on a *restored* snapshot and
   `broadcastPlayback` refused to send from a restored state, so nobody
   could control the room and no heartbeats went out (B drifted and never
   corrected). Explicit user actions by a watch_control member now act on a
   restored snapshot (native events are still filtered by
   `shouldBroadcastNative`).
2. The sync effect armed the 500 ms echo guard on every state change,
   including this client's own seek broadcast, so a play pressed right
   after a seek was swallowed and then reverted. The guard now arms only
   when the effect really changes the element.
3. Audio casts never displayed subtitle cues (audio elements draw none):
   the active cue is rendered as an `aria-live` caption line.
4. Stage toolbar overflowed ("Force sync" clipped) once Queue was added →
   wraps. YouTube's player element has a 300 px min-width and overflowed
   phones → overridden. Room header ran off-screen at 390 px (pre-existing)
   → wraps. Now Playing bar covered home tiles → layers reserve space under
   it; on phones it is pinned above the dock.

Not verifiable in the browser harness: forcing a real Realtime disconnect.
11.10 reconnect is covered by source + unit contract (`connectionGeneration
> 1` → `request_sync`, the same path as late join, which was verified live).
Native FLAC speed uses the same `playbackRate` sync path (static).
