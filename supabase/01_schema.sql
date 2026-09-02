--
-- PostgreSQL database dump
--

\restrict Aye66g8knQmpNT0AZqzvwdKQi9tXoFIyCDNy8GCyNYXuFS8FYVuteuE2RQk32e1

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.11

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: rooms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rooms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    is_private boolean DEFAULT false,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    username text,
    expiration_type text DEFAULT 'permanent'::text,
    expires_at timestamp with time zone,
    is_anonymous boolean DEFAULT false,
    is_group boolean DEFAULT false,
    active_media_url text,
    media_timestamp numeric DEFAULT 0,
    CONSTRAINT rooms_expiration_type_check CHECK ((expiration_type = ANY (ARRAY['permanent'::text, 'recoverable'::text, 'irreversible'::text])))
);


--
-- Name: get_room_by_identifier(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_room_by_identifier(identifier text) RETURNS SETOF public.rooms
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select *
  from public.rooms
  where lower(rooms.username) = lower(identifier)
     or rooms.id::text = identifier
  limit 1;
$$;

REVOKE EXECUTE ON FUNCTION public.get_room_by_identifier(text) FROM anon;


--
-- Name: message_reactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_reactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_id uuid NOT NULL,
    user_id uuid NOT NULL,
    emoji text NOT NULL,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    chat_id uuid,
    sender_id uuid NOT NULL,
    receiver_id uuid,
    ciphertext text,
    iv text,
    delivery_status text DEFAULT 'sent'::text,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    is_deleted boolean DEFAULT false,
    room_id uuid,
    content text,
    file_url text,
    CONSTRAINT messages_delivery_status_check CHECK ((delivery_status = ANY (ARRAY['sent'::text, 'delivered'::text, 'read'::text])))
);


--
-- Name: private_chats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.private_chats (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_one uuid NOT NULL,
    user_two uuid NOT NULL,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    public_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: room_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_members (
    room_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'member'::text,
    joined_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    join_status text DEFAULT 'approved'::text,
    CONSTRAINT room_members_join_status_check CHECK ((join_status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text]))),
    CONSTRAINT room_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])))
);


--
-- Name: room_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    room_id uuid NOT NULL,
    user_id uuid NOT NULL,
    text text,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    gif_url text,
    file_url text,
    file_name text,
    file_type text,
    content text,
    file_size bigint
);


--
-- Name: study_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.study_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    room_id uuid,
    subject text NOT NULL,
    duration_minutes integer NOT NULL,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now())
);


--
-- Name: temporary_media; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.temporary_media (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    room_id uuid,
    user_id uuid,
    file_name text NOT NULL,
    file_url text NOT NULL,
    media_type text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now())
);


--
-- Name: user_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_keys (
    user_id uuid NOT NULL,
    public_key text NOT NULL,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);


--
-- Name: message_reactions message_reactions_message_id_user_id_emoji_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_reactions
    ADD CONSTRAINT message_reactions_message_id_user_id_emoji_key UNIQUE (message_id, user_id, emoji);


