# Action 16 — BitChord teardown (reference, not code)

Read-only study for Action 16 Phase A. Nothing from BitChord is copied or ported:
this file records *facts and measurements* in our own words and tables. Our UI is
written from scratch in OmniLume's stack (see `docs/action-16-plan.md`).

**Source studied:** `github.com/kushagrasinghx/BitChord`, `--depth 1` clone at
`b690dc1` (merge of v1.8.2, 2026-10-30), kept in the session scratchpad (outside
the project). No script, install or build tool was run in it. Also read: GitHub
issue list (25 newest), the project landing page (`bitchord.kushagrasingh.in`,
text only). **Not done:** the web player was not executed or screenshotted; the
Android/TV/WearOS UIs were not studied (only the Android build file for stack).
Every value below comes from BitChord's own measurement report
(`web/docs/apple-music-dom.md`) and `web/app/src/styles/tokens.css`, which I
cross-checked against each other (they agree).

> **Key finding.** BitChord is a multi-platform *Apple Music-lookalike* client for
> YouTube Music. The web player (`web/`) copies Apple Music's web "Liquid Glass"
> design measurement-for-measurement, and plays YouTube by **impersonating
> YouTube's own clients** (unofficial InnerTube + BotGuard tokens + direct
> stream extraction + header spoofing). That playback method is not available to
> OmniLume (see §6 and the verdict in the plan).

---

## 1. Stack and versions

Repo layout: `app/` Android (Kotlin), `shared/` + `sharedUi/` Kotlin Multiplatform,
`tv/`, `wearos/`, `native/`, `backend/` (Go), `web/` (the part relevant to us).

**Web player (`web/app`, `@bitchord/app`):**

| Concern | Choice (version) |
| --- | --- |
| Framework | React 19.3.1, React Router 8.4 (SPA, all pages `React.lazy`) |
| Build | Vite 8.3.4, TypeScript 7.0.2, pnpm workspace, Cloudflare Pages |
| Styling | Tailwind CSS 4.3.3 (`@tailwindcss/vite`), one hand-written token file, no preflight, `--spacing: 4px` |
| State | Zustand 5.0.15 (player, ui, video); TanStack Query 5.104 (server data) + `react-virtual` 3.14 |
| Audio engine | Two `<audio>` elements ("decks") fed by Shaka Player 4.16 (DASH/SABR); Web Audio for EQ/automix; HLS via hls.js 1.6 |
| YouTube access | `youtubei.js` 18.1 (unofficial InnerTube), `googlevideo` 4.1 (SABR), `bgutils-js` 4.0 (BotGuard PO tokens) |
| Automix | `essentia.js` 0.1.3 (AGPL), `onnxruntime-web` 1.30, `signalsmith-stretch` 1.3, `idb` 8 |
| Lyrics | `@uimaxbai/am-lyrics` 1.8.2 (MPL-2.0 web component) + ~15 provider fetchers |
| Icons | `lucide-react` 1.57, `react-icons` 5.7, own SVG sets |
| Fonts | DM Sans (Google Fonts) + bundled *SF Pro Display* woff2 for lyrics |
| Companion | Manifest-V3 browser extension (WXT), Chromium + Firefox |
| Server | Go "Listen Together" WebSocket party server (in-memory, no DB), Caddy/Render |

Android app: Kotlin, Jetpack Compose (BOM 2024.12.01) + Material 3, Media3
ExoPlayer 1.11.0, Coil 3.0.4, Haze (frosted glass), **NewPipeExtractor v0.26.3**
and "InnerTubeX" for stream resolution.

**OmniLume today:** Next.js 16.3.3 (App Router, `src/proxy.ts`), React 19.2.8,
Tailwind 4.3.3 imported into a large hand-written `globals.css`, `react-player`
3.4 (already installed), Supabase JS 2.112, no Zustand, no TanStack Query, no
router library. Same Tailwind major and React 19 line, so the *visual* port is
natural; the app/state architecture differs (App Router, server actions/route
handlers, Supabase instead of Go server and extension).

## 2. File and component tree, and how it connects

