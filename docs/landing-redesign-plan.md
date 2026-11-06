# Landing page redesign plan

Status: **plan only, nothing built yet.** Mockups live in [`docs/landing-redesign/`](landing-redesign/). Open `mockup.html` in a browser to drag the windows and switch rooms.

## What was asked

- A very clean landing page with a glass look, dark theme, purple and soft black (not pitch black).
- A hero like Cursor's: a small desktop where visitors move windows and switch between threads, so they try OmniLume before signing up.
- Not Raycast's hero (command palette and dock). Raycast is only a reference for polish.
- **The internal UI (everything after login) does not change.**

## Scope

| In scope | Not touched |
| --- | --- |
| `src/app/page.tsx` (landing) | Every page on the app shell (`InternalTopbar` / `FloatingDock`): `/home`, `/room/*`, `/music/*`, `/messages`, `/profile`, `/settings`, `/explore`, `/create-room`, admin |
| `src/components/Navbar.tsx` (used only by the landing) | `.omni-button`, `.omni-internal`, `.ambient`, and the `--omni-*` tokens in `globals.css` (shared with the app) |
| `src/components/ui/OmniFooter.tsx` (used only by the landing) | `OmniLogo` (shared with `FloatingDock`, `InternalTopbar`, profile setup). See open question 2 |
| New `src/app/landing.module.css` and `src/components/landing/*` | `FlippingWords` (still used by `/create-room`) |

**How the internal UI stays untouched:** all new styles go in a CSS Module. Next 16 docs (`node_modules/next/dist/docs/01-app/01-getting-started/11-css.md`) warn that global CSS imported by a page is not removed when you navigate, which can cause conflicts. A module gives scoped class names, so nothing can leak into the app. No `--omni-*` token is edited.

## Research

### Raycast (dembrandt v0.39.2 + designmd `brunopetrovic/raycast`)

- Near-black canvas `#07080a`, surface ladder `#0d0d0d → #101111 → #121212`, hairline `#242728`
- No drop shadows. Depth comes from surface steps, 1px hairlines and an inset top highlight (`rgba(255,255,255,.2) 0 1px 1px inset`)
- Inter with `ss03` on everything, Geist Mono for meta and code; display 56–64px, body 14–18px, weights 400–500 (600 only on the display)
- Radius ladder 4 (keycaps) / 6 (rows) / 8 (buttons, inputs) / 10 (cards) / 16 (large mockups)
- A white primary button, never tinted. Saturated color only in illustrations, and a single hero gradient used once
- Ease-out curve `cubic-bezier(0.23, 1, 0.32, 1)`
- Raw extraction: `scratchpad/research/output/raycast.com/` (JSON + DESIGN.md). Dembrandt's auto spacing scale (1–12px) is noise from icon internals; the designmd file is the cleaner source.

**What we take:** the restraint. Quiet chrome, hairlines over shadows, a short type scale, mono for meta, and one ease-out curve.
**What we skip:** the command palette, the dock, the red stripe and the pure black canvas.

### Cursor hero

- Left-aligned headline, with the actions on the right of the same row
- A big rounded frame with a painting behind it, holding real app windows (agent list, chat, browser preview) with plausible data
- A thread list on the left switches the main pane, so it reads like the real product
- One quiet caption under the frame

**What we take:** a painted frame with real-looking app windows, a room list that works like Cursor's thread list, and windows you can drag.

## Audit of the current landing (unslop)

| Sign | Where |
| --- | --- |
| Gradient text and a purple glow on the headline | `.hero-title`, `.hero-title-accent` (globals.css:57–58) |
| Uppercase tracked eyebrow | `.hero-eyebrow` "Study · Connect · Create · Together" |
| Uppercase glowing flipping words | `FlippingWords` in the hero, `.flipping-words` text-shadow |
| Unverified stats | `50K+ learners`, `1M+ study hours`, `2K+ rooms`, `4.9/5` (page.tsx:64–68) |
| Radial purple washes and a blurred blob | `.omni-public` background, `.hero-stage::before/::after` |
| Floating cards drifting forever, tilted, scaling on hover | `.feature-float` + `feature-float-drift 8s infinite` |
| Looping pulse on a non-live preview | `.preview-progress span` `preview-pulse` |
| Glowing gradient orb as the logo mark | `.omni-logo-mark` conic gradient + box-shadow |
| A planned feature advertised as a card | "AI Assistant · Planned room companion" |
| Weight 650–700 headings, -0.085em tracking | `.hero-title`, `.stat-value`, `.feature-float-title` |
| Placeholder footer copy | "Community links are coming soon", "Privacy and terms are being prepared" |
| Decorative giant watermark | `.omni-footer-watermark` |

Verdict: heavy slop. Run the full process, but keep the sections and their order (hero → feature strip → footer) and keep the real brand lavender `#b9a8ff`.

## Direction

