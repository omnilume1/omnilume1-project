# OmniLume Actions 01-10 Evidence Ledger

**Recorded:** 2026-11-04
**Branch / baseline:** `feature/action-05-room-controls-ui` at `a6a9cc7`
**Scope:** Actions 01-10 only. Existing E2EE remains unchanged; no Ghost Mode or
member-menu "Block from room" option is introduced.

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

`npx supabase migration list --linked` on 2026-11-04 verified local/remote
agreement through `20260913072048`. The linked project additionally reports
these applied remote-only migration versions, whose SQL is not present here:

`20260918150138`, `20260923120000`, `20260923130000`, `20260923140000`,
`20260924090000`, `20260924093000`, and `20260924100000`.

Do not create replacement migrations or apply older files to compensate for
this drift. Action 03 requires the missing migration source (or an authorized
`db pull` with the database credential), then a catalog and policy comparison.

## Baseline evidence

| Check | Result | Evidence |
| --- | --- | --- |
| Working tree | Verified clean | `git status --short --branch` |
| TypeScript | PASS | `npm exec tsc -- --noEmit` |
| Lint | PASS with 13 pre-existing warnings | `npm run lint` |
| Production build | PASS | `npm run build`; 18 routes generated |
| Automated test suite | Missing | No test script or test directory existed at baseline |
| Remote migrations | PARTIAL | Linked migration list completed; remote-only versions above remain unresolved |
| Remote DB lint | BLOCKED | `npx supabase db lint --linked --level warning` failed because `SUPABASE_DB_PASSWORD` is unavailable |
| Local/browser multi-user | Unverified | Independent authenticated identities were not available in the current environment |
| Vercel/production | Unverified | No deployed-commit, Cron-log, or OAuth-provider evidence obtained |

## Action status matrix

| Action | Implementation | Static | Local browser | Multi-user | DB/security | Production | Status / next gate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 01 Foundation and evidence | Verified inventory updated | PASS | N/A | N/A | Remote inventory PARTIAL | Unverified | PARTIAL - complete remote migration source is required for a reliable Action 03 handoff. |
| 02 Authentication and identity | Existing; targeted consistency verification in progress | PASS | Unverified | N/A | Schema/RLS unverified this run | Unverified | UNVERIFIED - needs provider configuration and authenticated flows. |
| 03 Database, RLS, storage docs | Existing migrations/policies, but local is behind remote | PARTIAL | N/A | N/A | BLOCKED by migration drift and DB password | Unverified | BLOCKED. |
| 04 Profiles, privacy, follows, friends, posts | Existing UI/actions/migrations | PASS | Unverified | Unverified | Unverified this run | Unverified | UNVERIFIED. |
| 05 Rooms, membership, roles, controls | Existing controls/invites/restrictions/provider wiring | PASS | Unverified | Unverified | PARTIAL source review | Unverified | UNVERIFIED. |
| 06 Lifecycle, expiry, recovery, cleanup | Existing lifecycle/recovery/Cron sources | PASS | Unverified | Unverified | PARTIAL source review | Unverified | UNVERIFIED. |
| 07 Shared realtime foundation | Existing shared provider and typed room sync | PASS | Unverified | Unverified | PARTIAL local migration evidence | Unverified | UNVERIFIED. |
| 08 Room messaging and notifications | Partial: send/history/delete/announcements/notifications exist | PASS | Unverified | Unverified | Unverified | Unverified | PARTIAL - replies, reactions, mentions, pins, edits, DND/mute require verified source and schema. |
| 09 Adaptive room workspace | Partial: right sidebar resize/persistence and feature panels exist | PASS | Unverified | N/A | N/A | Unverified | PARTIAL - presets, theme preferences and mobile proof remain. |
| 10 Files, PDFs, media, storage lifecycle | Partial: private upload/progress/media history/signed URLs/cleanup exist | PASS | Unverified | Unverified | Unverified | Unverified | PARTIAL - permanent shared files, shared PDFs, retry/cancel and metadata need schema/source confirmation. |

## Required external access to close gates

1. Authorized database credential or exported SQL for the seven remote-only
   migrations, plus permission to run linked database lint/catalog probes.
2. Two disposable authenticated accounts (separate browser profiles) and a
   configured Google OAuth test client. Do not provide credentials in chat.
3. Vercel Preview URL/log access for the exact pushed commit, including Cron
   invocation evidence.
