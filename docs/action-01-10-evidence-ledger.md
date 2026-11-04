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
| Automated test suite | PASS (17 tests) | `npm run test:unit`. It includes 6 static migration/source contract tests in `tests/security-migration-contract.test.ts` (each fails on its original defect) and 3 storage-contract tests in `tests/room-file-validation.test.ts` |
| Remote migrations | PASS | `npx supabase migration list --linked`; all 27 local/remote versions match |
| Remote schema signatures | PARTIAL | `npx supabase gen types typescript --linked --schema public` confirms recovered Action 08-10 tables/RPCs, not policies or definitions |
| Remote DB lint | PARTIAL | Dashboard confirms the reported `extensions` helpers exist; the remaining lint helper-resolution issue is unrelated to Actions 01-10 and is not a policy pass |
| Remote catalog audit 01-07 | D1-D3 confirmed, fixed by `20261104120000` and verified | Dashboard exports 2026-11-04; query 08 re-run after the push on 2026-11-05 |
| Two-account authorization probes | 88 pass, 4 fail (D5, D6, D7) | `scripts/security/authorization-probe.mjs full`, 2026-11-05; see "Two-account probe results" |
| Full catalog/policy diff | BLOCKED | Linked `db dump`/`inspect` need `SUPABASE_DB_PASSWORD`; `db diff` needs Docker or Podman |
| Local/browser multi-user | Unverified | Independent authenticated identities were not available in the current environment |
| Vercel/production | Unverified | No deployed-commit, Cron-log, or OAuth-provider evidence obtained |

## Action status matrix

| Action | Implementation | Static | Local browser | Multi-user | DB/security | Production | Status / next gate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 01 Foundation and evidence | Verified inventory, recovery evidence, read-only audit pack (01-08) | PASS | N/A | N/A | Catalog 01-07 received and classified | Unverified | PARTIAL - query 08 export remains. |
| 02 Authentication and identity | Fixed callback/profile-gate consistency; added unit coverage for completion and redirect safety | PASS | BLOCKED - browser automation failed before navigation | N/A | Schema/RLS unverified this run | Unverified | PARTIAL - needs provider configuration and authenticated flows. |
| 03 Database, RLS, storage docs | `20261104120000` applied and verified; `20261105090000` prepared for D5/D6 | PASS - migration contract tests | N/A | PASS - T2, T5, T8 | PASS - D1-D3, RLS on all 30 tables; D5/D6 migration pending approval | Unverified | OPEN - approve and apply `20261105090000`, then re-run the probes. |
| 04 Profiles, privacy, follows, friends, posts | Existing UI/actions/migrations | PASS | Unverified | Unverified | Unverified this run | Unverified | UNVERIFIED. |
| 05 Rooms, membership, roles, controls | Existing controls/invites/restrictions/provider wiring | PASS | Unverified | PASS - T1, T2 (direct API) | PASS | Unverified | PARTIAL - browser UI flows not driven. |
| 06 Lifecycle, expiry, recovery, cleanup | Existing lifecycle/recovery/Cron sources | PASS | Unverified | FAIL - D5: every recovery decision raises 42702 | FAIL - D5 (fix prepared in `20261105090000`) | Unverified | OPEN - apply D5 fix, then re-run T4. |
| 07 Shared realtime foundation | Existing shared provider and typed room sync | PASS | Unverified | FAIL - D7: an existing subscription survives removal | Joins correctly authorized (T7 join checks PASS) | Unverified | OPEN - D7 design decision (JWT expiry and/or no sensitive broadcast payloads). |
| 08 Room messaging and notifications | Partial: send/history/delete/announcements/notifications and lifecycle notification RPCs exist | PASS | Unverified | T3 PASS; T4 FAIL (notifications cannot be created, D5) | PASS - D1 verified; notification policies recipient-scoped (catalog) | Unverified | PARTIAL - T4 isolation after D5 fix; replies, reactions, mentions, pins, edits and DND/mute remain unverified. |
| 09 Adaptive room workspace | Fixed private preference scoping for the sidebar, Watch and Study panel sizes; existing feature panels preserved | PASS - dedicated unit tests, typecheck, lint warnings only | BLOCKED - browser automation could not open a local tab | N/A | N/A | Unverified | PARTIAL - presets, theme preferences and mobile proof remain. |
| 10 Files, PDFs, media, storage lifecycle | F1 fixed: Watch uploads, subtitles and cast history now use the Action 09 RPC and path contract | PASS - unit and contract tests, typecheck, lint warnings only, production build | BLOCKED - browser automation not run | T6 PASS (access control); owner delete FAIL (D6) | PASS (catalog); D6 fix prepared | Unverified | PARTIAL - deploy the app fix, apply D6 fix, run a browser upload. |

## Required external access to close gates

1. Review and approve `20261105090000` (D5, D6), apply it with
   `supabase db push`, then re-run
   `node scripts/security/authorization-probe.mjs full` with the two
   disposable accounts.
2. Decide the D7 Realtime remediation. Confirm in the Dashboard that
   Realtime "Allow public access" is disabled (still UNVERIFIED). Message-
   request RPC probes need a follow-relationship fixture between the QA
   accounts. A configured Google OAuth test client is still required.
3. Vercel Preview URL/log access for the exact pushed commit, including Cron
   invocation evidence.
