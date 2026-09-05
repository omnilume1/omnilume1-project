'use client';

import { useState, useEffect, useRef } from 'react';
import { createClient } from '@/utils/supabase/client';
import { useRoomRealtime } from '@/components/room/RoomRealtimeProvider';
import { deleteMessageForEveryone } from '@/actions/chat';

interface RoomChatProps {
  roomId: string;
}

interface RoomChatMessage {
  id: string;
  sender_id: string;
  content: string | null;
  is_deleted?: boolean;
  created_at: string;
}

function mergeMessage(messages: RoomChatMessage[], incoming: RoomChatMessage) {
  const existingIndex = messages.findIndex((message) => message.id === incoming.id);
  if (existingIndex === -1) {
    return [...messages, incoming].sort((left, right) => left.created_at.localeCompare(right.created_at));
  }

  const next = [...messages];
  next[existingIndex] = { ...next[existingIndex], ...incoming };
  return next;
}

export default function RoomChat({ roomId }: RoomChatProps) {
  const [messages, setMessages] = useState<RoomChatMessage[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [hiddenMessages, setHiddenMessages] = useState<Set<string>>(new Set());
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletingMessageId, setDeletingMessageId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const supabase = createClient();
  const { currentUserId: roomCurrentUserId, typingUsers, broadcastEvent, roomMessageEvents } = useRoomRealtime();

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const savedHidden = localStorage.getItem(`hidden_msgs_${roomId}`);
      if (savedHidden) {
        const timer = window.setTimeout(() => setHiddenMessages(new Set(JSON.parse(savedHidden))), 0);
        return () => window.clearTimeout(timer);
      }
    }
  }, [roomId]);

  useEffect(() => {
    let isMounted = true;
    const setupChat = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user && isMounted) setCurrentUserId(user.id);

      const { data } = await supabase.from('messages').select('*').eq('room_id', roomId).order('created_at', { ascending: true });
      if (data && isMounted) setMessages(data as RoomChatMessage[]);
    };
    setupChat();

    return () => { isMounted = false; };
  }, [roomId, supabase]);

  useEffect(() => {
    if (roomMessageEvents.length === 0) return;

    const timer = window.setTimeout(() => {
      setMessages((current) => roomMessageEvents.reduce((messagesForEvent, event) => {
        return mergeMessage(messagesForEvent, event.message as unknown as RoomChatMessage);
      }, current));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [roomMessageEvents]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, typingUsers]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-message-menu-area]')) return;
      setActiveMenuId(null);
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim()) return;

    const senderId = currentUserId ?? roomCurrentUserId ?? (await supabase.auth.getUser()).data.user?.id ?? null;
    if (!senderId) {
      setDeleteError('Unable to send message. Please sign in again.');
      return;
    }

    if (!currentUserId) setCurrentUserId(senderId);

    const messageText = newMessage.trim();
    setNewMessage('');
    const { data, error } = await supabase
      .from('messages')
      .insert({ room_id: roomId, sender_id: senderId, content: messageText })
      .select('*')
      .single();

    if (error || !data) {
      setNewMessage(messageText);
      setDeleteError('Unable to send message.');
      return;
    }

    const createdMessage = data as RoomChatMessage;
    setMessages((current) => mergeMessage(current, createdMessage));
    broadcastEvent('room_message', { message: createdMessage as unknown as Record<string, unknown> });
  };

  const handleTyping = (e: React.ChangeEvent<HTMLInputElement>) => {
    setNewMessage(e.target.value);
    broadcastEvent('typing', { sender_id: currentUserId });
  };

  const handleDeleteForMe = (msgId: string) => {
    const updatedHidden = new Set(hiddenMessages);
    updatedHidden.add(msgId);
    setHiddenMessages(updatedHidden);
    localStorage.setItem(`hidden_msgs_${roomId}`, JSON.stringify(Array.from(updatedHidden)));
    setActiveMenuId(null);
  };

  const handleDeleteForEveryone = async (msgId: string) => {
    if (deletingMessageId) return;

    setActiveMenuId(null);
    setDeleteError(null);
    setDeletingMessageId(msgId);

    try {
      const result = await deleteMessageForEveryone(msgId, roomId);
      if (!result.success) {
        setDeleteError(result.error ?? 'Unable to delete message.');
        return;
      }

      setMessages(prev => prev.map(msg => msg.id === msgId ? { ...msg, is_deleted: true, content: '🚫 This message was deleted' } : msg));
      broadcastEvent('room_message_update', {
        message: { id: msgId, is_deleted: true, content: 'This message was deleted', file_url: null },
      });
    } catch {
      setDeleteError('Unable to delete message.');
    } finally {
      setDeletingMessageId(null);
    }
  };

  return (
    <div className="chat-panel relative h-full border-l border-white/10">
      <div className="chat-topbar z-10 shadow-md">
        <h3 className="text-white font-bold text-sm">Room Chat</h3>
      </div>

      {deleteError && <p className="border-b border-red-500/20 bg-red-500/5 px-4 py-2 text-xs text-red-300" role="alert">{deleteError}</p>}

      <div ref={scrollRef} className="chat-scroller flex flex-col gap-4">
        {messages.length === 0 ? (
          <p className="text-xs text-neutral-500 text-center mt-10">No messages yet. Say hello!</p>
        ) : (
          messages.filter(msg => !hiddenMessages.has(msg.id)).map((msg) => {
            const isMe = msg.sender_id === (currentUserId ?? roomCurrentUserId);
            return (
              <div key={msg.id} className={`flex flex-col relative group ${isMe ? 'items-end' : 'items-start'}`}>
                <div data-message-menu-area className={`message-bubble relative flex max-w-[85%] items-center gap-3 px-4 py-2.5 ${msg.is_deleted ? 'bg-transparent text-neutral-500 italic' : isMe ? 'is-own rounded-br-sm text-white' : 'rounded-bl-sm text-white'}`}>
                  <span className="text-sm leading-relaxed break-words">{msg.content}</span>
                  {!msg.is_deleted && (
                    <button aria-label="Message actions" title="Message actions" onClick={(e) => { e.stopPropagation(); setActiveMenuId(activeMenuId === msg.id ? null : msg.id); }} className={`message-more rounded p-1 transition hover:bg-black/20 ${isMe ? '-ml-2' : ''}`}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="19" r="1"></circle></svg>
                    </button>
                  )}
                </div>
                {activeMenuId === msg.id && (
                  <div data-message-menu-area className={`chat-menu absolute top-full z-50 mt-1 flex w-40 flex-col overflow-hidden rounded-xl py-1 shadow-2xl ${isMe ? 'right-0' : 'left-0'}`}>
                    <button onClick={(e) => { e.stopPropagation(); handleDeleteForMe(msg.id); }} className="px-4 py-2 text-left text-xs text-white hover:bg-neutral-800 font-semibold transition cursor-pointer">Delete for me</button>
                    {isMe && <button onClick={(e) => { e.stopPropagation(); handleDeleteForEveryone(msg.id); }} disabled={deletingMessageId === msg.id} className="px-4 py-2 text-left text-xs text-red-400 hover:bg-neutral-800 font-semibold transition cursor-pointer disabled:cursor-wait disabled:opacity-50">{deletingMessageId === msg.id ? 'Deleting...' : 'Delete for everyone'}</button>}
                  </div>
                )}
                <span className="text-[9px] text-neutral-600 mt-1 px-1 font-bold">{new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            );
          })
        )}
      </div>

      <div className="message-composer">
        <form onSubmit={handleSendMessage} className="flex gap-2">
          <input type="text" value={newMessage} onChange={handleTyping} placeholder="Message the room..." className="omni-input" />
          <button type="submit" disabled={!newMessage.trim()} className="omni-button omni-button-primary !min-h-0 !rounded-xl !px-3">
            {/* The corrected SVG is below without the extra </path> */}
            <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" /></svg>
          </button>
        </form>
      </div>
    </div>
  );
}
