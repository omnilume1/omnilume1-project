# OmniLume Action 04 — Profiles, Privacy, Follows, Friends and Posts

## Scope

This change set establishes the Action 04 server/database foundation without
changing the existing profile setup page or social UI. A concurrent UI effort
can consume these actions and the safe public projection after review.

Action 02's `profiles.profile_completed` remains the authentication/onboarding
marker. Action 04 adds `profile_details_completed` so full social profile
completion can be introduced without breaking existing users or the auth gate.

## Current state and evidence

| Layer | Result | Evidence |
| --- | --- | --- |
| Source | DONE for database/server foundation | Migration 007, `src/actions/profiles.ts`, `src/actions/account.ts`, validation and admin helpers |
| Static | PASS | TypeScript, build, lint and migration dry-runs completed; lint has only the two pre-existing warnings |
| Local runtime | UNVERIFIED | No local browser fixture was available during this implementation pass |
| Multi-user/browser | UNVERIFIED | Requires isolated authenticated test accounts and the concurrent UI |
| Database/security | VERIFIED LIVE for schema/ACL inventory | Migrations 007, 008 and 009 are recorded remotely; catalog recheck confirms RLS, no anonymous table access, and no anonymous RPC EXECUTE |
| Production | UNVERIFIED | Production rollout and live probes are outside this source implementation pass |

## Implementation

### Profile data and privacy

Migration 007 adds display name, lowercase username, date of birth, controlled
gender, avatar URL, bio, privacy, completion, and update timestamps. The
database trigger normalizes usernames, rejects invalid/future values, and
derives `profile_details_completed` from required fields. A unique functional
index prevents case-insensitive username collisions.

The base `profiles` table is now owner-readable only. Raw date of birth,
gender, public key, and other private columns are not exposed through the public
projection. Authenticated users can read `public.public_profiles`, which only
returns safe display fields when the profile is public, the viewer is an
accepted follower/friend, or the viewer is the owner. No age threshold was
invented; date-of-birth validation is the only Action 04 rule until product
policy supplies an age requirement.

### Follows and friends

Follows are directional and have explicit pending/accepted/rejected/cancelled
states. Public profiles accept a follow immediately; private profiles create a
pending request. Friend requests are separate, always require a request, and
use normalized friendship pairs. Accepting a friend request creates the
friendship and both accepted follow rows transactionally and idempotently.

Relationship mutations are RPC-only. Direct table writes are not granted to
authenticated clients. RLS limits reads to participants, and immutable identity
fields/status transitions are protected by triggers and function checks.

### Posts

Posts support owner create/update/soft-delete and relationship-aware reads.
Visibility is `profile`, `public`, or `followers`; deleted posts are excluded
from reads. RLS and the `can_view_post` helper enforce access independently of
the UI.

### Account deletion

`deleteMyAccount` requires an exact deliberate confirmation string and a current
authenticated session. It invokes `prepare_account_deletion` before deleting
the auth user. Shared owned rooms are transferred to the earliest approved
member, preferring an admin. Owner-only rooms are removed with their own
cascaded data because they cannot remain valid with the current non-null room
owner model. Room attachments are preserved; personal storage objects in other
buckets are removed first. Auth-user cascades then remove personal profile,
relationship, and post records. No unrelated user's data is selected for
deletion.

The current architecture does not provide a provider-neutral fresh OAuth
reauthentication endpoint. The action therefore requires a current Supabase
session plus exact confirmation; a future UI may add a provider-specific recent
login/reauth step without changing the database boundary.

## Files and database objects

- `supabase/migrations/007_profiles_social_foundation.sql`
  - profile fields, constraints, indexes and validation trigger
  - `follows`, `friend_requests`, `friendships`, and `posts`
  - privacy projection and relationship helper/RPC functions
  - scoped RLS and function grants
  - safe account-deletion room-ownership preparation
- `supabase/migrations/008_action04_privilege_hardening.sql` — removes inherited
  anonymous table/function privileges from the new Action 04 objects.
- `supabase/migrations/009_action04_privilege_hardening_followup.sql` — removes
  remaining non-data grants from posts and the public profile view after the
  remote catalog recheck.
- `src/lib/profile-validation.ts` — shared server-side input validation.
- `src/actions/profiles.ts` — authenticated profile, relationship and post actions.
- `src/actions/account.ts` — deliberate account deletion action.
- `src/utils/supabase/admin.ts` — server-only service-role client for deletion cleanup.

No existing room, chat, E2EE, realtime, storage bucket, or authentication route
was modified. No table is dropped, truncated, or bulk-deleted by the migration.

## Handoff verification

1. Run `npx tsc --noEmit`, `npm run build`, `npm run lint`, and `git diff --check`.
2. Run `npx supabase migration list`; the linked project currently records
   002–009, including 007–009.
3. Re-query `information_schema`, `pg_policies`, `pg_proc`, grants, and triggers.
   The live recheck found all five Action 04 tables with RLS enabled, no anon
   table grants, and no anon EXECUTE on Action 04 helper/RPC functions.
4. Use disposable isolated accounts to test public/private profiles, follow and
   friend transitions, post visibility, direct unauthorized calls, and account
   deletion. Do not expose private profile fields or secrets in evidence.

## Known blockers

- The existing setup/profile UI remains intentionally unchanged for the
  concurrent Action 04 UI work.
- Browser, multi-user, production, and remote post-migration evidence must be
  collected before the overall Action 04 can be marked complete.
- Account deletion needs a deliberate product decision on whether current
  session + exact confirmation is sufficient for Google accounts or whether the
  UI must require a fresh provider reauthentication step.

## Final validation record

- `npx tsc --noEmit`: PASS.
- `npm run build`: PASS; Next.js 16 route compilation completed.
- `npm run lint`: PASS with only the existing `postcss.config.mjs` anonymous
  default-export warning and the existing unused `error` warning in
  `src/utils/supabase/server.ts`.
- `git diff --check`: PASS.
- `npx supabase db lint --linked --level warning`: PASS; no schema errors.
- `npx supabase migration list`: PASS; remote records 002 through 009.
- Remote catalog: PASS; Action 04 tables have RLS, anonymous table grants are
  absent, and Action 04 helper/RPC functions have no anonymous EXECUTE.
- Anonymous REST probe: UNVERIFIED because the local publishable key was
  rejected by the REST endpoint; no response body or credential was recorded.

Overall Action 04 is **NOT COMPLETE**. The server/database foundation is
implemented and live, but the profile/social UI, disposable multi-user runtime
verification, account-deletion runtime test, and production verification remain
outstanding. This is intentional: no UI files were changed while another Action
04 UI implementation may be in progress.
