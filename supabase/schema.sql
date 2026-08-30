-- ============================================================
-- Omnilume — Supabase schema (canonical, reconciled with live DB)
-- Supports phases 1–25 of OMNILUME_MASTER_PLAN.md
-- Run in the Supabase SQL Editor. Idempotent: safe to re-run.
-- ============================================================

-- ---------- PROFILES (public keys for E2EE messaging) ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  public_key text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles are readable by authenticated users" on public.profiles;
create policy "profiles are readable by authenticated users"
  on public.profiles for select to authenticated using (true);

drop policy if exists "users manage own profile" on public.profiles;
create policy "users manage own profile"
  on public.profiles for all to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);

-- ---------- USER KEYS (legacy public-key storage, kept in sync) ----------
create table if not exists public.user_keys (
  user_id uuid primary key references auth.users(id) on delete cascade,
  public_key text not null,
  updated_at timestamptz not null default now()
);

alter table public.user_keys enable row level security;

drop policy if exists "Allow read access to public keys" on public.user_keys;
create policy "Allow read access to public keys"
  on public.user_keys for select to authenticated using (true);

drop policy if exists "Users update own public key" on public.user_keys;
create policy "Users update own public key"
  on public.user_keys for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- PRIVATE CHATS (E2EE conversations) ----------
create table if not exists public.private_chats (
  id uuid primary key default gen_random_uuid(),
  user_one uuid not null references auth.users(id) on delete cascade,
  user_two uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint no_self_chat check (user_one <> user_two)
);

alter table public.private_chats enable row level security;

drop policy if exists "Participants view own chats" on public.private_chats;
create policy "Participants view own chats"
  on public.private_chats for select to authenticated
  using (auth.uid() = user_one or auth.uid() = user_two);

drop policy if exists "Users can create chats" on public.private_chats;
create policy "Users can create chats"
  on public.private_chats for insert to authenticated
  with check (auth.uid() = user_one or auth.uid() = user_two);

-- ---------- ROOMS ----------
create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  username text unique,
  is_private boolean not null default false,
  is_anonymous boolean not null default false,
  is_group boolean not null default false,
  expiration_type text not null default 'permanent'
    check (expiration_type in ('permanent', 'recoverable', 'irreversible')),
  expires_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  active_media_url text,
  media_timestamp numeric not null default 0
);

alter table public.rooms enable row level security;

drop policy if exists "Public rooms are viewable by everyone" on public.rooms;
create policy "Public rooms are viewable by everyone"
  on public.rooms for select to authenticated using (not is_private);

drop policy if exists "Creators can view their own rooms" on public.rooms;
create policy "Creators can view their own rooms"
  on public.rooms for select to authenticated using (auth.uid() = created_by);

drop policy if exists "Members can view rooms they joined" on public.rooms;
create policy "Members can view rooms they joined"
  on public.rooms for select to authenticated
  using (exists (
    select 1 from public.room_members rm
    where rm.room_id = rooms.id and rm.user_id = auth.uid()
  ));

drop policy if exists "Authenticated users can create rooms" on public.rooms;
create policy "Authenticated users can create rooms"
  on public.rooms for insert to authenticated with check (auth.uid() = created_by);

drop policy if exists "Owners can update rooms" on public.rooms;
create policy "Owners can update rooms"
  on public.rooms for update to authenticated
  using (auth.uid() = created_by) with check (auth.uid() = created_by);

-- ---------- ROOM MEMBERS ----------
create table if not exists public.room_members (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member'
    check (role in ('owner', 'admin', 'moderator', 'member', 'guest')),
  join_status text not null default 'pending'
    check (join_status in ('pending', 'approved')),
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

alter table public.room_members enable row level security;

drop policy if exists "Members viewable by everyone" on public.room_members;
create policy "Members viewable by everyone"
  on public.room_members for select to authenticated using (true);

drop policy if exists "Users can add themselves on creation" on public.room_members;
create policy "Users can add themselves on creation"
  on public.room_members for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "Owners can update members" on public.room_members;
create policy "Owners can update members"
  on public.room_members for update to authenticated
  using (exists (
    select 1 from public.room_members my
    where my.room_id = room_members.room_id
      and my.user_id = auth.uid()
      and my.role in ('owner', 'admin')
  ));

drop policy if exists "Owners can delete members" on public.room_members;
create policy "Owners can delete members"
  on public.room_members for delete to authenticated
  using (auth.uid() = user_id or exists (
    select 1 from public.room_members my
    where my.room_id = room_members.room_id
      and my.user_id = auth.uid()
      and my.role in ('owner', 'admin')
  ));

-- ---------- ROOM MESSAGES (plain room chat) ----------
create table if not exists public.room_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  text text,
  content text,
  gif_url text,
  file_url text,
  file_name text,
  file_type text,
  file_size bigint,
  created_at timestamptz not null default now()
);