```
web/app/src/
  main.tsx, routes.tsx, pageRegistry.tsx   lazy pages + per-page skeleton + preloadRoute on hover/focus
  shell/      AppShell, Sidebar, MobileTopBar, PlayerBar, Lcd, VolumeControl, SidePanel,
              UpNext, LyricsPanel, FullScreenPlayer, MeshBackdrop, Banner, useKeyboardShortcuts,
              useScrubber, wheelVolume, NerdStats, VideoQuality, LyricsSettings
  pages/      Home, New, Search, Album, Artist, Playlist, Browse, Library, Spotify,
              SpotifyPlaylist, Settings, ListenTogether, Extension, Debug, NotFound
  components/ music/{Artwork, MotionArtwork, Lockups, ShelfView, TrackList, TrackMenu,
              DetailHeader, CategoryTiles, SearchField, States, ExplicitBadge, FavoriteButton}
              + Menu, Select, Skeleton, PageHeader, PrefetchLink, icons/
  state/      player.ts (~1100 lines: queue, index, status, volume, shuffle, repeat, autoplay,
              crossfade, media session), ui.ts (side panel, full screen, banner), video.ts
  playback/   youtube/{resolver, innertube, engine, ShakaPlayerAdapter, botguard, videoDeck},
              queue/{timeline, builder}, automix/, discordPresence, historyReporting, livePresence
  data/       music/{api, queries, mappers, library, types}, apple/ (artist art, motion art),
              spotify/, match/trackMatcher
  lyrics/     providers, repository (parallel race), parse (TTML/LRC), clock, settings
  party/      listenTogether, partySync, clock, invite
  extension/  bridge hooks (useExtension, useYtAuth, useSpotifyAuth, useDiscord)
  styles/     tokens.css (design tokens), global.css (Tailwind theme + utilities)
```

Wiring: `AppShell` renders `Sidebar` + `MobileTopBar` + a scrolling `<main>` with
the routed page + the floating `PlayerBar` + `SidePanel` (+ optional bottom
`Banner`, lazy `FullScreenPlayer`). Pages fetch through TanStack Query hooks in
`data/music/queries.ts` → `api.ts` (InnerTube calls via the YouTube.js instance,
anonymous or "signed" through the extension) → `mappers.ts` into app types. Every
control reads/writes the single `usePlayer` store, which owns the queue and two
`YouTubeEngine` decks. Mobile browsers get a banner pointing at the Android app
(the web build needs the extension).

## 3. Visual system (exact values)

All values were measured by BitChord on Apple Music's web player (dark, 1440×900)
and re-expressed as tokens. Light/dark follow `prefers-color-scheme`; increased
contrast drops translucency. DM Sans replaces SF everywhere; Apple's type *scale*
is kept.

**Layout grid**
- Shell: sidebar 260px (`33.884vw` at 484–767px; hidden under 484px → 52px glass top bar + 52px mini-player); the **whole content column scrolls** under a fixed sidebar and floating player; page bottom padding = pill 56 + offset 20 + 40.
- Body gutter 25px (<1000px) / 40px (≥1000px). Section padding-top 12px. Page title h1 34/40 700, margin 0 gutter, padding-top 32px.
- Breakpoints: 484 (phone → drawer), 767.32 (sidebar 260), 1000 (gutter 40, shelf arrows), 1260 (medium), 1580 (large), 1940 (xlarge). Full-screen lyrics steps at 980/1320/1680/2000/2561.
- Shelf columns (xs/S/M/L/XL): square 144px / 4·5·6·6; track lockup (4 rows; 3 in search) 270px / 2·3·4·4; horizontal 298px / 2·3·4·4; video 200px / 3·4·5·5; artists 6·8·10·10; editorial hero 298px / 2·2·3·3. Shelf = horizontal grid, `scroll-snap-type: x mandatory`, hidden scrollbar, gaps 20px col / 24px row, `15px` hover-shadow padding.

**Colour tokens (light / dark)**
- `pageBG` `#ffffff` / `#1f1f1f`; text primary `#000000e0` / `#ffffffeb`; secondary `#0000008f` / `#ffffffa3`; tertiary `#0000007a` / `#ffffff66`; quaternary `#0000001a` / `#ffffff1a`; quinary `#0000000d` / `#ffffff0d`.
- Key (accent) `#d60017` / `#fa586a`; key background (filled) `#d60017` / `#fa233b`; selected row `#d60017` / `#c11b2e`; focus ring `4px` key at 60%.
- Glass: sidebar/pill/side panel `#f5f5f78c` / `#26262899` + `backdrop-filter: saturate(2.2) blur(16px)`; thin material (arrows, platter buttons) `#f6f6f67a` / `#28282880` + `saturate(180%) blur(60px)`; thick material (context menus) `#f6f6f6b8` / `#282828b3`; sticky header `#ffffffcc` / `#1e1e1ecc`; glass shadow `0 10px 40px` `#0000001a` / `#00000033`.
- Dividers 0.5px: `#00000026` / `#ffffff1a`; menu separators `#3c3c434a` / `#ebebf530`. Row hover `#0000000f` / `#ffffff0f`; nav selected `#3c3c431a` / `#ffffff0d`; artwork hover scrim `#3333334d`; modal scrim `#00000073`; destructive `#ff3b30`; alt-section bg `#f2f2f2` / `#2b2b2b`; footer `#fbfbfb` / `#323232`; search border `#00000026` / `#ffffff26`.
- Play/Shuffle pill: white bg + black text (dark) / black bg + white text (light). Now-playing backdrop base `#878787`.

