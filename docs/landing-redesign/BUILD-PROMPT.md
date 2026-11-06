# Build prompt: make the website look and feel like the full-experience video

Use with: Opus 5.5, high effort. Paste everything below the line.

---

You are rebuilding the OmniLume website (landing page and signed-in app) so it looks and moves exactly like the approved concept video. Read `AGENTS.md` first: this is not the Next.js you know, so read the relevant guide in `node_modules/next/dist/docs/` before writing code.

## Source of truth

- Video: `docs/landing-redesign/full-experience-video.mp4` (2:01, 60fps). Landing 0:00–0:56, app 0:58–2:00.
- The video is rendered from real HTML/CSS/JS. Treat these as the exact spec (colors, blur, radii, easing, timings, layout):
  - `docs/landing-redesign/video-source/landing5.html` + `landing5.js` (landing; `REVEAL`, `HOLDS` and the hover/press code show the motion)
  - `docs/landing-redesign/video-source/app5.html` (signed-in app: Home, room desk, Explore, Messages, Music, Create room, Profile)
  - Logo: `docs/landing-redesign/logo/` (ring = room, white dot = friend joining)
  - Older context: `docs/landing-redesign-plan.md`. Where it disagrees with the video sources, the video sources win.
- To compare, render any video state to a PNG: open the HTML in Playwright at 1440×900, call `window.render(t)`, screenshot. Use that as your reference still for every screen you build. (`landing5.html` loads its app screenshots from a `shots2/` folder that is not in the repo; those regions can show a missing image, so take the app reference from `app5.html` instead.)

## What must be true

1. **Same look.** Purple and soft black (never pure black), frosted purple glass (`backdrop-filter: blur(30px) saturate(170%)` with the translucent tint and white sheen from the sources, not too transparent), the lighter glass dock, gradient buttons, the sliding tab highlight, ambient purple light and grain behind the page, the new logo in the nav, footer, favicon and the loading/intro state.
2. **Same content.** Landing text and section order are exactly those in `landing5.html`. Do not rewrite copy. Internal pages keep every feature, route, server action, query, realtime channel and permission they have today.
3. **Every room window resizable and movable.** The room is a desk of windows (chat, media, members, files, notes, timer, etc.) that can be dragged, resized from edges and corners, brought to front, and tiled/snapped as in the video, with a draggable divider where tiles meet. Keep all existing room behavior working inside the windows. Positions may persist per user only if it needs no schema change; otherwise keep them in local state or localStorage.
4. **Smooth, never laggy.** Target a steady 60fps on a mid-range laptop and no jank on mid-range phones:
   - Animate only `transform`, `opacity` (and CSS `translate`/`scale`). No animating width/height/top/left/blur radius. While dragging or resizing use `translate3d` and write size/position once per `requestAnimationFrame`; commit to React state on pointer-up, not on every move.
   - Pointer-light and hover easing driven by one rAF loop or CSS variables, no React re-render per mouse move.
   - Scroll reveals with `IntersectionObserver`, not scroll listeners. Reveals run once.
   - Budget `backdrop-filter`: only on surfaces that sit over something worth blurring, never on long lists or per row. Blur drops to ~12px with a solid tinted fallback on small screens and under `@supports not (backdrop-filter: blur(1px))`. Use `will-change` only on elements while they animate.
   - No layout shift (CLS < 0.05). Fixed sizes for images, fonts already loaded (Geist). No client JS where a server component works; only the interactive desk and effects are `'use client'`.
   - Respect `prefers-reduced-motion` (no entrance/loop motion, no snap animation).
   - Keyboard and a11y stay intact: focus rings, `aria-pressed` on toggles, title-bar handles movable and resizable with arrow keys, contrast AA.
5. **No regressions, no mistakes.** Nothing in auth, RLS, Supabase policies, migrations, realtime (`private:true` + topic policies) or server actions changes. Restyle and re-layout only. Landing styles go in a CSS Module (Next keeps page-imported global CSS after navigation); app styles via tokens, not copy-pasted per page.

## How to work

- Branch `feat/website-redesign` from `main`. One commit per phase, each leaving `npm run lint`, `npm run build` and `npm run test:unit` green:
  1. Tokens, ambient background, glass primitives, logo (replace everywhere incl. favicon)
  2. Landing page (nav, hero window preview, feature cards, AI section, "What else", community, footer, scroll reveals)
  3. App shell: dock, top bar, Home
  4. Room desk: drag, resize, tile/snap, divider, bring-to-front, plus pure window-math helpers with unit tests (clamp, snap, resize min/max, tile)
  5. Explore, Messages, Music, Create room, Profile/account
  6. Polish pass against the video, performance pass, cleanup of dead CSS (grep each rule for zero uses before deleting)
- Reuse existing components and helpers before adding new ones. No new dependency for drag/resize/animation; use Pointer Events, `setPointerCapture`, CSS.
- Do not touch pre-login screens (`/login`, `/forgot-password`, `/auth/update-password`) beyond tokens unless told to.

## Verification (required, report evidence, don't claim)

1. `npm run lint`, `npm run build`, `npm run test:unit` all pass.
2. Visual: for each screen/state in the video (every landing section; Home; room chat; room with tiled desk and a resized window; Explore; Messages; Music; Create room; Profile) take a Playwright screenshot at 1440×900 and 390×844 and compare to the reference still. Fix any difference you can see; list any you accepted and why.
3. Smoothness: with Playwright + a Chrome trace (or `PerformanceObserver` for long tasks and `requestAnimationFrame` deltas) record landing scroll, hover over glass, drag a window, resize a window, switch tabs. Report p95 frame time (≤ 16.7ms target) and long tasks (> 50ms). Fix and re-measure anything that fails. Also run with 4× CPU throttling and report.
4. Lighthouse on the landing: performance ≥ 90, CLS < 0.05, no a11y errors.
5. Behavior: with a real test account (ask me via the secret-request tool; never paste credentials in chat, code, logs or commits), walk the full flow: sign in, Home, create a room, chat in it, resize/tile windows, Explore, Messages, Music play, profile edit. Confirm each still works exactly as before and nothing logs console errors.
6. Keyboard-only pass: tab through the landing and a room; move and resize a window with the keyboard.
7. Reduced-motion and no-`backdrop-filter` fallback each checked once.
8. Screenshots containing account data stay out of the repo.

## Stop and ask me before

- Changing any copy, stats, the "Real screens / works today" claims, or AI "coming soon" wording.
- Adding a database column, migration, or new dependency.
- Anything that would alter auth, permissions or realtime.

## Final report

Per phase: commit hash, what changed, test output, the measured frame-time numbers, screenshots vs reference, what is not done, and any risk. Do not open a PR; I will ask for it.
