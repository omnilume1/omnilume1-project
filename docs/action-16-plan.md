# Action 16 plan (branch `feat/action-16`)

**Status: approved with the owner decisions below; Stage 1 (16.1 + 16.2) done in `0b63be7`; Stage 2 (16.4 + 16.5) done in `4787d07`; Stage 3 (presence + Listen Together, decisions 5/6; uploads part of 16.11) done in `0d79181` (ledger "Action 16 Stage 3"); Stage 4 (custom sources, decision 9) done — see 16.14 (ledger "Action 16 Stage 4"). 16.12 final regression and the Fix-tags part of 16.13 done (ledger "Action 16.13 (part) + 16.12"). Still deferred until the owner supplies keys/decisions: providers (16.0, 16.3, 16.6-16.10, decision 1), YouTube room cast (16.11), 16.13 cache table and lyrics providers.**
Resume point. Tick an item only with its commit hash; evidence goes in
`docs/action-01-10-evidence-ledger.md` (new section "Action 16", same layout as
Actions 13-15: Database / database-security / static / local runtime / Limits).
Specs: `OMNILUME_MASTER_PLAN.md` §17 "Music Activity" (+ "Music metadata", "Lyrics",
"Lume Music"), the owner brief for Action 16, and `docs/action-16-bitchord-teardown.md`
(measured look + how BitChord works). The roadmap PDF could not be read in this
session (no `pdftoppm`), so any Action 16 line unique to it is unverified.
Same Rules as `docs/action-15-plan.md`: additive migrations, RLS on every table,
definer helpers with `search_path = ''`, private-only realtime, errors as values,
dry run as `authenticated` before `npx supabase db push`, never push or merge.

## Verdict: PARTIAL

| Part | Verdict | Why |
| --- | --- | --- |
| Look and feel (shell, pill, panels, tokens, motion) | **YES** | Pure CSS/React; same Tailwind 4 + React 19 line. Written from scratch from the measured values. |
| Uploaded-file player (queue, tags, artwork, lyrics, 48 h expiry) | **YES** | We own the bytes: HTMLAudio + signed URLs; Supabase private bucket + RLS + cleanup already proven in Action 09. |
| YouTube Music playback **the way BitChord does it** | **NO** | Unofficial InnerTube + BotGuard + stream extraction + header spoofing + hidden audio. Breaks YouTube ToS and API Developer Policies. Not allowed. |
| YouTube playback, **compliant version** | **PARTIAL** | Official IFrame Player API (visible player) + Data API v3. Looks the same around the player; the player itself must stay visible, search is quota-starved by default, no audio extraction. |
| Spotify | **PARTIAL** | Web Playback SDK (Premium listeners only); Spotify Dev Mode since Feb 2026 = 5 users + Premium developer; wider use needs Extended Quota (org-only). |
| Apple Music | **PARTIAL** | MusicKit JS works, but needs Apple Developer Program membership (paid) and listeners with a subscription. |
| TIDAL | **PARTIAL** | Official TIDAL SDK for Web (auth + Player components) exists; access approval not confirmed. |
| Qobuz | **NO (for now)** | API is partner-only; the only public routes are unofficial credentials Qobuz has revoked before. Blocked until Qobuz grants partner access. |

### Honest user experience (what will differ from BitChord)

- **Uploads:** as close to BitChord as it gets: artwork in the pill, full-screen artwork + mesh backdrop, synced lyrics (embedded/`.lrc`), shuffle/repeat/queue/keyboard/Media Session. Possible later (own files only): crossfade/gapless via Web Audio.
- **YouTube:** the chrome (sidebar, glass pill, Up Next, search, library) looks identical, and playback goes through YouTube's **embedded player**, which **must stay visible** (≥ 200×200 px, nothing drawn over it, Referer sent, no hidden/background player, no audio-only). So there is a visible video tile (planned 300×200 in the side panel / full-screen player) instead of "audio only", **no** custom lyrics-over-video, **no** crossfade/automix/gapless/EQ, **no** artwork-colour tint (YouTube thumbnails are cross-origin, so no canvas colour read), **no** live search suggestions (quota), some tracks will not play (non-embeddable, age-gated, region, YouTube-Music-only content). "YouTube Music" really means YouTube's catalogue (incl. official "Topic"/audio uploads): there is **no** official YouTube Music API or embed.
- **Other providers:** playback only through each vendor's SDK; their branding and attribution rules apply; no raw audio, so none of BitChord's DSP-style features.

## Current code: reuse vs replace

