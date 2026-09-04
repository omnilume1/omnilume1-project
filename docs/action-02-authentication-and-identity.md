# OmniLume Action 02 — Authentication and Identity

**Status:** PARTIAL / UNVERIFIED pending provider, migration, and authenticated runtime evidence
**Scope:** Authentication and identity foundation only. Actions 03–18 are not implemented here.

## Baseline

The repository already had Supabase browser/server clients and a Next.js 16 `src/proxy.ts` that refreshed sessions and protected room creation and room pages. Login only supported email/password sign-in and sign-up. There was no Google OAuth callback, no first-run identity gate, no password-reset UI, and no account-switch handoff. The `profiles` table contained only `id`, `public_key`, and `created_at`.

## Implemented changes

### Google OAuth

- `src/app/login/page.tsx` now starts Supabase Google OAuth with `prompt=select_account`.
- `src/app/auth/callback/route.ts` exchanges the authorization code server-side through the existing SSR client.
- The callback reads only a safe internal destination and routes incomplete identities to `/profile/setup`.
- OAuth failures return a generic UI message; provider errors, tokens, cookies, and authorization codes are not logged or displayed.
- Supabase/Google dashboard configuration remains an environment task. The required callback pattern is `${ORIGIN}/auth/callback`, with the original destination carried as a validated query value.

### Existing-account compatibility

- The existing email/password sign-in and sign-up calls remain available.
- Sign-up with email confirmation does not navigate until a session exists.
- Google does not create a second application profile when the authenticated Supabase user already has one; profile identity remains keyed by `auth.users.id`.
- Automatic merging of two already-distinct Supabase Auth users is intentionally not implemented. A future identity-linking decision must use Supabase-supported identity linking and must never merge by trusting an email supplied by the browser.

### First-run identity gate

- `006_auth_identity_foundation.sql` adds the additive `profiles.profile_completed` marker, defaulting to `false`.
- `src/proxy.ts` checks this marker for protected application paths and fails closed to `/profile/setup` when the marker is absent, false, or unavailable.
- `src/app/profile/setup/page.tsx` calls the authenticated `completeIdentitySetup` server action, which upserts only the current user’s profile row and sets the marker.
- Full name, DOB, gender, avatar, bio, privacy, and username fields remain owned by the later Profiles action; this action does not implement those features.

### Protected routes and safe redirects

- `src/lib/auth.ts` validates same-origin relative destinations, rejects absolute URLs, protocol-relative URLs, backslashes, NULs, and oversized values.
- `/home`, `/messages`, `/create-room`, `/room`, `/room/*`, `/room-settings`, and `/profile/setup` are now covered by the proxy auth boundary.
- Session-refresh cookies are copied to redirect responses so an SSR refresh is not lost during an auth or profile redirect.
- Server actions continue to authenticate independently; the proxy is not treated as the only security boundary.

### Account switching

- The existing home profile panel now offers **Switch account**.
- Switching performs a local Supabase sign-out and returns to login with a fixed internal destination.
- No credentials, tokens, keys, chats, rooms, or provider data are cached for the next identity.
- This is a safe single-active-session switch. Simultaneous multi-account sessions are not claimed or implemented.

### Recovery and password policy

- `src/app/forgot-password/page.tsx` starts Supabase password recovery without revealing whether an email exists.
- `src/app/auth/update-password/page.tsx` accepts a recovery session, requires at least eight characters and a matching confirmation, and delegates final policy enforcement to Supabase Auth.
- Recovery links return through `/auth/update-password`; the redirect URL must be allowlisted in Supabase.
- Google account recovery remains Google/provider controlled. No password is created or reset for a Google-only identity by this code.

## Files and ownership

| File | Purpose |
|---|---|
| `src/lib/auth.ts` | Pure safe-redirect and protected-path helpers. |
| `src/actions/auth.ts` | Authenticated identity-completion server action. |
| `src/proxy.ts` | Existing SSR refresh boundary extended with auth/profile gating. |
| `src/app/login/page.tsx` | Google OAuth plus preserved password compatibility UI. |
| `src/app/auth/callback/route.ts` | Server-side OAuth code exchange and post-auth routing. |
| `src/app/profile/setup/page.tsx` | Minimal first-run identity confirmation gate. |
| `src/app/forgot-password/page.tsx` | Password recovery request UI. |
| `src/app/auth/update-password/page.tsx` | Recovery-session password update UI. |
| `src/app/home/page.tsx` | Safe single-active-session account-switch entry. |
| `supabase/migrations/006_auth_identity_foundation.sql` | Additive profile completion marker. It has not been applied remotely by this task. |
| `docs/action-02-authentication-and-identity.md` | Implementation limits, evidence status, and provider handoff. |
| `docs/action-01-foundation-and-evidence.md` | Current Action 01 ledger updated only to point to the new auth status. |

## Security guarantees

- No service-role key, OAuth access token, refresh token, cookie, password, private key, or decrypted content is sent to the client by the new server code.
- The callback never redirects to an untrusted origin.
- Profile completion is checked server-side in Proxy and written through an authenticated server action with existing profile RLS.
- Password recovery responses are intentionally generic to reduce account enumeration.
- Existing Supabase SSR/client boundaries, `auth.getUser()` checks, RLS, room membership, E2EE, storage, realtime, and lifecycle code were not weakened or rewritten.
- Migration 006 is additive only: no table drop, truncate, delete, reset, or policy weakening.

## Evidence ledger

