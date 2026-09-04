# OmniLume Action 01 — Foundation and Evidence

**Scope:** Foundation inventory, ownership map, evidence standard, and reusable verification process only.

**Recorded:** 2026-09-04

**Repository:** `omnilume1-project`

**Branch:** `feature/chore/track-supabase-metadata`
**HEAD:** `38efb18 Add OmniLume product roadmap blueprint and source assets`

## Scope guard

This document closes only Roadmap Action 01. It does not implement Actions 02–18.

- No application behavior was changed.
- No database write, migration application, reset, repair, pull, or data mutation was performed.
- No source file, migration, policy, route, or configuration was rewritten.
- Existing legacy files and database tables were retained where their safety could not be proven.
- The attached roadmap is treated as the intended sequence; repository code and observed command results are the evidence source.

## 1. Current repository inventory

### Framework and tooling

| Area | Observed state | Evidence source |
|---|---|---|
| Application | Next.js 16.3.3 with App Router and Turbopack build | `package.json`, production build |
| UI runtime | React 19.2.8 | `package.json` |
| Database/auth | Supabase JS 2.112.4 and `@supabase/ssr` 0.12.5 | `package.json`, `src/utils/supabase/*` |
| Video | `react-player` 3.4.0 | `package.json`, `src/components/room/MediaStage.tsx` |
| Type checking | TypeScript via `npx tsc --noEmit` | command result below |
| Linting | ESLint through `npm run lint` | command result below |
| Tests | No `test` script and no test runner script in `package.json` | `npm run` |
| Supabase CLI | 2.116.0 | `npx supabase --version` |
| Deployment config | Vercel cron in `vercel.json` | `vercel.json` |

### Routes and API entry points

| Route | Role | Current evidence/status |
|---|---|---|
| `/` | Public landing page | Source exists; public entry point is `src/app/page.tsx`. |
| `/login` | Email/password login and signup UI | Source exists; Google OAuth is not present in this Action 01 baseline. |
| `/home` | Authenticated dashboard shell | Source exists; contains demo/placeholder presentation and is not treated as the room source of truth. |
| `/explore` | Public room discovery and join entry | Source exists; authenticated join is enforced by the server action. |
| `/create-room` | Authenticated room creation | Protected by proxy and server action. |
| `/room` | Compatibility entry | Redirects to `/explore`; retained as a legacy-compatible route. |
| `/room/[id]` | Room experience | Authoritative room page; mounts room state, chat, media, study, members, lifecycle, and focus-lock behavior. |
| `/room-settings` | Settings placeholder/entry | Source exists; detailed future settings work belongs to later actions. |
| `/messages` | Private-chat launcher | Source exists; launches existing E2EE private-chat flow. |
| `/api/internal/cleanup-expired-rooms` | Protected cleanup endpoint | Requires `CRON_SECRET`; uses service-role operations server-side. Runtime Cron execution is not verified by this Action 01 run. |
| `/_not-found` | Next.js fallback | Generated/available route. |

### Components, hooks, actions, and libraries