**Typography** (`font: weight size/line`): page title 700 34/40; album title 700 26/32; section header 700 17/22; Play pill / Clear 600 15/20; body 400 13/16 (emphasised 600; tall 13/18); sidebar item 400 14/20; callout (lockups, list) 400 12/15; eyebrow/MORE 600 11/14; badge 500 10/13. Letter-spacing normal. Lyrics 28 → 38 → 50 → 72px with the breakpoints above, ~1.2 line height, current line scale 1.05, secondary vocals ×0.54.

**Radii:** artwork 5px (40px rows) / 7px (square lockups) / 10px (album header, hero cards, tiles) / 50% (artists); nav item 8px; track row 6px (12px on playlist rows); pill and search field 1000px; search-suggestion panel 9px; modal 14px.

**Elevation / glass details**
- Player pill: `::before` glass fill + shadow, `::after` four inset 0.5px strokes (dark at 25% alpha, light 5%). Artwork carries the same 0.5px inner stroke (dark 25%, light 10%).
- Album header artwork 270×270, radius 10px, `0 10px 20px` radiosity shadow, plus a blurred (20px, saturate 2, 30% opacity, scale .88) copy behind it as glow.
- Panels overlay content (no reflow); only the pill re-centres. Page tint: album/playlist pages recolour the page background and label colours from the artwork's dominant colour (dark or light layout by luminance).

**Motion:** global fade `.1s ease-in`; panel slide / pill re-centre `.3s cubic-bezier(.215,.61,.355,1)`; shelf arrows `.25s linear`; menu in `.12s` from scale .97; modal fade+zoom `.2s`; skeleton shimmer 1.6s; label morph `.32s`; mesh backdrop = artwork averaged into a 4×4 grid, drifting radial blobs on a 64×40 canvas ≤30fps, stops when paused/reduced-motion. `prefers-reduced-motion` respected.

**Icons:** custom transport glyphs 24–28px (shuffle, back, play/pause, forward, repeat/repeat-one), nav icons 24px, lyrics/up-next 18px; icon set is BitChord's own SVG + Lucide/React-Icons (we use our own).

**z-index:** 1 default · 50 bubbles · 1001 gpu · 9901 chrome · 9951 menus · 10001 modal.

## 4. Screens and states

