-- ============================================================
-- Omnilume — one-off reconciliation migration
-- Reconciles the pre-existing DB schema (private_chats, user_keys,
-- live data) with the app code. Safe: preserves all data.
-- ============================================================

-- 1. Drop the parallel `chats` table created by the first schema run
--    (empty; private_chats is the real, data-bearing container)
drop table if exists public.chats cascade;

-- 2. Drop policies that referenced the dropped chats table
drop policy if exists "chat participants read messages" on public.messages;

-- 3. Drop exact-duplicate policies created by the first schema run
--    (the originals below them remain in place)
drop policy if exists "authenticated send messages" on public.messages;
drop policy if exists "senders update own messages" on public.messages;
drop policy if exists "authenticated read room existence" on public.rooms;
drop policy if exists "authenticated create rooms" on public.rooms;
drop policy if exists "room owner updates room" on public.rooms;
drop policy if exists "Users can insert own study sessions" on public.study_sessions;
drop policy if exists "Users can view own study sessions" on public.study_sessions;

-- 4. Extend messages so the room-sidebar chat (RoomChat.tsx) and
--    deleteMessageForEveryone work against the existing table
alter table public.messages
  add column if not exists room_id uuid references public.rooms(id) on delete cascade,
  add column if not exists content text,
  add column if not exists file_url text;

-- chat_id / receiver_id / ciphertext / iv must be nullable:
-- room-based messages carry room_id + plaintext content instead
alter table public.messages alter column chat_id drop not null;
alter table public.messages alter column receiver_id drop not null;
alter table public.messages alter column ciphertext drop not null;
alter table public.messages alter column iv drop not null;

-- 5. Room members can read room-based messages
--    (private-chat reads are already covered by "Participants read messages")
drop policy if exists "Room members read room messages" on public.messages;
create policy "Room members read room messages"
  on public.messages for select to authenticated
  using (
    messages.room_id is not null
    and exists (
      select 1 from public.room_members rm
      where rm.room_id = messages.room_id and rm.user_id = auth.uid()
    )
  );

-- 6. Index for the new room-based reads
create index if not exists messages_room_id_idx on public.messages(room_id);

-- 7. Data integrity: one membership row per (room, user)
do $$
declare
  pk_count int;
begin
  select count(*)::int into pk_count
  from pg_constraint
  where conrelid = 'public.room_members'::regclass and contype = 'p';

  if pk_count = 0 then
    alter table public.room_members
      add constraint room_members_room_user_pk primary key (room_id, user_id);
  end if;
end $$;

-- 8. Align temporary_media policies with canonical schema
drop policy if exists "authenticated insert temporary media" on public.temporary_media;
drop policy if exists "authenticated read temporary media" on public.temporary_media;