- **Reuse:** `react-player` 3.4 (already plays YouTube in `MediaStage`); `RoomMediaState`, `broadcastEvent('cast', …)` and `lib/watch-sync` (`expectedPosition`) for room playback sync; Action 09 storage lifecycle (register RPC, `delete_pending`/complete, cleanup-jobs table, `lib/room-cleanup.ts`, FLAC contract, `startUploadFileWithProgress` in `lib/storage.ts`); the daily cleanup route + `CRON_SECRET`; `ActionResult`/`DataResult`; `src/proxy.ts` auth gate; `youTubeId()` in `lib/collab-model.ts`.
- **Not replaced:** `StudyMusicCard` (Action 12) stays as the *room* music surface (lists room audio from temporary media, casts through Watch). The Music section is the *personal* player. In 16.11 `StudyMusicCard` gains a "from My Music" entry; nothing is deleted.
- **New:** `/music` route group, music-scoped tokens (own file, selector `.music-app`; `globals.css` is not edited), DM Sans via `next/font/google` in the music layout only (Geist stays everywhere else).

## Owner decisions (2026-11-05; override everything below where they differ)

1. **No audio providers for now** (YouTube/Spotify/Apple/TIDAL/Qobuz, quota, OAuth, lyric providers): 16.0, 16.3, 16.6-16.10 deferred until the owner says. Uploads stay in scope.
2. **Look:** BitChord layout/behaviour from the teardown, own code only (no BitChord code/assets/names, no SF Pro). Dark only; accent `#b9a8ff` (text/icons) / `#8d7bff` (filled); glass blur 16px + saturate 2.2 + 0.5px inner stroke. Scoped `.music-app`, tokens `--mu-*`, DM Sans via `next/font` in the music layout only.
3. **Uploads:** 7 days from upload (one constant), 300 MB/user, 50 MB/file, 40 files/user; tags via `music-metadata` (lazy, browser); lyrics embedded + `.lrc` only.
4. **Sharing:** per-upload opt-in to a room/group, revocable, "I have the right to share" attestation, audience = that room/group's members, signed URL via RPC. Never public.
5. **Presence:** friends see "Listening to …", also in rooms/groups; privacy setting friends/nobody (default friends).
6. **Listen Together:** host + members, `{trackRef, positionMs, anchorMs, isPlaying, seq}`, drop `seq <= last`, playhead from anchor, queue deltas, optional host-only control; Supabase Realtime (private) only.
7. **Playlists + listening history:** owner-only RLS, history clearable, expired uploads shown "expired".
8. **Global mini player:** provider in the root layout, plays across pages; Study room music (Action 12) untouched.
9. **Custom sources:** user-added HTTPS JSON manifest (search → tracks with direct audio URL), browser-only calls, per-user RLS rows, health check, owner-only playback, never shared; we ship none. Stages: 1 = 16.1+16.2 · 2 = 16.4+16.5+sharing/playlists/history · 3 = presence + Listen Together · 4 = custom sources.