- **Shell:** glass sidebar (logo, primary nav, Library group with Edit link, Playlists group, account/sign-in at bottom), floating pill, optional bottom banner (full-width key-colour band, 2-line message + white pill button; used for "install extension" / "get the app"), phone top bar + mini-player.
- **Player pill (668×56, grid 184 | 427 | 57):** shuffle · back · play/pause · next · repeat (off → all → one; on = key colour); LCD (34px artwork radius 6px with expand overlay, title 13/16 600 with marquee, subtitle 12/15 500 "Artist — Album", 2px progress line with times on hover; empty state = centred app glyph); actions: favourite, track menu, lyrics, up-next, volume (slider on hover; actions fade while volume is open).
- **Full-screen player:** modal over `#00000073`, grid `461px 576px` at 1440 (artwork 461², radius 10px, glow; title, artist, progress, transport 315×52, volume), lyrics column right with vertical fade mask `transparent → #000 80px → #000 50% → transparent`, current line at 30% down, animated mesh backdrop, close ✕ top-left.
- **Up Next panel (300px right, 0.3s slide):** header "Up Next" + "Clear"; rows 264×55 (40px art, title/subtitle, duration swaps for ⋯ on hover, remove ✕ on art), drag to reorder, "Playing from …", autoplay section + ∞ toggle.
- **Lyrics panel:** current line at 15% of height; translate button; empty state ("No lyrics available" + one-line explanation); Spotify Canvas looping behind (dimmed, muted).
- **Home:** shelves (hero, square lockups, track lockups, horizontal lockups, videos, artists) with arrows; powerswoosh 3:4 cards when signed in (260×347, 46px blurred chin).
- **Search:** landing = category brick grid (4 cols @1440, 256×144, r10); results page = sticky scope bar (62px) with centred 492×38 pill field; suggestions dropdown (302px, glass, 23px text rows / 46px lockup rows, hover = key bg); Top Results (3 cols, 118px cards) then shelves Artists/Albums/Songs/Playlists/Stations/Videos.
- **Library** (sections: history, artists, albums, songs, mixed-for-you, playlists), **Album/Playlist** (270px artwork header + Play/Shuffle pills 36px high r24 + ⋯ + description with MORE; table rows 46px/54px; footer line "date / n songs, m minutes"; "More by…" alternate-bg shelves), **Artist** (604px hero with tint + blur mask, 56px play circle, Top Songs grid, shelves), **Browse**, **New**, **Settings**, **Listen Together**, **Extension**, **Spotify**, **Debug**, **Not found**.
- **States:** skeleton per page (shimmer), `EmptyState` (title + detail), `LoadError` (message + "Try Again" key pill), `LoadMoreError` (inline "Couldn't load more. Try Again"), `NeedsExtension` invitation, age-restricted / unplayable messages, no-lyrics, matching/dimmed rows (Spotify import), context menus (185px min width), modals (scrim, r14, 30px close), focus rings on `:focus-visible` only.

## 5. Player behaviour

- **Queue (3 tiers):** `context` (the album/playlist/list started), `user` (Play Next at head, Add to Queue at tail), `autoplay` (radio appended when <3 left and repeat off; ≤10 per batch, max 2 per artist, dedup by title+artist, prefers catalogue song over video). Start-a-list keeps earlier tracks behind and the user queue right after. Up Next tap: context row = seek; hand-queued row drops bypassed ones; autoplay row becomes new context. Clear removes only upcoming hand-queued. Shuffle leaves the user queue alone, shuffles context and autoplay separately, restores order when turned off, leads with the picked track.
- **Repeat:** off → all → one; repeat-all prunes already-played hand-queued tracks. **Back** restarts the track after 10 s, else previous.
- **Seek/volume:** LCD progress line seeks on press/drag; ⌘/Ctrl+↑↓ ±0.1; wheel over speaker adjusts volume; mute on click. Persisted in `localStorage` (`bitchord:player`): shuffle, repeat, autoplay, volume, mute, crossfade (off/3/6/9/12 s, equal-power cos/sin on the second deck).
- **Keyboard:** Space play/pause (ignored on focused button/link/slider), ⌘/Ctrl+→/← next/previous, ⌘/Ctrl+↑/↓ volume, ⌘/Ctrl+F or `/` focus search, Esc closes full screen then side panel; all ignored while typing in an input.
- **Media Session:** metadata, play/pause state, previous/next handlers, position state (only the front tab).
- **Other:** Automix (DJ transitions from beat analysis), play history reporting to YouTube, "listening now" presence, Discord Rich Presence, Listen Together (code-based party: server holds `positionMs` + server-clock anchor, clients measure clock offset, 350 ms scheduled lead, 5 s state heartbeat, queue delta frames, ≤5 devices).

## 6. HOW BITCHORD PLAYS YOUTUBE MUSIC

**Not the official IFrame Player API. Not the YouTube Data API.** It is an
unofficial, reverse-engineered pipeline:

