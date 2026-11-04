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
still configuration evidence only; no Action 01-10 result set has been received, so
no PASS classification is added by this split.

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
| Automated test suite | Missing | No test script or test directory existed at baseline |
| Remote migrations | PASS | `npx supabase migration list --linked`; all 27 local/remote versions match |
| Remote schema signatures | PARTIAL | `npx supabase gen types typescript --linked --schema public` confirms recovered Action 08-10 tables/RPCs, not policies or definitions |
| Remote DB lint | PARTIAL | Dashboard confirms the reported `extensions` helpers exist; the remaining lint helper-resolution issue is unrelated to Actions 01-10 and is not a policy pass |
| Full catalog/policy diff | BLOCKED | Linked `db dump`/`inspect` need `SUPABASE_DB_PASSWORD`; `db diff` needs Docker or Podman |
| Local/browser multi-user | Unverified | Independent authenticated identities were not available in the current environment |
| Vercel/production | Unverified | No deployed-commit, Cron-log, or OAuth-provider evidence obtained |

## Action status matrix

| Action | Implementation | Static | Local browser | Multi-user | DB/security | Production | Status / next gate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 01 Foundation and evidence | Verified inventory, recovery evidence, and read-only audit script updated | PASS | N/A | N/A | Remote inventory PARTIAL | Unverified | PARTIAL - Dashboard catalog output remains required. |
| 02 Authentication and identity | Fixed callback/profile-gate consistency; added unit coverage for completion and redirect safety | PASS | BLOCKED - browser automation failed before navigation | N/A | Schema/RLS unverified this run | Unverified | PARTIAL - needs provider configuration and authenticated flows. |
| 03 Database, RLS, storage docs | Reconciled exact migration sources and confirmed remote schema signatures | PASS | N/A | N/A | PARTIAL - only unrelated extensions helper result supplied | Unverified | PARTIAL - retain all Dashboard audit result sets and execute authorization probes. |
| 04 Profiles, privacy, follows, friends, posts | Existing UI/actions/migrations | PASS | Unverified | Unverified | Unverified this run | Unverified | UNVERIFIED. |
| 05 Rooms, membership, roles, controls | Existing controls/invites/restrictions/provider wiring | PASS | Unverified | Unverified | PARTIAL recovered migration source | Unverified | UNVERIFIED. |
| 06 Lifecycle, expiry, recovery, cleanup | Existing lifecycle/recovery/Cron sources | PASS | Unverified | Unverified | PARTIAL recovered migration source | Unverified | UNVERIFIED. |
| 07 Shared realtime foundation | Existing shared provider and typed room sync | PASS | Unverified | Unverified | PARTIAL recovered migration source | Unverified | UNVERIFIED. |
| 08 Room messaging and notifications | Partial: send/history/delete/announcements/notifications and lifecycle notification RPCs exist | PASS | Unverified | Unverified | PARTIAL remote type signatures | Unverified | PARTIAL - replies, reactions, mentions, pins, edits, DND/mute and actual authorization behavior remain unverified. |
| 09 Adaptive room workspace | Fixed private preference scoping for the sidebar, Watch and Study panel sizes; existing feature panels preserved | PASS - dedicated unit tests, typecheck, lint warnings only | BLOCKED - browser automation could not open a local tab | N/A | N/A | Unverified | PARTIAL - presets, theme preferences and mobile proof remain. |
| 10 Files, PDFs, media, storage lifecycle | Added centralized type, extension and size validation for existing media/subtitle uploads; private upload/progress/media history/signed URLs/cleanup preserved | PASS - 3 dedicated unit tests; complete suite (8), typecheck, lint warnings only, production build | BLOCKED - browser automation could not open a local tab | Unverified | PARTIAL remote type signatures | Unverified | PARTIAL - permanent shared files/PDF schema now recovered; storage policies and runtime authorization remain unverified. |

## Required external access to close gates

1. The missing Dashboard SQL Editor result sets from the split pack
   `supabase/audits/action01-10/01-rls-policies.sql` through
   `07-lifecycle-and-access-contracts.sql` (run one file at a time; see the pack
   README): RLS/policies, SECURITY DEFINER definitions/grants, constraints/
   indexes/triggers, storage bucket/policies, Realtime publication/policies,
   message-request and Action 08-10 RPC signatures/grants, and the lifecycle/
   former-member/recipient-authorization contracts. An authorized database
   credential can supply the same read-only catalog queries. Docker/Podman is
   additionally required only for CLI `db diff`.
2. Two disposable authenticated accounts (separate browser profiles) and a
   configured Google OAuth test client. Do not provide credentials in chat.
3. Vercel Preview URL/log access for the exact pushed commit, including Cron
   invocation evidence.
