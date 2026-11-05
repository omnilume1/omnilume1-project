# Actions 11–12 plan (branch `feat/actions-11-12`)

Resume point. Tick an item only with its commit hash; evidence goes in
`docs/action-01-10-evidence-ledger.md` (section "Actions 11–12").
Specs: `OmniLume_Final_Corrected_Roadmap.pdf` (Actions 11, 12),
`OMNILUME_MASTER_PLAN.md` §15–21. Owner decisions: 7-day recovery; no Ghost
Mode; E2EE untouched; AI is Action 17 (only the non-AI part of any item);
lyrics dropped; minimum age 13. Paid/external providers not configured →
provider-neutral free path, recorded in the ledger and the final report.

Rules: additive migrations; RLS on every new table; FKs/unique/status
constraints; SECURITY DEFINER with `search_path = ''` and minimal grants;
policy helpers executable by `authenticated`; every channel `private: true`
with a `realtime.messages` topic policy; never trust the client; disabled
features refused by server/RLS/realtime; actions return errors as values;
permission-gate by room role; mobile + desktop; a11y; reduced motion.
Dry run every migration as `authenticated` before `npx supabase db push`.
Never push, never merge.

## Part A — re-verify 01–10 on main
- [x] Migration lists match; tsc; lint; tests; build; route smoke. (`0f503bc`)
- [x] Probe suite (authorization, lifecycle, site-owner, notification,
      messaging, workspace, media). (`0f503bc`)
- [x] `/admin/recovery` denies a signed-in non-owner (404). (`0f503bc`)
- [x] Cleanup cron: overlap safety (unit tests) + read-only due list; the
      route itself is not invoked (a run deletes rooms). (`0f503bc`)
- [x] GIPHY key present and a real request succeeds. (`0f503bc`)

## Action 11 — Watch and shared media reliability
Exists: MediaStage (React Player v3, `src`/`currentTime`), useRoomSync
revisioned events + persisted snapshots + request_sync/force_sync late join,
per-viewer media resolution, subtitles/audio tracks, URL + upload casting,
watch/watch_control capabilities, A10 metadata.
- [x] 11.1 `src`/`currentTime` only; no `url`, `getInternalPlayer`,
      `config.file`, `as any` (static contract test). (`0f503bc`)
- [x] 11.2 Idempotent remote apply, no recursive rebroadcast: native events
      are broadcast only when they differ from room state (replaces the
      500 ms timer gap). (`0f503bc`)
- [x] 11.3 Throttled seeking: rapid seeks coalesce into one broadcast. (`0f503bc`)
- [x] 11.4 Drift correction: position extrapolated from receive time and
      speed; controller heartbeat while playing; viewers re-seek on drift. (`0f503bc`)
- [x] 11.5 Speed applied to every element (incl. native FLAC audio). (`0f503bc`)
- [x] 11.6 Subtitles/audio tracks verified two-user. (`0f503bc`)
- [x] 11.7 External/uploaded media + unsupported media error/retry verified. (`0f503bc`)
- [x] 11.8 Controls gated by watch_control in UI, RPC and Realtime. (`0f503bc`)
- [x] 11.9 Late join at the extrapolated position. (`0f503bc`)
- [x] 11.10 Reconnect re-requests room state. (`0f503bc`)
- [x] 11.11 Shared queue (table + RPCs + live + UI; add/remove/reorder/play
      next; who added each item). (`0f503bc`)
- [x] 11.12 Now Playing / shared state bar outside Watch. (`0f503bc`)
- [x] 11.13 Clips/highlights (save moment + label; list; jump). (`0f503bc`)
- [x] 11.14 Metadata in queue/now playing (A10 reuse). (`0f503bc`)
- [x] Probes, dry run, push, two-account browser (desktop + mobile), ledger. (`0f503bc`)

## Action 12 — Study and non-AI collaboration
Exists: StudyStage (shared timer, Focus Lock, study_sessions history),
study_notes (versioned), whiteboard (versioned), PDF annotations, scheduled
rooms, notifications, owner controls.
- [ ] 12.1 Live notes (shared notes update live; editing presence).
- [ ] 12.2 Collaborative docs (note version history, restore, read-only).
- [ ] 12.3 Whiteboard cursors (ephemeral, throttled, named).
- [ ] 12.4 Voice with owner mute (P2P WebRTC mesh, signaling on a private
      capability-scoped topic; owner/managers mute; listeners enforce).
- [ ] 12.5 Screen sharing (explicit start, visible indicator, stop;
      capability-gated).
- [ ] 12.6 Raise hand (queue; managers lower).
- [ ] 12.7 Polls (create, vote once, close, results).
- [ ] 12.8 Countdowns (shared event timer).
- [ ] 12.9 Manual tasks/action items (assign, due, done; notify assignee).
- [ ] 12.10 Room events (schedule, notify members, upcoming list).
- [ ] 12.11 Study history (streaks, totals, longest, per subject) + study
      music (compact player on the shared queue).
- [ ] 12.12 YouTube/lecture video resources (save, watch together,
      continue watching, timestamped notes).
- [ ] 12.13 Consented recording (all participants consent; stored with
      retention) + manual transcript (automatic transcription is AI →
      Action 17).
- [ ] 12.14 Searchable history (messages, notes, tasks, polls, events,
      clips, transcripts; capability-scoped).
- [ ] Probes, dry run, push, two-account browser (desktop + mobile), ledger.
