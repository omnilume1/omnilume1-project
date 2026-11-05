# Action 15 plan (branch `feat/action-15`)

Resume point. Tick an item only with its commit hash; evidence goes in
`docs/action-01-10-evidence-ledger.md` (section "Action 15").
Specs: `OmniLume_Final_Corrected_Roadmap.pdf` (Action 15),
`OMNILUME_MASTER_PLAN.md` §5. Same owner decisions and Rules as
`docs/action-13-14-plan.md` (additive migration, RLS, definer helpers with
`search_path = ''`, private-only realtime, errors as values, dry run as
`authenticated` before `npx supabase db push`, never push or merge).

Decision (owner default): Personal and General stay E2EE
(`messages.ciphertext`); **group messages are plaintext protected by RLS**,
like rooms. No group key distribution.

## Action 15 — Personal, General and Group messaging
- [x] (`0f16fcc`) 15.1 Conversation model: exactly one type per conversation, derived
      server-side (`private_chat_type`, `get_my_conversations`): personal =
      accepted friends, general = accepted message request, group = Action 14
      `groups`/`group_members`. Order-independent unique pair index.
- [x] (`0f16fcc`) 15.2 Messages page tabs Personal | General | Groups | Requests, reusing
      `usePrivateChat`, `PrivateChat`, public-key helpers and allSettled UI;
      room messages/keys never mixed.
- [x] (`0f16fcc`) 15.3 General: request → accept / decline / block; unread counts and read
      state (`conversation_reads`, `mark_conversation_read`).
- [x] (`0f16fcc`) 15.4 Reclassification General → Personal relabels metadata only; same
      chat, ciphertext byte-identical.
- [x] (`0f16fcc`) 15.5 Group messages (`group_messages`) gated by `group_members` + roles
      (leave, owner/admin removal), private `group_<id>` topic.
- [x] (`0f16fcc`) 15.6 Revocation: block, unfriend, leave, removal stop reads, writes and
      realtime (restrictive `messages` policies + topic helpers).
- [x] (`0f16fcc`) 15.7 Decryption failure shows a safe message (existing path kept).
- [x] (`0f16fcc`) 15.8 Async states: loading, disabled, error, empty, retry, a11y, 390 px.
- [x] (`0f16fcc`) 15.9 Verification: dry run, push, probe, unit tests, lint, build, browser.