--
-- Name: message_reactions message_reactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_reactions
    ADD CONSTRAINT message_reactions_pkey PRIMARY KEY (id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: private_chats private_chats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_chats
    ADD CONSTRAINT private_chats_pkey PRIMARY KEY (id);


--
-- Name: private_chats private_chats_user_one_user_two_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_chats
    ADD CONSTRAINT private_chats_user_one_user_two_key UNIQUE (user_one, user_two);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: room_members room_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_members
    ADD CONSTRAINT room_members_pkey PRIMARY KEY (room_id, user_id);


--
-- Name: room_messages room_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_messages
    ADD CONSTRAINT room_messages_pkey PRIMARY KEY (id);


--
-- Name: rooms rooms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rooms
    ADD CONSTRAINT rooms_pkey PRIMARY KEY (id);


--
-- Name: rooms rooms_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rooms
    ADD CONSTRAINT rooms_username_key UNIQUE (username);


--
-- Name: study_sessions study_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.study_sessions
    ADD CONSTRAINT study_sessions_pkey PRIMARY KEY (id);


--
-- Name: temporary_media temporary_media_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_media
    ADD CONSTRAINT temporary_media_pkey PRIMARY KEY (id);


--
-- Name: user_keys user_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_keys
    ADD CONSTRAINT user_keys_pkey PRIMARY KEY (user_id);


--
-- Name: messages_room_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_room_id_idx ON public.messages USING btree (room_id);


--
-- Name: message_reactions message_reactions_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_reactions
    ADD CONSTRAINT message_reactions_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.room_messages(id) ON DELETE CASCADE;


--
-- Name: message_reactions message_reactions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_reactions
    ADD CONSTRAINT message_reactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: messages messages_chat_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_chat_id_fkey FOREIGN KEY (chat_id) REFERENCES public.private_chats(id) ON DELETE CASCADE;


--
-- Name: messages messages_receiver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_receiver_id_fkey FOREIGN KEY (receiver_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: messages messages_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: messages messages_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: private_chats private_chats_user_one_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_chats
    ADD CONSTRAINT private_chats_user_one_fkey FOREIGN KEY (user_one) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: private_chats private_chats_user_two_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_chats
    ADD CONSTRAINT private_chats_user_two_fkey FOREIGN KEY (user_two) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_members room_members_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_members
    ADD CONSTRAINT room_members_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_members room_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_members
    ADD CONSTRAINT room_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: room_messages room_messages_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_messages
    ADD CONSTRAINT room_messages_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_messages room_messages_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_messages
    ADD CONSTRAINT room_messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: rooms rooms_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rooms
    ADD CONSTRAINT rooms_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: study_sessions study_sessions_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.study_sessions
    ADD CONSTRAINT study_sessions_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: study_sessions study_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.study_sessions
    ADD CONSTRAINT study_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: temporary_media temporary_media_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_media
    ADD CONSTRAINT temporary_media_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: temporary_media temporary_media_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporary_media
    ADD CONSTRAINT temporary_media_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: user_keys user_keys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_keys
    ADD CONSTRAINT user_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: user_keys Allow read access to public keys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow read access to public keys" ON public.user_keys FOR SELECT TO authenticated USING (true);


--
-- Name: room_messages Room members can read room messages; Type: POLICY; Schema: public; Owner: -
--

-- Superseded by migrations/004_security_remediation.sql.


--
-- Name: message_reactions Anyone can view reactions; Type: POLICY; Schema: public; Owner: -
--

-- Superseded by migrations/004_security_remediation.sql.


--
-- Name: temporary_media Approved room members can view temporary media; Type: POLICY; Schema: public; Owner: -
--

-- Superseded by migrations/004_security_remediation.sql.


--
-- Name: rooms Authenticated users can create rooms; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can create rooms" ON public.rooms FOR INSERT TO authenticated WITH CHECK ((auth.uid() = created_by));


--
-- Name: room_messages Room members can send room messages; Type: POLICY; Schema: public; Owner: -
--

-- Superseded by migrations/004_security_remediation.sql.


--
-- Name: rooms Creators can view their own rooms; Type: POLICY; Schema: public; Owner: -
--

-- Superseded by migrations/004_security_remediation.sql.


--
-- Name: messages Users can insert messages; Type: POLICY; Schema: public; Owner: -
--

-- Superseded by migrations/004_security_remediation.sql.


--
-- Name: rooms Members can view rooms they joined; Type: POLICY; Schema: public; Owner: -
--

-- Superseded by migrations/004_security_remediation.sql.


--
-- Name: room_members Members viewable by everyone; Type: POLICY; Schema: public; Owner: -
--

-- Superseded by migrations/004_security_remediation.sql.


--
-- Name: room_members Owners can delete members; Type: POLICY; Schema: public; Owner: -
--

-- Superseded by migrations/004_security_remediation.sql.


--
-- Name: room_members Owners can update members; Type: POLICY; Schema: public; Owner: -
--

-- Superseded by migrations/004_security_remediation.sql.


--
-- Name: rooms Owners can update rooms; Type: POLICY; Schema: public; Owner: -
--

-- Superseded by migrations/004_security_remediation.sql.


--
-- Name: messages Participants read messages; Type: POLICY; Schema: public; Owner: -
--

-- Superseded by migrations/004_security_remediation.sql.


--
-- Name: private_chats Participants view own chats; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Participants view own chats" ON public.private_chats FOR SELECT TO authenticated USING (((auth.uid() = user_one) OR (auth.uid() = user_two)));


--
-- Name: rooms Public rooms are viewable by everyone; Type: POLICY; Schema: public; Owner: -
--

-- Superseded by migrations/004_security_remediation.sql.


--
-- Name: messages Room members read room messages; Type: POLICY; Schema: public; Owner: -
--

-- Superseded by migrations/004_security_remediation.sql.


--
-- Name: room_members Users can request to join rooms; Type: POLICY; Schema: public; Owner: -
--

-- Superseded by migrations/004_security_remediation.sql.


--
-- Name: private_chats Users can create chats; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create chats" ON public.private_chats FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_one));


--
-- Name: message_reactions Users can manage their own reactions; Type: POLICY; Schema: public; Owner: -
--

-- Superseded by migrations/004_security_remediation.sql.


--
-- Name: messages Users can update own messages; Type: POLICY; Schema: public; Owner: -
--

-- Superseded by migrations/004_security_remediation.sql.


--
-- Name: temporary_media Approved room members can upload temporary media; Type: POLICY; Schema: public; Owner: -
--

-- Superseded by migrations/004_security_remediation.sql.


--
-- Name: user_keys Users update own public key; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users update own public key" ON public.user_keys TO authenticated USING ((auth.uid() = user_id));


--
-- Name: room_members Users can update own membership status; Type: POLICY; Schema: public; Owner: -
--

-- Superseded by migrations/004_security_remediation.sql.


--
-- Name: room_members members read room membership; Type: POLICY; Schema: public; Owner: -
--

-- Superseded by migrations/004_security_remediation.sql.


--
-- Name: message_reactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.message_reactions ENABLE ROW LEVEL SECURITY;

--
-- Name: messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

--
-- Name: private_chats; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.private_chats ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles profiles are readable by authenticated users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "profiles are readable by authenticated users" ON public.profiles FOR SELECT TO authenticated USING (true);


--
-- Name: room_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_members ENABLE ROW LEVEL SECURITY;

--
-- Name: room_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: rooms; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;

--
-- Name: study_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.study_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: temporary_media; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.temporary_media ENABLE ROW LEVEL SECURITY;

--
-- Name: user_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: room_members users leave rooms; Type: POLICY; Schema: public; Owner: -
--

-- Superseded by migrations/004_security_remediation.sql.


--
-- Name: profiles users manage own profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "users manage own profile" ON public.profiles TO authenticated USING ((auth.uid() = id)) WITH CHECK ((auth.uid() = id));


--
-- Name: study_sessions users manage own study sessions; Type: POLICY; Schema: public; Owner: -
--

-- Superseded by migrations/004_security_remediation.sql.


--
-- PostgreSQL database dump complete
--

\unrestrict Aye66g8knQmpNT0AZqzvwdKQi9tXoFIyCDNy8GCyNYXuFS8FYVuteuE2RQk32e1

-- Canonical final-state overlays.
--
-- The base dump above is retained for the original object definitions. These
-- overlays are part of this canonical rebuild and must run after the base
-- objects so the final schema includes recovery lifecycle state, server-time
-- access checks, current RLS, and controlled room conversion/notification
-- behavior. Run this file with psql so the relative \ir includes are honored.
\ir migrations/003_room_lifecycle.sql
\ir migrations/004_security_remediation.sql