| Requirement | Source | Static | Local runtime | Multi-user/browser | Database/security | Production |
|---|---|---|---|---|---|---|
| Google button/callback | DONE | PASS | UNVERIFIED | N/A | UNVERIFIED | UNVERIFIED |
| Existing password compatibility | DONE | PASS | UNVERIFIED | N/A | UNVERIFIED | UNVERIFIED |
| Profile gate | DONE | PASS | UNVERIFIED | N/A | UNVERIFIED until migration 006 is applied | UNVERIFIED |
| Safe redirects | DONE | PASS | PASS for local route probes | N/A | N/A | UNVERIFIED |
| Account switching | DONE (single active session) | PASS | UNVERIFIED | UNVERIFIED | N/A | UNVERIFIED |
| Password recovery | DONE (Supabase-supported flow) | PASS | UNVERIFIED | N/A | UNVERIFIED | UNVERIFIED |
| SSR refresh preservation | PRESERVED/extended | PASS | UNVERIFIED | N/A | N/A | UNVERIFIED |

## Required provider configuration

A deployment owner must configure and verify, without committing secrets:

1. Supabase Auth → Google provider with Google client ID/secret.
2. Google authorized origin(s) for local, preview, and production environments.
3. Supabase redirect URL(s) ending in `/auth/callback` for each supported origin.
4. Password recovery redirect URL ending in `/auth/update-password`.
5. Vercel environment variables for the existing public Supabase URL and anon key.
6. A disposable Google account and an existing password account for runtime verification.

## Action 02 verification plan

Use the Action 01 fixture rules and record each result at its actual evidence level:

- New Google account → callback → setup gate → app.
- Existing complete identity → Google login → requested internal destination.
- Existing password account → login and logout without duplicate profile.
- Email-confirmation sign-up → confirmation notice, no false authenticated redirect.
- Missing/invalid OAuth code → generic login error.
- External, protocol-relative, backslash, and oversized `next` values → safe fallback to `/home`.
- Direct unauthenticated requests to every protected route → login redirect.
- Incomplete identity → setup; complete identity → app; direct setup access after completion → app.
- Switch account → local session ends, next login starts cleanly, identities do not cross.
- Password reset and update using a disposable password account.
- Refresh and SSR navigation without exposing cookie/token values.
- Direct profile write/read checks after migration 006, using only the current user's row.

## Validation performed in this implementation run

- `npx tsc --noEmit` — PASS.
- `npm run build` — PASS; Next.js 16.3.3 compiled and generated the callback, setup, recovery, and protected application routes.
- `npm run lint` — PASS with only the two existing warnings in `postcss.config.mjs` and `src/utils/supabase/server.ts`; no Action 02 lint errors remain.
- `git diff --check` — PASS.
- `npx supabase migration list` — PASS read-only. Local and remote state match through migration 006.
- `npx supabase db push --dry-run` after deployment — PASS; the linked database reported no pending migrations.
- Read-only remote schema probe — PASS; PostgREST accepted `profiles.profile_completed`, and an anonymous zero-row profile count probe returned `Content-Range */0`.
- `powershell -File scripts/action-01-foundation-evidence.ps1 -RunChecks -Remote` — PASS; the reusable Action 01 runner completed its inventory, static guards, checks, and migration-list probe without printing secret values.
- Local unauthenticated route probes — PASS: protected routes returned a login redirect with safe internal `next` values; `/forgot-password` and `/auth/update-password` remained public; an external callback destination fell back to `/home`; `/login` exposed the Google entry point and `/` remained reachable.
- Production HTTPS smoke probe — BLOCKED/UNVERIFIED for Action 02: `/login` returned HTTP 200 but did not contain the new Google entry point, and the new `/forgot-password`, `/auth/update-password`, `/profile/setup`, and `/auth/callback` routes returned HTTP 404. This indicates the deployed application does not yet contain the local Action 02 implementation; no deployment was performed by this task.
- Authenticated Google, password, profile-gate, account-switch, recovery, and production checks were not run because no disposable authenticated credentials/provider configuration were available in this implementation run.

## Remaining blockers

1. The database migration is now applied and up to date, but the deployed application must be updated before the profile gate can be production-verified.
2. Google provider configuration is external to this repository and was not verified here.
3. No disposable authenticated accounts were used in this implementation run, so Google, password compatibility, complete/incomplete profile routing, account switching, recovery, and true session refresh remain UNVERIFIED.
4. No automated test runner exists in `package.json`.
5. Full profile fields and social identity rules belong to Action 04 and are intentionally not implemented here.

## Definition of Done

- [x] Google OAuth entry point and server callback are present.
- [x] Existing email/password flow remains available.
- [x] Explicit profile-completion state and server-enforced gate are present.
- [x] Safe internal redirects are centralized and used by auth routing.
- [x] Single-active-session account switching is available without storing credentials.
- [x] Password recovery/update UI is present with a documented Supabase limitation.
- [x] Loading, disabled, success, error, retry, logout, and expired-session states are represented in the auth/onboarding surfaces.
- [x] No unrelated room, RLS, storage, realtime, E2EE, lifecycle, Watch, Files, Study, or Focus Lock behavior was changed.
- [ ] Google OAuth runtime verification.
- [ ] Existing-account and profile-gate browser verification.
- [x] Migration 006 applied and the remote profile-column/schema probe passed.
- [ ] Authenticated direct profile RLS verification.
- [ ] Production SSR refresh and recovery verification.

**Current conclusion:** Action 02 is implemented in source and statically validated, but it is not yet fully verified or production-closed until the named external configuration, migration, authenticated runtime, and production checks pass.