10. **YouTube (official embed) is the first music source for OmniLume** (2026-11-05). Implementation stays deferred (decision 1) until the owner says; it lands in 16.3 (playback + search) and 16.6 (Google sign-in for the user's playlists/likes). Source id `youtube`, plays only through the official IFrame Player + Data API v3; no extension, no private API, no stream extraction. **Minimised player rule:** the embed may NOT be removed, hidden or moved off-screen while a YouTube track plays (policy: no background player; ≥ 200×200 visible). So "minimise" = the video tile docks as a small floating window (≥ 200×200, corner, draggable, always visible on every page) while the pill collapses; if the user closes the tile, YouTube playback pauses. Owner asked for "remove the tile when minimised": not allowed for YouTube; uploads (own audio) have no tile and minimise freely.
11. **Song info + lyrics sources:** see "Later stage: song info and lyrics sources" (task 16.13). Until then: embedded tags + user `.lrc` only (decision 3).

## Phased tasks (each independently shippable)

Task format: **what**, **files**, **DB**, **tests/evidence**, **model**. Evidence style
matches `docs/action-01-10-evidence-ledger.md` (dry run as `authenticated`/`anon`,
live probe counts, static contract tests, local runtime/browser at 1440/1024/768/390,
Limits).

- [ ] **16.0 Access prerequisites (no code).** Owner supplies, before the task that needs them: Google Cloud project + YouTube Data API key (16.3) + OAuth consent screen/client (16.6); `MUSIC_TOKEN_ENC_KEY` (16.6); Spotify app (16.7); Apple Developer membership + MusicKit key (16.8); TIDAL developer access (16.9); Qobuz partner contact (16.10). Start the **YouTube quota-extension request early** (see Risks).

- [x] **16.1 UI shell, the look (fixtures only, no player, no network).** `0b63be7` (ledger "Action 16.1 + 16.2")
  Layout: sidebar 260 px glass (16 px blur, saturate 2.2), scrolling content column, floating 668×56 pill, 300 px right panel (0.3 s slide), phone top bar + mini-player < 484 px, gutters 25/40, shelf grid + arrows ≥ 1000 px, breakpoints 484/767/1000/1260/1580/1940, skeleton / empty / error states, focus rings, reduced motion. Pages: Home, Search (landing + results), Library (songs/albums/artists from fixtures), Album/Playlist detail, Settings (connections placeholder), Not found.
  Files: `src/app/music/{layout.tsx,music.css,page.tsx,loading.tsx,error.tsx,not-found.tsx}`, `src/app/music/{search,library/[section],album/[id],playlist/[id],settings}/page.tsx`, `src/components/music/{MusicShell,MusicSidebar,MusicMobileBar,PlayerPill,NowPlayingLcd,VolumeControl,SidePanel,UpNextPanel,LyricsPanel,FullScreenPlayer,MeshBackdrop,Shelf,Lockups,TrackList,Artwork,SearchField,States,ContextMenu}.tsx`, `src/lib/music-fixtures.ts` (synthetic titles, no real artists/artwork), nav link in the internal nav, `isAuthRequiredPath` += `/music` (`src/lib/auth.ts`, `tests/auth-redirects.test.ts`).
  DB: none.
  Tests/evidence: `tests/music-shell-contract.test.ts` (music CSS only under `.music-app`, no `globals.css` edit, font loaded in music layout only, reduced-motion + focus-visible blocks, route is auth-gated); browser computed-style table vs the teardown (sidebar 260, pill 668×56, radius 1000 px, h1 34/40 700, row 46/54, artwork radii 5/7/10, glass values) at 1440/1024/768/390, no horizontal overflow at 390, keyboard + a11y landmarks; `npm run lint`, `next build`.
  Model: Sonnet 5.5, medium.

- [x] **16.2 Player core (engine-agnostic).** `0b63be7` + global mini player (decision 8)
  Queue model (context / hand-queued "play next" + "add to queue" / autoplay slot), shuffle (restores order when off), repeat off→all→one, back restarts after 10 s, Up Next reorder/remove/clear, volume/mute, LCD progress scrub, keyboard (Space, ⌘/Ctrl+←→↑↓, ⌘/Ctrl+F or `/`, Esc), Media Session (metadata, state, prev/next, position), `localStorage` persistence (shuffle/repeat/volume/mute). Engine interface `{load, play, pause, seek, setVolume, currentTime, duration, on(event)}` with a silent test engine.
  Files: `src/lib/music-queue.ts` (pure), `src/lib/music-model.ts`, `src/hooks/useMusicPlayer.tsx` (provider + reducer), `src/lib/music-shortcuts.ts`; wire the 16.1 components.
  DB: none.
  Tests/evidence: `tests/music-queue.test.ts` (own cases: start list, play next/add, jump, shuffle + restore, repeat modes, back>10 s, clear, dedupe), shortcut guard test (typing target), browser: keyboard + Media Session registered, state survives reload.
  Model: Sonnet 5.5, medium.

- [ ] **16.3 YouTube playback + search (compliant).**
  **Spike first (½ day):** react-player's YouTube element vs a thin wrapper on the official IFrame Player API; pick whichever surfaces player errors 2/5/100/101/150 (not found / embed blocked). Visible tile ≥ 200×200 (planned 300×200) inside the Now Playing panel and full-screen player, and as a floating docked tile (≥ 200×200, always visible app-wide) when the player is minimised; closing it pauses playback (decision 10); custom controls **outside** the iframe; nothing overlays it; `referrerPolicy` never `noreferrer`; start only when > 50 % visible and after a user gesture; one player at a time. Search: `search.list` (`type=video`, `videoCategoryId=10`, `videoEmbeddable=true`, `videoSyndicated=true`, `maxResults≤20`) then `videos.list` (`contentDetails,status,snippet`) to drop non-embeddable/duration; results cached ≤ 24 h (API-data cap is 30 days); per-user limit; quota ledger with a hard stop and a friendly "search is busy" state; Enter/button search only (no keystroke suggestions); thumbnails via plain `<img>` from `i.ytimg.com`.
  Files: `src/lib/music-engines/youtube.ts`, `src/components/music/VideoTile.tsx`, `src/app/api/music/youtube/search/route.ts`, `src/lib/music-youtube.ts` (query building, response mapping, validation; server-only), unavailable-track UI states, YouTube ToS + Google Privacy Policy links on Settings/footer.
  DB (additive, `…action16_music_search_cache.sql`): `music_search_cache(provider, query_hash, result jsonb, fetched_at, expires_at)` and `music_api_usage(provider, day, units)` + `consume_music_api_quota(provider, units, daily_limit)` (service role only; atomic upsert). RLS enabled, no grants to `anon`/`authenticated`.
  Tests/evidence: `tests/music-youtube.test.ts` (query building, mapping, non-embeddable filter, error-code mapping, input validation), `scripts/security/music-probe.mjs` (anon/other-user refused; quota ledger stops at limit; cache never returned past expiry), static check that `YOUTUBE_API_KEY` is read only server-side and never in a client bundle; browser: tile visible ≥ 200×200 while playing, no element overlaps it, 390 px layout, embed-blocked track shows the unavailable state.
  Model: Sonnet 5.5, high.

- [x] **16.4 Upload player, in the tab (no storage yet).** `4787d07` (ledger "Action 16.4 + 16.5"; uploads go straight to storage, decision 3)
  File picker/drop (mp3, flac, ogg, wav, m4a/aac, webm; same MIME contract as Action 09), `<audio>` via object URL, tag parsing in the browser (title, artist, album, album artist, track, year, genre, ISRC, duration, embedded artwork, embedded lyrics), `.lrc` sidecar parser + synced lyrics view (current line at 15 %/30 %), artwork → mesh backdrop colour (canvas; own files are same-origin), Library views grouped by album/artist from tags, safe "no key/unsupported file" states. Dependency decision: one lazily imported tag parser (`music-metadata`, browser build) because ID3/FLAC/MP4 parsing is not a few lines.
  Files: `src/lib/music-engines/local.ts`, `src/lib/music-tags.ts`, `src/lib/music-lrc.ts`, `src/components/music/UploadDropzone.tsx`.
  DB: none.
  Tests/evidence: `tests/music-lrc.test.ts` (timestamps, offsets, multi-stamp lines, malformed input), `tests/music-tags.test.ts` (normalisation/length caps, text-only output), browser with throw-away sample files (mp3 + flac + corrupt file).
  Model: Sonnet 5.5, medium.

- [x] **16.5 Storage + 48 h expiry.** `4787d07` — 7 days, 40 files, sharing, playlists and history per decisions 3/4/7
  Private bucket `music_uploads`; objects `<uid>/<upload_id>/audio.<ext>` and `cover.jpg` (client-resized ≤ 1200 px, EXIF stripped, ≤ 2 MB). Client uploads with its own session into its own prefix; `register_music_upload` (SECURITY DEFINER) verifies the object exists, MIME/extension, size, per-user caps, sets `expires_at = now() + interval '48 hours'`; a server step sniffs the first bytes (ID3/fLaC/OggS/RIFF/ftyp) before registering and deletes the object if it fails. Playback path via RPC only while `state='active'` and `expires_at > now()`; server signs a URL with TTL = `min(3600 s, remaining life)`. Expiry does **not** depend on the cron: reads are refused by RLS/storage policy at `expires_at`; the daily cron only reclaims space (Vercel schedule is daily, so deletion can lag up to ~24 h). Cleanup = extend the existing `cleanup-expired-rooms` route (same `CRON_SECRET`, no new cron entry) with `cleanupExpiredMusicUploads` + orphan sweep (objects never registered after 1 h) + retry state like `temporary_media_cleanup_jobs`. `prepare_account_deletion` also removes music uploads (storage first, then rows). Countdown ("expires in 31 h") in Library.
  Files: `supabase/migrations/…action16_music_uploads.sql`, `src/actions/music-uploads.ts`, `src/lib/music-cleanup.ts`, edit `src/app/api/internal/cleanup-expired-rooms/route.ts`, `src/lib/music-upload-validation.ts`, UI wiring.
  DB: table `music_uploads` (owner, bucket, object/cover path, name, mime, size, tags columns, lyrics text ≤ 20 k, `expires_at` with CHECK = `created_at + 48 h`, `state` active/delete_pending/deleted, cleanup attempts/error); storage policies (own-prefix INSERT with mime/size; SELECT only if a registered, active, unexpired row exists; no client UPDATE/DELETE); path helper `music_storage_path_owner(text)` with `search_path=''` and EXECUTE granted to `authenticated`; RPCs `register_music_upload`, `list_my_music_uploads`, `get_music_upload_playback_path`, `begin_music_upload_delete` / `complete_music_upload_delete`, `list_music_uploads_due_for_cleanup` (service role only).
  Tests/evidence (ledger "Action 16.5"): dry run in a rolled-back transaction as `authenticated` + `anon` (other user's read/write/list refused 42501; expired object unreadable though still present; cap violations; forced failure leaves no row); `music-probe.mjs` live (owner A, user B, anon: upload → register → play path → expiry forced by shifting `expires_at` in a disposable row → read refused → cleanup removes object and row; orphan swept; signed URL TTL ≤ remaining); `tests/music-uploads-contract.test.ts` (migration contract: RLS, grants, search_path, 48 h CHECK, no public bucket, cleanup ordering storage-before-row, account-deletion order); browser: upload, play, countdown, delete, expiry.
  Model: **Opus 5.5, high** (RLS, storage policies, definer RPCs, deletion ordering).

- [ ] **16.6 Provider connection framework + YouTube account.**
  Connect/disconnect UI (Settings → Connections), per-provider status, error/expired states. Google OAuth 2.0 authorization-code + PKCE + `state` through route handlers; scope `youtube.readonly` first; tokens encrypted (AES-256-GCM, versioned key) in a **server-only** table; list the user's YouTube playlists (read-only) as Library entries; disconnect = revoke at Google + delete row; revocation/expiry shown in the UI. Playback still goes through 16.3's embed. (Note: YouTube Music-only library items — uploads, albums, history — are **not** in the Data API; the connection exposes YouTube playlists and likes only.)
  Files: `src/app/api/music/oauth/[provider]/{start,callback}/route.ts`, `src/lib/music-oauth.ts`, `src/lib/music-crypto.ts`, `src/actions/music-connections.ts`, `src/components/music/ConnectionsPanel.tsx`, `.env.example` placeholders.
  DB (`…action16_music_provider_connections.sql`): `music_provider_connections` (user, provider enum, provider account id, display name, scopes, `token_ciphertext`, `refresh_ciphertext`, `key_version`, `expires_at`, status, timestamps, UNIQUE(user, provider)); `music_oauth_states` (state, user, provider, verifier ciphertext, `expires_at` 10 min). Both: RLS on, `REVOKE ALL` from `PUBLIC`/`anon`/`authenticated`, **no policies**; read only by the service role. Client RPC `get_my_music_connections()` (definer, `search_path=''`) returns provider/status/display name/scopes only. `prepare_account_deletion` also deletes connections. Cleanup of expired OAuth states.
  Tests/evidence: dry run as `authenticated`/`anon`: direct SELECT on both tables fails 42501; RPC returns no token columns; `tests/music-oauth.test.ts` (state mismatch/expiry rejected, PKCE verifier, redirect allow-list, token never in any response/log); static grep that no `*_ciphertext`/token name appears under `src/components` or client modules; live probe with a Google test user (consent screen in *Testing*: refresh tokens expire in 7 days; production needs OAuth verification).
  Model: **Opus 5.5, high** (token custody, OAuth, definer RPC).

- [ ] **16.7 Spotify (gated).** Web Playback SDK for Premium listeners; PKCE; reuses 16.6 framework; short-lived access token handed to the SDK on demand via a no-store route (never the refresh token, never persisted client-side). Dev Mode caps: 5 users + Premium developer account; document an allow-list gate in the UI. Tests: probe that refresh token is never returned; unavailable/not-Premium states. Model: Sonnet 5.5, high.
- [ ] **16.8 Apple Music (gated on a paid Apple Developer account).** Developer token (JWT) signed server-side per request/short TTL, MusicKit JS in the browser, Music User Token handled by MusicKit only; subscription-required state; Apple branding rules. Model: Sonnet 5.5, high.
- [ ] **16.9 TIDAL (gated on access approval).** Official TIDAL SDK for Web (auth + Player components); 16.6 storage for tokens if server-side calls are needed. Model: Sonnet 5.5, high.
- [ ] **16.10 Qobuz — BLOCKED.** No compliant path (partner-only API; unofficial credentials revoked in the past). Do **not** use unofficial credentials or scraping. Ship a "not available" provider card; revisit only if Qobuz grants partner access.

- [ ] **16.11 Room / group sync.** Uploads part done in Stage 3 (uncommitted): Listen Together for shared uploads in rooms and groups, server-owned state in `music_listen_sessions` pushed with `realtime.send` to private `music_listen_<room|group>_<id>` (no client publishing), plus friends-only "Listening to …". YouTube `cast` path and the `StudyMusicCard` entry still wait for 16.3.
  Rooms: a YouTube track is shared by broadcasting the existing `cast` event with its watch URL (no DB or realtime change; each member's own embed plays it, subject to the same visibility/gesture rules; "Join & play" button). `StudyMusicCard` gets "from My Music" (YouTube tracks only). Uploads are **not** shared (decision 4) unless you approve copying into the room's 24 h temporary-media pipeline with explicit consent. Groups (Action 14/15): private broadcast topic `music_group_<group_id>` with a `realtime.messages` SELECT policy; topic validated and uuid-cast **inside** a SECURITY DEFINER helper (never cast topic text inside a policy); `{trackRef, positionMs, anchorMs, isPlaying, seq}` state, ignore any `seq` not greater than the last applied; reuse `expectedPosition` maths.
  Files: `src/hooks/useMusicGroupSync.ts`, `src/lib/music-sync.ts`, `…action16_music_sync_channels.sql`, `StudyExtras.tsx` entry.
  DB: helper `can_use_music_group_topic(text)` (definer, `search_path=''`, EXECUTE → `authenticated`), `realtime.messages` policy for `music_group_` topics.
  Tests/evidence: dry run **as `authenticated`** (member allowed, non-member/removed/blocked/anon refused; malformed topic returns false, never raises); live private-channel delivery/refusal probe (extend `music-probe.mjs`); `tests/music-sync.test.ts` (seq ordering, anchor maths); two-tab browser run; `public` channel join must fail ("PrivateOnly").
  Model: **Opus 5.5, high** (realtime authorization).

- [x] **16.12 Verification and ledger.** Done 2026-11-06 (ledger "Action 16.13 (part) + 16.12"): 12 probes 469/469, music-probe 87/87, 173 tests, lint baseline, build, 390/1440 sweep. Per task above plus a final regression: re-run all existing probes (authorization, lifecycle, site-owner, notification, messaging, workspace, media, watch, collab, management, conversion, conversations) as `authenticated`/anon — 0 fail; `npm run test:unit`, `npm run lint` (no new errors), `next build`; browser at 1440/390; write the ledger "Action 16" section and tick this file with hashes. Model: Sonnet 5.5, medium.

## Later stage: song info and lyrics sources (added 2026-11-05; deferred, owner starts it)

Source terms below are from general knowledge, NOT re-verified on 2026-11-05: check each provider's current terms before building.

| Need | Source | Rules / notes |
| --- | --- | --- |
| Uploads: title, artist, album, year, artwork, embedded lyrics | Embedded tags via `music-metadata` (browser) | Free, no legal issue. Already in 16.4. |
| Missing metadata (album, track no., ISRC, year) | MusicBrainz | Free/open; about 1 req/s; meaningful `User-Agent` required; server route + cache; fixed host only (no SSRF). |
| Artwork | Cover Art Archive (by MusicBrainz id) | Free; images keep their own licences: display as cover art only, never redistribute; client-resize and strip EXIF if stored. |
| YouTube tracks | YouTube Data API v3 fields only (title, channel, thumbnail, duration) | Official only; ≤ 30-day cache; no lyrics (caption download works only for videos you own). |
| Spotify / Apple / TIDAL tracks | Each provider's official API | Added with their provider task (16.7-16.9); Apple Music API can return lyrics for subscribed users. |
| Lyrics, safe default | Embedded USLT/SYLT tags + user-uploaded `.lrc` | Current scope (decision 3). |
| Lyrics, open | LRCLIB | Free, no key, synced; community data, copyright not cleared by them: grey area, owner decides before enabling. |
| Lyrics, licensed | Musixmatch (commercial plan; display requirements) | Best for a public product; costs money. Needs API key (server-only). |
| Lyrics, licensed (enterprise) | LyricFind | Only if OmniLume grows. |
| NEVER | Genius (API has no lyrics; scraping forbidden), scraping any lyrics site, BitChord-style spoofed-origin fetches | Out of scope permanently. |

- [x] **16.14 Custom sources (Stage 4, decision 9).** User-added manifest (`"omnilume": 1`, `name`, `search` with `{query}`, optional `health`), browser-only calls, owner-only `music_custom_sources` rows (≤ 10, https or localhost-only http, responsibility box), health check, owner-only playback (no `uploadId` → never shared, together, presence, history or playlists). Files: `…action16_music_custom_sources.sql`, `src/lib/music-sources.ts`, `src/hooks/useMusicSources.ts`, `src/components/music/MusicSources.tsx`, Settings + Search wiring. Evidence: dry run 31/31, `music-probe` 83/83, `tests/music-sources.test.ts`, browser (ledger "Action 16 Stage 4"). Commit `70a764a`.

- [ ] **16.13 Metadata + lyrics enrichment.** Part done (owner choice 2026-11-06, ledger "Action 16.13 (part) + 16.12"): "Fix Tags…" on an upload — `GET /api/music/metadata` (fixed MusicBrainz host, title + artist phrase query, 1 req/s per instance, one retry on 503; no cache table: shortcut), owner picks a match and presses Apply, optional Cover Art Archive artwork fetched and re-encoded in the browser, saved by `update_music_upload_tags` (migration `20261113100000`). Still open: cache/rate ledger table, ISRC lookup, lyrics providers (LRCLIB needs the owner's risk decision; Musixmatch needs a paid key).
  Server route `GET /api/music/metadata` (MusicBrainz lookup by ISRC, else title+artist+duration; Cover Art Archive artwork), cache table `music_metadata_cache` (service role only; RLS on, no client grants; TTL ≤ 30 days; rate ledger 1 req/s), "Fix tags" UI on an upload (user confirms before overwrite), lyrics provider interface `{name, enabled, fetch(track)}` with a per-user/owner setting; providers enabled one at a time (LRCLIB only after the owner accepts the risk; Musixmatch after a key and plan exist); synced-lyrics view reuses 16.4's `.lrc` renderer; provider attribution shown where required.
  Files: `src/app/api/music/metadata/route.ts`, `src/lib/music-metadata.ts` (server-only), `src/lib/music-lyrics-providers.ts`, `…action16_music_metadata_cache.sql`, UI in the upload detail view.
  Tests/evidence: `tests/music-metadata.test.ts` (ISRC/title match, malformed responses, host allow-list, rate limiter, text-only/length caps), dry run as `authenticated`/`anon` (cache not readable by clients), probe, browser at 1440/390.
  Model: Sonnet 5.5, medium (Musixmatch key handling: high).

## Security checklist (gate for every task)

- [ ] **Keys and tokens never reach the client.** `YOUTUBE_API_KEY`, `GOOGLE_OAUTH_CLIENT_SECRET`, `SPOTIFY_CLIENT_SECRET`, Apple MusicKit private key, `MUSIC_TOKEN_ENC_KEY` are server-only env (no `NEXT_PUBLIC_`), blank in `.env.example`, never logged, used only in route handlers/actions (verify the `server-only` import guard resolves in Next 16.3 before relying on it). Documented, minimal exceptions the vendors force: Spotify SDK needs a short-lived access token; Apple's developer token is public by design. Refresh tokens and client secrets are never sent to the browser.
- [ ] **RLS on every new table**; `REVOKE ALL … FROM PUBLIC, anon, authenticated` then explicit grants; service-role-only tables have RLS enabled and no policies.
- [ ] **Policy helpers need correct EXECUTE grants.** Any function used by a policy is executable by the role that queries the table. Every migration dry run runs a second pass as `authenticated` (`set_config('request.jwt.claims', …)` + `SET LOCAL ROLE authenticated`) and as `anon`, in a rolled-back transaction. (Lesson: the 25-minute rooms outage of 2026-11-05.)
- [ ] **SECURITY DEFINER RPCs hardened:** `SET search_path = ''`, schema-qualified names, `REVOKE ALL ON FUNCTION … FROM PUBLIC` then grant to the exact role, `auth.uid()` null → 42501, ownership checked inside, input validated (length, MIME, path regex), no dynamic SQL; internal-only functions (`…_due_for_cleanup`, quota ledger) executable by `service_role` only.
- [ ] **Storage:** bucket private; owner-prefix INSERT with MIME/size limits; SELECT only for registered, active, unexpired rows; no client UPDATE/DELETE; signed URL TTL ≤ min(1 h, remaining life); magic-byte sniff before registration.
- [ ] **Expiry independent of cron:** reads refused at `expires_at`; cron only reclaims space; cleanup idempotent with retry state; failures surface in the route's JSON (existing 207 pattern).
- [ ] **Cleanup jobs:** expired uploads, orphan objects (> 1 h unregistered), expired OAuth states, expired search-cache rows; storage removed **before** rows; account deletion removes music objects first.
- [ ] **Realtime private-only:** `{ config: { private: true } }` on every channel, a `realtime.messages` policy per topic, topic validated in a definer helper before any cast; refusal tested as a non-member.
- [ ] **Abuse and injection:** search `q` ≤ 100 chars, per-user rate limit, no server-side fetch of user-supplied URLs, text-only metadata (React-escaped, length-capped), lyrics ≤ 20 k chars.
- [ ] **Provider rules:** YouTube — player visible ≥ 200×200, nothing over it, no hidden/background or audio-only mode, no `noreferrer`, ToS + Google Privacy Policy links, API data cached ≤ 30 days, authorized data deleted on disconnect, one API project, quota ledger, no scraping/unofficial endpoints. Spotify/Apple/TIDAL — official SDK/API only, their branding/attribution. Qobuz — nothing until partner access.
- [ ] **No copied assets:** no BitChord code/CSS/names/logo, no SF Pro, no Apple/YouTube/Spotify logos beyond what each provider's brand rules require.

## Risks

1. **YouTube search quota.** Per Google's quota page (fetched 2026-11-05; re-check in Cloud console) `search.list` has its own bucket of **100 calls/day** (1 unit each) on a default project, separate from the 10 000-unit pool. That is ~100 searches/day for *all* users until a quota extension (compliance audit) is approved. Mitigation: cache, rate limit, Enter-to-search, early extension request. Expect "search busy" at scale.
2. **Visible-player rule** shapes the layout (video tile that cannot be hidden/covered) and makes "exactly like BitChord" impossible for the media area of YouTube tracks.
3. **Embeddability:** many tracks cannot play (embed disabled, age-gated, region, YouTube-Music-exclusive). Expect a visible share of "unavailable".
4. **Google OAuth verification:** `youtube.readonly` is a sensitive scope; in *Testing* mode refresh tokens expire after 7 days and users are capped; production needs app verification (weeks).
5. **Spotify:** Dev Mode = 5 users + Premium developer; Extended Quota is organisation-only (the 250 k-MAU figure comes from a secondary source). Realistically allow-listed users only.
6. **Apple/TIDAL:** paid membership / access approval not yet confirmed; both may slip.
7. **Look-alike exposure:** BitChord's design is a replica of Apple Music's web UI; reproducing it exactly shares that trade-dress risk. Mitigate with own logo/icons/copy, DM Sans, no Apple/YouTube branding implying affiliation. Not legal advice.
8. **Uploads and copyright:** users can upload copyrighted music. Mitigate: private, 48 h, single owner, attestation, no sharing in v1, takedown path via delete + cleanup.
9. **Storage limits:** the Action 09 bucket cap (50 MiB) excludes many hi-res FLACs; 48 h expiry bounds total storage. The Supabase plan's own file/total limits were not checked; confirm before raising caps.
10. **Cron granularity:** daily cleanup (Vercel schedule `0 0 * * *`) is why expiry is enforced by RLS, not by deletion.
11. **Autoplay/Media Session in the iframe:** the YouTube embed owns its own media session and needs a user gesture; sync "play" must be a button, not automatic.
12. **Unverified:** the roadmap PDF; live visual rendering of the BitChord web player (source/docs studied, not run); Spotify's 250 k figure; TIDAL access terms; `controls=0` + custom external controls is assumed acceptable under the documented player parameters (confirm during the 16.3 spike).

## Execution order and model

Order: **16.0 → 16.1 → 16.2 → 16.3 → 16.4 → 16.5 → 16.6 → 16.11 → 16.7 / 16.8 / 16.9 (as access arrives) → 16.12**, 16.10 stays blocked. (16.11 before the extra providers because it reuses the existing `cast` sync and needs no new provider.) Each task ends green (lint, tests, build) and is shippable on its own; 16.1–16.4 need no database change.

| Task | Model | Reasoning |
| --- | --- | --- |
| 16.1, 16.2, 16.4, 16.12 | Sonnet 5.5 | medium |
| 16.3, 16.7, 16.8, 16.9 | Sonnet 5.5 | high |
| 16.5, 16.6, 16.11 | **Opus 5.5** (security-critical) | high |
| Haiku 5.5 | not recommended (security-sensitive, large context) | — |

## Questions only the owner can answer

1. Accept **PARTIAL**: YouTube through the official embed with a visible video tile (no audio-only/background, no crossfade, no lyrics over the video)? Or drop YouTube and ship uploads + the other official providers?
2. Will you create the Google Cloud project/API key and file the **YouTube quota extension** (needed beyond ~100 searches/day)? OK to wait for OAuth verification before public use?
3. Accent: keep BitChord's red inside `/music`, or use OmniLume's purple? Follow the OS light/dark (BitChord behaviour) or dark-only?
4. Uploads: confirm 48 h fixed from upload, 20 files / 50 MB / 300 MB per user, and that uploads are never shared to rooms/groups (or approve explicit "share to room" through the 24 h pipeline).
5. Lyrics: embedded + `.lrc` only, or also an open lyrics provider (e.g. LRCLIB) despite licensing doubts?
6. OmniLume-native playlists and listening history: out of Action 16 (default), or in?
7. Providers: do you have/want an Apple Developer account (paid), Spotify app (5-user cap), TIDAL access, a Qobuz partner contact? Which of these should be dropped from Action 16?
8. Playback scope: stop on leaving `/music` (default) or build a global mini-player (root provider)?
9. New dependency: `music-metadata` (lazy, browser build) for tag parsing: OK?
