# OmniLume remote security audit pack

This pack splits the combined audit into seven independent, single-`SELECT`
Dashboard queries. They read catalog metadata only: they do not create fixtures,
impersonate users, invoke RPCs, or change production data/schema/history.

## Run instructions

1. Open the linked project's Supabase Dashboard SQL Editor with an authorized
   administrator account.
2. Open **one** numbered `.sql` file, run it alone, and export its single result
   set as CSV or JSON. Do not concatenate files: the Dashboard export commonly
   retains only the final result set.
3. Name exports `01-rls-policies.csv` through
   `07-lifecycle-and-access-contracts.csv`, preserving the query timestamp and
   project reference in your evidence store. Do not include credentials.
4. Compare definitions to the immutable files in `supabase/migrations/`.
   Catalog output proves configuration, not that an authenticated caller is
   denied or allowed as expected. Run the separate behavior checklist before
   marking authorization verified.

| Query | Purpose | Expected configuration to review |
| --- | --- | --- |
| `01-rls-policies.sql` | RLS state and effective `USING`/`WITH CHECK` expressions for Action tables | Every listed sensitive base table exists with RLS enabled. Policies should constrain identity, relationship, recipient, active lifecycle, or room capability as appropriate. |
| `02-security-definer-functions.sql` | Every public `SECURITY DEFINER` function, body, settings, owner, and grants | A fixed `search_path` is present; `PUBLIC` EXECUTE is false unless deliberately documented. Bodies use explicit authorization before sensitive reads/writes. |
| `03-integrity-catalog.sql` | Table existence, checks, foreign keys, indexes, and application triggers | Recovered migration constraints/FKs/indexes/triggers are present. Missing rows or altered definitions require source-to-catalog review. |
| `04-storage-contract.sql` | `room_attachments` bucket, `storage.objects` policies, and path parser helpers | Bucket exists and is private; size/MIME limits match the Action 09 contract. Policies bind the room-prefixed path to `room_has_capability`; helpers have fixed settings. |
| `05-realtime-contract.sql` | `supabase_realtime` publication, Postgres Changes membership, and Broadcast/Presence policies | `message_requests`, `private_chats`, and `friendships` appear in the publication. `realtime.messages` policies parse topics and gate lifecycle/member/capability access. |
| `06-message-and-action08-10-rpcs.sql` | Migration 019 and Actions 08-10 RPC existence, signatures, grants, bodies, plus message-request table controls | All expected RPCs are present. RPC grants exclude `PUBLIC`; direct `message_requests` mutation grants to `authenticated` must be absent. |
| `07-lifecycle-and-access-contracts.sql` | Lifecycle, former-member, and recipient-isolation functions and policy contracts | Definitions/policies use active-access, approved-member, or room-capability checks. Notification policies must scope reads/updates to the recipient. |

## Interpretation rules

- **Confirmed PASS:** an exported row directly matches its intended migration
  contract and a separate behavior probe confirms authorization when required.
- **Confirmed defect:** a target is missing, RLS is disabled, a grant/policy is
  broader than the recovered contract, or an independent probe reaches data or
  mutates state without authorization.
- **Unverified:** missing export, ambiguous definition, or catalog-only output
  without a matching authenticated behavior probe.
- Do not create a migration for a merely missing export. First retain the query
  output and compare it against the timestamped migration source.

## Two-account authorization checklist

Run this only in a disposable staging/preview fixture through normal app flows.
It intentionally requires normal writes, so it is **not** part of this
production read-only catalog pack. Use distinct browser profiles and record
only outcome/status—not tokens, signed URLs, or private message content.

| Scenario | Actor A | Actor B | Expected outcome |
| --- | --- | --- | --- |
| Current versus former member | Owner creates a disposable private room and admits B | B leaves or is removed through the existing control action | B loses room page data, room messages, files, snapshots, study data, Broadcast/Presence access, and signed-download generation; A retains permitted access. |
| Notification recipient isolation | Trigger a normal room recovery/decision notification for A | Unrelated authenticated account B queries Notification Center/direct API route | A can read/mark only A's notification. B receives no row and cannot mark it read. |
| Member versus non-member | A owns an active room with Files/Study/Watch enabled | B is authenticated but never joins | B cannot list room data, invoke room RPCs, upload/download `room_attachments`, or subscribe to room realtime. |
| Owner/admin versus ordinary member | A is owner/admin; B is approved ordinary member | B attempts control-center mutations | B is denied role transfer, invite/restriction/admin changes, feature locks, and control-only media actions; allowed member capabilities still work. |
| Unauthorized storage | A uploads a disposable valid room file using the app | B requests the object path and any fresh signed-download operation | B is denied by storage/RPC. Verify only status/error; do not save or share signed URLs. |
| Unauthorized RPC/server action | A owns disposable room/file/note/request IDs | B invokes matching UI/server action/RPC with A's identifiers | B receives an authorization error and a post-check confirms no state changed. Cover invite revoke, membership review, recovery decision, room-file delete, study-note/PDF/whiteboard updates, and message-request accept/reject/cancel. |

After each case, clean fixtures using normal room/account lifecycle actions. Do
not reset, truncate, bulk delete, or alter production timestamps.