alter table public.room_messages enable row level security;

drop policy if exists "Anyone can read room messages" on public.room_messages;
create policy "Anyone can read room messages"
  on public.room_messages for select to authenticated using (true);

drop policy if exists "Authenticated users can insert room messages" on public.room_messages;
create policy "Authenticated users can insert room messages"
  on public.room_messages for insert to authenticated
  with check (auth.uid() = user_id);

-- ---------- MESSAGES (E2EE private chat + room-based chat) ----------
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid references public.private_chats(id) on delete cascade,
  room_id uuid references public.rooms(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  receiver_id uuid references auth.users(id) on delete set null,
  ciphertext text,
  iv text,
  content text,
  file_url text,
  delivery_status text not null default 'sent',
  is_deleted boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.messages enable row level security;

drop policy if exists "Participants read messages" on public.messages;
create policy "Participants read messages"
  on public.messages for select to authenticated
  using (auth.uid() = sender_id or auth.uid() = receiver_id);

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

drop policy if exists "Senders insert messages" on public.messages;
create policy "Senders insert messages"
  on public.messages for insert to authenticated with check (auth.uid() = sender_id);

drop policy if exists "Users can update own messages" on public.messages;
create policy "Users can update own messages"
  on public.messages for update to authenticated
  using (auth.uid() = sender_id) with check (auth.uid() = sender_id);

create index if not exists messages_room_id_idx on public.messages(room_id);

-- ---------- MESSAGE REACTIONS ----------
create table if not exists public.message_reactions (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.room_messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now()
);

alter table public.message_reactions enable row level security;

drop policy if exists "Anyone can view reactions" on public.message_reactions;
create policy "Anyone can view reactions"
  on public.message_reactions for select to authenticated using (true);

drop policy if exists "Users can manage their own reactions" on public.message_reactions;
create policy "Users can manage their own reactions"
  on public.message_reactions for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- STUDY SESSIONS ----------
create table if not exists public.study_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  subject text not null,
  duration_minutes integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.study_sessions enable row level security;

drop policy if exists "users manage own study sessions" on public.study_sessions;
create policy "users manage own study sessions"
  on public.study_sessions for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- TEMPORARY MEDIA (24h watch-party uploads) ----------
create table if not exists public.temporary_media (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  file_name text not null,
  file_url text not null,
  media_type text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.temporary_media enable row level security;

drop policy if exists "Anyone in room can view temporary media" on public.temporary_media;
create policy "Anyone in room can view temporary media"
  on public.temporary_media for select to authenticated
  using (exists (
    select 1 from public.room_members rm
    where rm.room_id = temporary_media.room_id and rm.user_id = auth.uid()
  ));

drop policy if exists "Users can upload temporary media" on public.temporary_media;
create policy "Users can upload temporary media"
  on public.temporary_media for insert to authenticated
  with check (auth.uid() = user_id);

-- ---------- ROOM LOOKUP RPC (codes, usernames, links) ----------
drop function if exists public.get_room_by_identifier(text);

create or replace function public.get_room_by_identifier(identifier text)
returns setof public.rooms
language sql
stable
security definer
set search_path = public
as $$
  select *
  from public.rooms
  where lower(rooms.username) = lower(identifier)
     or rooms.id::text = identifier
  limit 1;
$$;

grant execute on function public.get_room_by_identifier(text) to authenticated;

-- ---------- REALTIME ----------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'room_messages'
  ) then
    alter publication supabase_realtime add table public.room_messages;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'message_reactions'
  ) then
    alter publication supabase_realtime add table public.message_reactions;
  end if;
end $$;

-- ---------- STORAGE (room file uploads) ----------
insert into storage.buckets (id, name, public)
values ('room_attachments', 'room_attachments', true)
on conflict (id) do nothing;

drop policy if exists "authenticated upload room attachments" on storage.objects;
create policy "authenticated upload room attachments"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'room_attachments');

drop policy if exists "authenticated read room attachments" on storage.objects;
create policy "authenticated read room attachments"
  on storage.objects for select to authenticated
  using (bucket_id = 'room_attachments');

drop policy if exists "authenticated delete room attachments" on storage.objects;
create policy "authenticated delete room attachments"
  on storage.objects for delete to authenticated
  using (bucket_id = 'room_attachments');
