# OmniLume Supabase security policy reference

This file documents the effective policy model. The executable sources are
`01_schema.sql` plus the ordered migrations in `migrations/`; the final
canonical rebuild applies `003_room_lifecycle.sql` and
`004_security_remediation.sql` after the base dump.

## Effective access rules

| Resource | Effective rule |
|---|---|
| `rooms` | Public rooms are visible only while active. Private rooms require an approved member, owner, or authorized recovery manager. Expired irreversible rooms are hidden. |
| `room_members` | Approved members can see active-room membership. Owners/admins manage other memberships only in active rooms. Users cannot change identity, room, or role to escalate access. |
| `messages` | Private-chat rows are limited to participants. Room rows require approved membership and active/reopened room access. Updates require the current approved sender. |
| `room_messages` | The legacy table remains protected for compatibility, but its application writer is removed. Reads/inserts require approved membership and active/reopened room access. |
| `temporary_media` | Reads/inserts require approved membership, active room access, and an unexpired media row. |
| `message_reactions` / `study_sessions` | Operations are limited to the authenticated user and an approved member of the active room where the record is room-scoped. |
| `storage.objects` | Room attachment paths are scoped by the first path segment as the room UUID, the private bucket, approved membership, and active/reopened room access. |
| `recovery_requests` | Only the current approved owner/admin may submit during the 24-hour recovery window. Requests are reviewed through the protected database function. |
| `room_permanent_requests` | Any current approved member may request permanence during the seven-day reopened period. Only the current owner/admin may review it. |
| `room_notifications` | Notifications are readable and markable only by their intended recipient. |

## Server-side helpers and lifecycle

The lifecycle migration uses database time (`now()`) for access decisions. The
security migration provides restricted `SECURITY DEFINER` helpers with an
explicit `public` search path and removes public execution from lifecycle and
review functions.

Temporary-room lifecycle:

1. Original expiry starts a 24-hour recovery-request window.
2. Approved recovery reopens preserved data for seven days.
3. Approved members may request permanent conversion during that period.
4. Only an owner/admin may approve conversion.
5. Permanent conversion clears temporary expiry fields and remains available
   indefinitely.

Identity and scope protections prevent room-membership identity changes and
message sender/room/chat reassignment. The cleanup endpoint is separately
protected by its server-only secret and service-role configuration.

## Rebuild and deployment notes

- Do not run only the historical base object dump when rebuilding a project.
- Use `01_schema.sql` with `psql`, which includes the lifecycle/security
  overlays, or apply the ordered migrations through the Supabase migration
  workflow.
- Keep `SUPABASE_SERVICE_ROLE_KEY` and `CRON_SECRET` server-only.
- The `room_messages` table is intentionally retained for database
  compatibility; removing its application writer is separate from dropping
  the table.