- **Product.** Shared online rooms where friends study, watch and listen together in real time, with chat beside them.
- **Character.** Warm, unhurried, together.
- **World.** A town at dusk, where every lit window is someone in a room. The purple comes from the evening sky, not from gradients on the chrome.
- **Moments.** (1) The hero desk: a painted dusk scene behind glass app windows with a live room in them. (2) Album art and the film still inside those windows.
- **Signature.** The live "here" marker: a 6px lavender dot plus a mono count (`● 7 here`). It appears only where presence is real: the room list, window title bars and avatars.

**About glass and purple** (unslop flags both as slop, and you asked for both): purple is the brand accent plus the painting, never a wash on cards. Glass appears only where something sits behind it: the demo windows over the painting, and the nav once you scroll. Glass over a flat background just looks grey.

## Landing tokens (scoped to `landing.module.css`)

| Role | Value |
| --- | --- |
| Deepest (footer) | `#110e18` |
| Page | `#17141f`, a violet-tinted soft black (the app's current `#050506` is near pure black) |
| Card | `#1e1a29` |
| Raised (secondary button, active row) | `#272233` |
| Hairline | `rgba(241,238,248,.08)`, strong `.14` |
| Text | `#f1eef8` / `#b3acc6` / `#8b849b` |
| Accent | `#b9a8ff` (existing brand) with ink text `#17141f`, contrast about 8.9:1 |
| Glass | `rgba(29,24,42,.56)` + `backdrop-filter: blur(22px) saturate(150%)` + hairline `.14` + `inset 0 1px 0 rgba(255,255,255,.07)` + `0 24px 56px rgba(10,7,18,.42)` |
| Fallback | `@supports not (backdrop-filter: blur(1px))` → `rgba(29,24,42,.94)` |
| Type | Geist 400/500 (already loaded in `layout.tsx`), Geist Mono for counts, times and meta. Hero 56/1.04, -0.03em. Mobile 38. Section titles 36. Body 15–18 |
| Radius | buttons 8–10, rows 8, cards 16, windows 14, frame 20 |
| Motion | `cubic-bezier(.22,1,.36,1)`; hover 150ms; window snap 450ms; one entrance fade and rise of 8px; nothing loops |

## Page structure

1. **Nav** (64px): logo · Explore, Rooms, About · "Sign in" as a text link · "Get started" button. It turns to glass once the page scrolls. On mobile it shows one menu button.
2. **Hero row**: headline on the left, "Rooms where friends study, watch and listen together". On the right, the lede plus **Get started** (lavender) and **Explore rooms** (raised).
3. **Hero desk** (1200×680 frame, painted dusk town):
   - **Main window** with a room list on the left ("Live now" and "Your rooms"). Clicking a room swaps the pane:
     - Friday film club: synced video, an "In sync" marker, room chat
     - Physics revision: shared focus timer, tasks, shared notes
     - Lo-fi focus: a listening room
   - **Listening together** window: album art, progress, listeners
   - **Messages** window: a private chat marked "End-to-end encrypted"
   - Caption: "Live preview. Drag a window, or pick another room"
4. **Feature cards** (Raycast extension-card style), replacing the 4-card grid. Heading: "There is a room for that." A Study / Watch / Music / Social tab pill slides a rail of 336×500 cards. Each card has its own tint, an icon tile, one line of copy and a live visual:
   - Study: Focus timer, Shared notes, Whiteboard, PDFs and files
   - Watch: Watch together, Voice
   - Music: Listen together, Your uploads
   - Social: Private messages, Friends
5. **AI section, planned** ("Meet your room companion"). Labelled `OmniLume AI · coming soon`, with "Planned feature. Not available yet" under it. It shows an AI chat window (chats sidebar, a request using the shared notes and a PDF, agent steps, flashcards) plus two small cards: Quick AI catch-up and the session planner. **Every line is marked as coming soon until the feature ships.**
6. **"What else can OmniLume do?"** A run-on paragraph of core features with one sentence lit at a time. A glass window over a stripe-art corner shows the lit feature (focus timer → whiteboard → shared notes), with a pill, a caption and "Learn more" underneath.
7. **"Find your people."** Explore and Create cards, then a drifting reel of real OmniLume screenshots with captions.
8. **Footer**: glass (`backdrop-filter: blur(28px)`) over animated diagonal light stripes. Five columns: Product, Core features, Coming soon, Account, OmniLume. The placeholder notes and the watermark are removed.

**Light stripes** (Raycast-style, purple): blurred diagonal bars with a lit segment drifting along each bar. Used behind the hero top, behind the end of the community section running under the glass footer, and in the corner art of section 6. Respect `prefers-reduced-motion` by freezing them.

Video walkthrough: `docs/landing-redesign/landing-redesign-video-v2.mp4`.

## Hero desk: interaction spec

- `page.tsx` stays a server component (it still reads `getCurrentAccount()` for the CTA link). Only `<HeroDesktop />` is `'use client'`.
- Dragging uses Pointer Events on the title bar, `setPointerCapture`, and `transform: translate3d` (not left/top) while dragging. Windows are clamped to the frame. Pressing a window brings it to the front. No drag library.
- Room switching is local state with static demo data. No Supabase calls and no auth, so it renders instantly for logged-out visitors.
- Keyboard: room rows are `<button aria-pressed>`. Each title bar is a focusable handle ("Move Music window"), and arrow keys move it 16px (Shift moves 64px).
- `prefers-reduced-motion` turns off the snap animation and the entrance.
- Below 768px there is no dragging. Windows stack, the room list becomes chips, and the Messages window is hidden.
- Positions are not saved. Each visit starts from the default layout.

## Roadmap

Each phase is one commit on a `feat/landing-redesign` branch. Recommended model and effort are listed per phase.

| # | Phase | Files | Done when | Model |
| --- | --- | --- | --- | --- |
| 0 | Answer the open questions below | — | Answers recorded here | — |
| 1 | Tokens and scope | new `src/app/landing.module.css`; `page.tsx` switched to module classes | Landing renders on the new ramp; `/home` and `/room/*` render exactly as before | Sonnet 5.5 · medium |
| 2 | Nav, hero copy and actions | `Navbar.tsx`, `page.tsx` | Gradient text, glow, eyebrow, FlippingWords and stats are gone from the landing; one primary and one secondary action | Sonnet 5.5 · medium |
| 3 | Hero desk (static) | new `src/components/landing/HeroDesktop.tsx`, `demo-data.ts` | Matches `01` and `02` mockups at 1440px; mobile matches `04` | Sonnet 5.5 · medium |
| 4 | Hero desk (interactive) | `HeroDesktop.tsx`, new `window-math.ts` + `tests/landing-window-math.test.ts` | Drag, bring to front, clamp, room switch and keyboard move all work; reduced motion respected; a clamp unit test passes in `npm run test:unit` | Sonnet 5.5 · high |
| 5 | Features and footer | `page.tsx`, `OmniFooter.tsx` | Matches `03`; the Music card is added; placeholder copy removed | Sonnet 5.5 · low |
| 6 | Background painting | `public/landing/dusk-town.avif`, `HeroDesktop.tsx` | Replaces the coded SVG stand-in; fixed size with `priority`, about 200 KB or less | Image tool (see prompt) |
| 7 | Cleanup | `globals.css` | Landing-only rules deleted (`.hero-*`, `.feature-float*`, `.preview-*`, `.public-feature-*`, `.public-nav*`, `.stat-*`, `.omni-footer*`), each grep-checked for zero uses first | Sonnet 5.5 · low |
| 8 | Check | — | unslop checklist; `npm run lint`, `npm run build`, `npm run test:unit`; keyboard pass; Lighthouse perf ≥ 90 and CLS < 0.05; internal pages screenshotted before and after with no diff | Sonnet 5.5 · medium |
| 9 | Optional: sign-in screens | `login`, `forgot-password`, `auth/update-password` | Same tokens; only if you say yes to question 3 | Sonnet 5.5 · medium |

Phases 1–5 and 7 suit one Sonnet 5.5 session at medium effort, switching to high for phase 4. Nothing here touches security or RLS, so Opus is not needed.

### Background painting prompt (phase 6)

> A small hillside town at dusk seen from a distance, many windows lit with warm lamplight, a wide violet evening sky fading to soft rose at the horizon, a thin crescent moon upper right and a few faint stars, painted like a background from a modern Japanese animated film, crisp soft clouds, calm. Top two thirds mostly open sky; lower fifth dark rooftops and hills in deep plum `#1d1630` fading to `#17141f` at the bottom edge. No text, letters, logos, people or UI. 21:9, 2880×1240.

Figma and Canva image generation are connected in this workspace, and either can run this prompt. Both may cost credits, so we ask before running it. Until then, the mockup's coded SVG scene is a fine stand-in.

## Open questions

1. **Stats:** are `50K+ learners`, `1M+ study hours`, `2K+ rooms` and `4.9/5` real numbers with a source? If not, they are removed (the mockups already drop them).
2. **Logo:** the conic-gradient orb with a glow is shared with the app. Options: flatten it everywhere (one CSS rule, but it changes the app's logo), flatten it only on the landing (the brand then differs), or keep it.
3. **Sign-in screens:** restyle `/login`, `/forgot-password` and `/auth/update-password` with the same tokens? They come before login, so they are not "internal".
4. **Painting:** generate it with an image tool (paid), or ship the coded SVG scene?
5. **Copy:** is the headline "Rooms where friends study, watch and listen together" OK?

## Risks

- `backdrop-filter` on three windows plus the nav is GPU work. It's fine on laptops but can stutter on low-end phones. Mobile uses a 12px blur and fewer glass layers, with a solid fallback.
- The demo uses invented names and data ("Friday film club", "Slow Tide by Hana Mori"). It is labelled as a preview so nobody takes it for real activity.
- Removing landing-only rules from `globals.css` (phase 7) is the one step that could touch the app if a class is shared. Each rule is grep-checked before it is deleted.