| Area | Authoritative files | Responsibility |
|---|---|---|
| Navigation/landing | `src/components/Navbar.tsx`, `src/components/LandingActions.tsx` | Navigation and legacy landing action component. `LandingActions` is retained until safe removal is separately proven. |
| Focus lock | `src/components/GlobalFocusTrap.tsx`, `src/lib/focus-lock.ts` | Browser focus trap plus local-storage lock state and cleanup events. |
| Private chat UI | `src/components/chat/PrivateChat.tsx`, `src/hooks/usePrivateChat.ts` | E2EE message loading, realtime updates, safe undecryptable state, and private-chat channel. |
| Room shell | `src/app/room/[id]/page.tsx` | Room composition and lifecycle-aware view states. |
| Shared room context | `src/components/room/RoomRealtimeProvider.tsx` | Composes shared sync and presence contexts; it is not itself a second channel. |
| Room sync | `src/hooks/useRoomSync.ts` | Single room event channel `sync:${roomId}` and cleanup. |
| Presence | `src/hooks/useRoomPresence.ts` | Room presence channel `presence:${roomId}` and cleanup. |
| Room chat | `src/components/room/RoomChat.tsx`, `src/actions/chat.ts` | Room chat UI plus protected private-chat/delete action paths. |
| Room/member actions | `src/actions/rooms.ts`, `src/actions/members.ts` | Room creation, joining, conversion entry, access, and membership management. |
| Media/files | `src/components/room/MediaStage.tsx`, `src/components/room/FilesTab.tsx`, `src/actions/media.ts`, `src/lib/storage.ts` | Shared media state, file upload, signed access, and room-scoped storage operations. |
| Study | `src/components/room/StudyStage.tsx`, `src/components/room/StudySubTimer.tsx`, `src/actions/study.ts` | Timer, notes/whiteboard/PDF surface, study history, and Focus Lock entry. |
| Lifecycle | `src/lib/room-lifecycle.ts`, `src/actions/recovery.ts`, cleanup route | Active/reopened/permanent room checks, recovery requests, lifecycle RPC calls, and cleanup. |
| Notifications | `src/actions/notifications.ts`, `src/components/room/RoomNotifications.tsx` | Room notification reads and acknowledgement. |
| Encryption | `src/lib/encryption.ts`, `src/hooks/usePrivateChat.ts`, `src/actions/chat.ts` | Client-side E2EE primitives and encrypted message flow. |

### Supabase and deployment inventory