1. **InnerTube (private YouTube API) via `youtubei.js`** for search, browse, album/artist/playlist pages, `next` (radio/autoplay), `player` (stream info), library and likes. Fixtures in `web/fixtures/innertube/` are real captured private-API responses.
2. **Client impersonation.** Requests are made as YouTube's own clients, in order `VISIONOS → YTMUSIC (WEB_REMIX) → WEB → MWEB`; a refusing client is skipped for 10 minutes.
3. **Stream extraction.** The `player` response carries direct `googlevideo.com` audio URLs (Opus itag 251 / AAC 140). `youtubei.js` deciphers the signature and `n` parameters by running YouTube's player JS (`new Function` → needs `'unsafe-eval'` in CSP). Shaka fetches by byte range into an `<audio>` element. A SABR (server-driven ABR) adapter is the fallback.
4. **BotGuard / PO tokens (`bgutils-js`).** It runs YouTube's BotGuard attestation in the page to mint "proof-of-origin" tokens bound to visitor data and video id, i.e. it imitates a genuine YouTube web client to defeat anti-bot checks.
5. **Browser extension as a CORS/header spoofer.** `declarativeNetRequest` rules rewrite `Origin`, `Referer`, `X-Origin` to `https://www.youtube.com`/`music.youtube.com` on `youtubei`, `googlevideo`, `ggpht`, `ytimg` requests and inject permissive CORS response headers, so the page can read responses YouTube would normally block. A background worker proxies requests that need forbidden headers.
6. **Signed-in mode.** The extension reads the user's browser Google cookies and signs InnerTube calls with a computed `SAPISIDHASH` (cookies never reach the page). Used for the personal home feed, library, likes, playlist writes and age-restricted tracks.
7. **Hidden audio only.** The video is never shown; audio plays in an `<audio>` element (so it plays in the background, crossfades, loops, is analysed for automix and exposed to Media Session).
8. **Metadata, artwork, lyrics.** Titles/artwork from InnerTube responses; artwork colours extracted on the client; "motion artwork" and artist art are scraped from Apple Music pages; lyrics race ~15 sources (lrc.red, LRCLIB, KuGou, Musixmatch, Genius, PaxSenix/Apple, YouTube Music lyrics tab…), some through the extension with spoofed origins; word-synced rendering by am-lyrics.
9. **Playlists:** library/likes/add-to-playlist via private InnerTube endpoints (`like/like`, `browse/edit_playlist`, `playlist/create`).
10. **Keys/backend:** no API keys for YouTube; the only backend is the optional Go party server. Spotify is accessed through the web-player's internal Pathfinder GraphQL using a self-minted TOTP token from the user's `sp_dc` cookie; Discord via the user's account token (BitChord's own UI warns this is against Discord's terms).

**Compliance reading:** this violates YouTube's Terms of Service and the API Services
Developer Policies (separating audio from video, background player, scraping/using
non-API access, circumventing protections). It is also fragile (BitChord's own
notes record streams cutting off at ~70 s, PO tokens being rejected, and the
reference client no longer starting playback). **None of it may be used by OmniLume.**

## 7. Third-party dependencies and what they do

`youtubei.js` (private YouTube API client), `googlevideo` (SABR protocol),
`bgutils-js` (BotGuard tokens), `shaka-player` (adaptive streaming), `hls.js`,
`essentia.js` + `onnxruntime-web` + `signalsmith-stretch` (beat analysis, vocal
masking, time-stretch for Automix), `idb` (IndexedDB cache), `am-lyrics`
(synced-lyrics renderer), `zustand`, `@tanstack/react-query`, `react-virtual`,
`react-router`, `lucide-react`, `react-icons`; extension: WXT; backend: a small
Go WebSocket service (not inspected in depth). Android: NewPipeExtractor, Media3, Haze, Coil.
Bundled assets: SF Pro Display woff2 (Apple proprietary), ONNX models, logos.
**We reuse none of these** (assets included). We already have `react-player`.

## 8. Licence

- **GPL-3.0** (root `LICENSE`). Copying or deriving *code* would force OmniLume to
  be GPL-3.0 and publish source. We copy nothing, so no obligation arises, and no
  attribution is required for the *look* (design measurements/ideas are not
  copyrightable expression; do not copy `tokens.css` or CSS verbatim: write our own
  names and rules).
- Mixed-licence files inside: Automix (AGPL-3.0, own `LICENSE`/`NOTICE.md`),
  am-lyrics (MPL-2.0), essentia.js (AGPL-3.0). Do not pull any of it in.
- **Assets not to reuse:** BitChord name/logo/Banner, bundled **SF Pro Display**
  (Apple proprietary font), icons, copy text.
- **Trademark / third-party issues:** the BitChord *look* is a replica of **Apple
  Music's web UI** (the landing page itself discloses that artwork/titles come from
  Apple Music pages). Reproducing it exactly carries the same design/trade-dress
  exposure BitChord has; use our own logo, icons and wording, DM Sans (OFL) rather
  than SF, no "Apple Music"/"YouTube Music" branding implying affiliation, and
  honour each provider's branding rules (YouTube, Spotify, Apple, TIDAL). This is
  an engineering risk note, not legal advice.