| Area | Current files/objects |
|---|---|
| Base schema | `supabase/01_schema.sql` |
| Policy documentation | `supabase/POLICIES.md` |
| Supabase guidance | `supabase/README.md` |
| Migrations | `002_rls_lockdown.sql`, `003_room_lifecycle.sql`, `004_security_remediation.sql`, `005_restore_room_creation_policy.sql`, `006_auth_identity_foundation.sql` |
| Migration summary | `002_rls_lockdown_summary.md` is documentation, not a timestamped SQL migration. |
| Historical SQL | `supabase/archive/reconcile.sql`; retained and not treated as the live writer/path. |
| Storage | Private room attachment bucket/path rules described in `POLICIES.md`; application access is through `src/lib/storage.ts` and signed URLs. |
| Vercel schedule | `vercel.json`: `0 0 * * *` targeting `/api/internal/cleanup-expired-rooms`. |
| Environment names | `.env.example` contains `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `TMDB_API_KEY`; `.env.local` was checked by key name only. Values were not printed. |

## 2. Authoritative source-of-truth map

| Core system | Authoritative implementation | Database/security authority | Duplicate or compatibility note |
|---|---|---|---|
| Browser auth | `src/utils/supabase/client.ts` | Supabase Auth | Singleton browser client; do not add another browser auth client. |
| Server auth/session | `src/utils/supabase/server.ts`, `src/proxy.ts` | Supabase Auth cookies and `auth.getUser()` | Proxy protects create-room and room routes; refresh behavior is source-reviewed but not expiry-tested here. |
| Room creation/join | `src/actions/rooms.ts` | `rooms`, `room_members`, RPC `get_room_for_join`, RLS | `/create-room` and `/explore` are UI entry points; authorization remains server/database responsibility. |
| Room access | `src/actions/members.ts`, room page | `get_room_by_identifier`, room/member RLS, lifecycle helpers | `src/app/room/page.tsx` is only a redirect compatibility route. |
| Room lifecycle | `src/lib/room-lifecycle.ts`, `src/actions/recovery.ts`, cleanup route | Migrations 003–005, lifecycle/recovery functions and policies | Cleanup is an operational path; scheduled execution still needs runtime evidence. |
| Room sync | `RoomRealtimeProvider` + `useRoomSync` | Supabase realtime authorization and room policies | `RoomRealtimeProvider` composes contexts; it does not justify another room chat channel. |
| Presence | `useRoomPresence` | Supabase realtime channel authorization | Separate presence channel is intentional; mount/unmount cleanup is source-visible. |
| Room chat | `RoomChat.tsx` and room message query path | `messages`/legacy `room_messages` policies | The legacy `room_messages` table remains in the database, but no application writer was found in `src`. |
| Private E2EE chat | `usePrivateChat`, `PrivateChat`, `src/actions/chat.ts`, `encryption.ts` | `private_chats`, `messages`, `user_keys`, RLS | `chat_${chatId}` is a private-chat channel, not a duplicate room channel. |
| Delete for Everyone | `deleteMessageForEveryone` in `src/actions/chat.ts` plus message UPDATE RLS/trigger | Migration 004 policy and message protection | No second active delete path was identified. Runtime propagation is still a gate for later verification. |
| Media/files | `media.ts`, `MediaStage.tsx`, `FilesTab.tsx`, `storage.ts` | `temporary_media`, `storage.objects`, room membership/lifecycle policies | Shared room events use the existing sync context. |
| Study/Focus Lock | `StudyStage.tsx`, `StudySubTimer.tsx`, `study.ts`, `focus-lock.ts`, `GlobalFocusTrap.tsx` | `study_sessions` and room policies | No rewrite is proposed in Action 01. |
| Notifications | `notifications.ts`, `RoomNotifications.tsx` | `room_notifications` and recipient-scoped RLS from migration 004 | Canonical base schema documentation does not currently show every post-004 object. |
| Schema intent | `supabase/01_schema.sql` plus ordered migrations | Live database | `README.md` says `01_schema.sql` is generated from the database; it must not be hand-edited as an Action 01 convenience. |
| Effective policy documentation | `supabase/POLICIES.md` | Migrations and live database | This is the human-readable effective policy reference. |

### Known legacy or conflicting paths

- `src/components/LandingActions.tsx` remains in the repository but is not the current public homepage import. It is intentionally retained pending a dedicated dead-code proof/removal action.
- `/home` is a dashboard shell with demo-style content. It is not treated as proof that the future identity/social dashboard is complete.
- The current `convertRoomToGroup` action still reflects the existing owner-only/permanent-conversion-era semantics and requires a later Action 14 design/implementation pass. Action 01 records this incompatibility; it does not change it.
- The `room_messages` table is retained because an application writer was removed, but deleting the table would be a separate database decision and is explicitly out of scope.
- Base schema policies and migration overlays coexist by design. The effective state must be read from ordered migrations and live catalogs, not from a single stale policy fragment.

## 3. Evidence levels and status vocabulary

Every later action must report these evidence levels separately:

1. **Source** — the implementation exists in the repository.
2. **Static** — typecheck, build, lint, search, or schema inspection passed.
3. **Local runtime** — the feature was exercised in a local running application.
4. **Multi-user/browser** — independent authenticated browser sessions observed the behavior together.
5. **Database/security** — RLS, storage, RPC, trigger, or authorization behavior was directly tested.
6. **Production** — the deployed application, remote database, scheduler, and production behavior were verified.

Use only these status labels:

| Status | Meaning |
|---|---|
| DONE | Required behavior is implemented and the required evidence level is complete. |
| PARTIAL | Some implementation or evidence exists, but a required part remains. |
| BROKEN | A concrete failure is known. |
| MISSING | The required implementation is not present. |
| BLOCKED | Verification or implementation cannot proceed until a named dependency is available. |
| UNVERIFIED | The source may exist, but the required runtime/security/production evidence was not obtained. |

## 4. Evidence/status ledger

This is the baseline ledger for the current repository. “Source/static” does not imply runtime or production completion.

| System | Source | Static | Local runtime | Multi-user/browser | Database/security | Production | Current note / next gate |
|---|---|---|---|---|---|---|---|
| Public landing/navigation | DONE | PASS | UNVERIFIED | N/A | N/A | UNVERIFIED | Route exists; authenticated/public funnel behavior needs later runtime verification. |
| Auth/login/session | PARTIAL | PASS | UNVERIFIED | N/A | PARTIAL | UNVERIFIED | Google OAuth/callback, profile gate, account switch handoff, and password recovery are now implemented in Action 02; migration/runtime/provider verification remains. |
| Room creation/join | DONE (source) | PASS | UNVERIFIED | UNVERIFIED | PARTIAL | UNVERIFIED | Server auth and current migration map exist; a fresh private-room matrix is a later security/runtime gate. |
| Room membership/RLS | PARTIAL | PASS | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | Policies/migrations are present and aligned by CLI listing; direct current-state matrix is not claimed here. |
| Room lifecycle/recovery | PARTIAL | PASS | UNVERIFIED | UNVERIFIED | PARTIAL | UNVERIFIED | Fields/functions/policies exist; expiry, recovery, seven-day reopen, and cleanup execution need evidence. |
| Shared room realtime | DONE (source) | PASS | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | One sync channel plus one presence channel is source-visible; two-user/reconnect proof is missing. |
| Room chat/delete | PARTIAL | PASS | UNVERIFIED | UNVERIFIED | PARTIAL | UNVERIFIED | Server action and migration protections exist; propagation and unauthorized runtime checks remain. |
| Private E2EE chat | PARTIAL | PASS | UNVERIFIED | UNVERIFIED | PARTIAL | UNVERIFIED | `Promise.allSettled` and safe undecryptable UI exist; mixed-message runtime test remains. |
| Watch/media sync | PARTIAL | PASS | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | React Player v3 path is present; seek, pause/play, late join, and reconnect are not runtime-proven. |
| Files/storage | PARTIAL | PASS | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | Room-scoped upload/signed URL path exists; storage matrix and lifecycle cleanup remain. |
| Study/Focus Lock | PARTIAL | PASS | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | Timer/study UI and lock utility exist; browser lifecycle behavior is unverified. |
| Room notifications | PARTIAL | PASS | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | Read/acknowledge path exists; delivery, persistence, and recipient scope need testing. |
| Cleanup/Cron | PARTIAL | PASS | UNVERIFIED | N/A | PARTIAL | UNVERIFIED | Endpoint is protected and scoped; actual Vercel invocation has not been observed. |
| Profiles/social/follows/friends/posts | MISSING | PASS (no implementation claim) | N/A | N/A | N/A | N/A | Planned for Action 04; not implemented by Action 01. |
| Personal/general/group messaging | MISSING | PASS (no implementation claim) | N/A | N/A | N/A | N/A | Planned for Action 15; existing private E2EE launcher is not the complete social system. |
| Music | MISSING | PASS (no implementation claim) | N/A | N/A | N/A | N/A | Planned for Action 16. |
| AI/intelligence | MISSING | PASS (no implementation claim) | N/A | N/A | N/A | N/A | Planned for final Action 17. |

## 5. Baseline verification record

The following checks were run before adding the Action 01 documentation/script artifacts. No source behavior was changed between baseline and final validation.

| Check | Result | Evidence / interpretation |
|---|---|---|
| `git status --short --untracked-files=all` | PASS | Clean working tree before Action 01 artifacts. |
| `git branch --show-current` | PASS | `feature/chore/track-supabase-metadata`. |
| `git log -1 --oneline` | PASS | `38efb18 Add OmniLume product roadmap blueprint and source assets`. |
| `npx tsc --noEmit` | PASS | Exit code 0; no output. |
| `npm run build` | PASS | Next.js 16.3.3/Turbopack production build compiled and generated routes successfully. |
| `npm run lint` | PASS with 2 warnings | No errors. Existing warnings: anonymous default export in `postcss.config.mjs`; unused caught `error` in `src/utils/supabase/server.ts`. Neither is an Action 01 change. |
| `git diff --check` | PASS | No whitespace errors. |
| `npm run` | PASS | Scripts available: `dev`, `build`, `start`, `lint`; no test script. |
| `npx supabase --version` | PASS | `2.116.0`. |
| `npx supabase migration list` | PASS | Remote/local map showed `002 → 002`, `003 → 003`, `004 → 004`, `005 → 005`. `002_rls_lockdown_summary.md` was correctly skipped as non-migration documentation. |
| Automated unit/integration tests | UNAVAILABLE | No test script or test runner is defined in `package.json`. |
| Live authenticated matrix | UNVERIFIED | Not run in Action 01; requires controlled test accounts/room and belongs to later verification gates. |
| Independent two-user browser run | UNVERIFIED | Not run in Action 01; no browser evidence is claimed. |
| Vercel Cron execution | UNVERIFIED | Configuration is inspectable, but scheduled execution evidence was not available in this baseline. |

## 6. Known verification gates

These are explicit handoff items for later roadmap actions. They are not silently treated as complete.

| Gate | Current status | What is known | Required evidence to close |
|---|---|---|---|
| Private-room isolation | UNVERIFIED | Migrations and policy documentation describe member/active-room scoping; no fresh independent owner/member/non-member/anonymous matrix was run here. | Direct anonymous and authenticated RLS probes against a disposable private room, including expired access. |
| Independent two-user testing | UNVERIFIED | No claim is made from same-profile tabs or static source. | Two isolated browser profiles with identity persistence proven before testing. |
| Watch/presence/reconnect | UNVERIFIED | `useRoomSync` and `useRoomPresence` provide source-level channel ownership and cleanup. | Two-user play/pause/seek/presence/reload/reconnect observations. |
| Lifecycle/recovery | UNVERIFIED | `rooms.reopened_until`, `permanent`, recovery actions, protected RPCs, and cleanup route exist. | Disposable-room expiry, 24-hour request window, seven-day reopen/permanent path, and denial after expiry. |
| Cron/cleanup | UNVERIFIED | `vercel.json` schedules the protected cleanup route. | Vercel execution/log evidence plus idempotent disposable cleanup observation. |
| SSR token refresh | UNVERIFIED | `src/proxy.ts` uses Supabase SSR cookies and `auth.getUser()`. | Authenticated navigation plus safe refresh/expiry lifecycle test without exposing cookies/tokens. |
| E2EE runtime | UNVERIFIED | `usePrivateChat` uses `Promise.allSettled`; UI has an undecryptable state; sensitive crypto logging was not found in the inspected path. | Mixed decryptable/undecryptable message runtime test and browser/server log review. |
| Migration 005/schema alignment | PARTIAL | CLI reports 002–005 aligned. Base schema is intentionally generated and does not show all post-004 objects such as room notification/permanent request tables. | Live catalog comparison and an approved schema regeneration/documentation update in Action 03. |
| Duplicate realtime paths | PASS (static) | One room sync channel `sync:${roomId}`, one presence channel, and a separate private-chat channel were found; no duplicate room chat channel path was found. | Re-check after each realtime feature addition and during two-user runtime test. |
| Legacy `room_messages` path | PASS (static) | Table remains for compatibility; no application writer was found in `src`. | Keep table unless a later migration explicitly proves safe removal; guard against writer reintroduction. |

## 7. Disposable test foundation

Action 01 establishes the process; it does not create or mutate test data.

### Fixture rules

1. Use only explicitly designated disposable accounts and rooms in later actions.
2. Resolve the exact room UUID before any destructive lifecycle test; never select by a loose name alone.
3. Maintain a fixture matrix with owner, admin, approved member, former/removed member, pending member, rejected member, and unrelated authenticated user.
4. Keep credentials in the secure environment/test harness. Never place passwords, cookies, tokens, service-role keys, private keys, ciphertext, or plaintext messages in evidence.
5. Prefer read-only probes. Permit only narrowly scoped disposable-room operations for expiry, recovery, conversion, or cleanup tests.
6. Capture expected result, actual result, evidence level, timestamp, and rollback/cleanup note for every test.
7. Do not use production user content or a real user’s private conversation as a fixture.

### Suggested fixture record (no secrets)

```text
fixture_id: disposable-room-<short-id>
room_id: <UUID recorded only in the secured test log>
owner_account: <account alias>
admin_account: <account alias or none>
approved_member: <account alias>
former_member: <account alias or none>
pending_member: <account alias or none>
rejected_member: <account alias or none>
unrelated_account: <account alias>
created_at: <UTC timestamp>
destructive_scope: <exact tables/files/room state allowed>
cleanup_plan: <how the disposable fixture will be closed>
```

## 8. Reusable evidence runner

The reusable read-only runner is [`scripts/action-01-foundation-evidence.ps1`](../scripts/action-01-foundation-evidence.ps1).

It reports repository identity, route/source inventories, migration filenames, environment **key names only**, static guard searches, and—when requested—the same local validation commands used here. The `-Remote` switch performs only `npx supabase migration list`; it does not push, pull, repair, reset, or mutate data.

Examples:

```powershell
powershell -NoProfile -File .\scripts\action-01-foundation-evidence.ps1
powershell -NoProfile -File .\scripts\action-01-foundation-evidence.ps1 -RunChecks
powershell -NoProfile -File .\scripts\action-01-foundation-evidence.ps1 -RunChecks -Remote
```

The runner intentionally does not print environment values or command output that could contain secrets. Its output is evidence input, not a production-readiness claim.

## 9. Preservation check

Action 01 preserved the existing foundation:

- Supabase browser/server client split and proxy/session behavior were not changed.
- Room creation/join, membership, lifecycle, recovery, and server action paths were not changed.
- `RoomRealtimeProvider`, `useRoomSync`, and `useRoomPresence` were not changed.
- E2EE private chat, per-message decryption tolerance, and safe undecryptable rendering were not changed.
- Watch/media, Files/storage, Study, Focus Lock, notifications, and cleanup implementations were not changed.
- Migrations, policies, canonical schema, data, and existing legacy tables were not changed.
- No new client-only security gate, test bypass, or duplicate implementation was introduced.

## 10. Final validation and comparison

After adding only this document and the read-only runner, the following final checks were rerun:

| Check | Final result | Comparison with baseline |
|---|---|---|
| `npx tsc --noEmit` | PASS | Same result; no application TypeScript changes. |
| `npm run build` | PASS | Same result; route/build output remains valid. |
| `npm run lint` | PASS with 2 pre-existing warnings | Same two warnings; no Action 01 lint error. |
| `git diff --check` | PASS | No whitespace errors. |
| `npx supabase migration list` | PASS | Same aligned `002–005` listing; no migration was applied. |
| `powershell -File scripts/action-01-foundation-evidence.ps1 -RunChecks -Remote` | PASS | Runner completed its read-only inventory/check workflow without exposing secret values. |
| Action 01 artifact trailing-whitespace scan | PASS | The new ledger and runner contain no trailing whitespace; this supplements `git diff --check`, which does not include untracked files. |
| Existing automated tests | UNAVAILABLE | Still no test script/runner is present. |

### Action 01 change boundary

The only intended changes are this evidence ledger and its read-only runner. No functional code, SQL, migration, database object, or deployment configuration changed. The final `git diff --check` result is the guard against accidental whitespace damage; `git status` must be reviewed before any later commit.

## 11. Action 01 definition of done

| Requirement | Result |
|---|---|
| Inventory is current | PASS — routes, actions, components, hooks, providers, Supabase assets, scripts, environment key names, and deployment configuration are recorded. |
| Sources of truth are identified | PASS — authoritative paths and duplicate/legacy boundaries are mapped. |
| Evidence/status ledger exists | PASS — source, static, local runtime, multi-user, database/security, and production levels are separated. |
| Verification standard is documented | PASS — evidence levels, statuses, fixture rules, and reusable runner are documented. |
| Baseline and final checks are recorded | PASS — command outcomes and comparison are recorded above. |
| Blockers are explicit | PASS — private-room isolation, browser, lifecycle, Cron, SSR, E2EE, schema drift, and test-runner gaps are named. |
| Later actions have reusable verification foundations | PASS — fixture process and `action-01-foundation-evidence.ps1` are available without database writes. |
| No unnecessary behavior changed | PASS — only documentation and the read-only evidence runner were added. |

### Conclusion

**Action 01 is COMPLETE.** This means the foundation/evidence work is complete; it does not mean Actions 02–18 or the open runtime/security gates are complete.
