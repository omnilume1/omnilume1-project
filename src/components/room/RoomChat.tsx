'use client';

import { useState, useEffect, useRef } from 'react';
import { createClient } from '@/utils/supabase/client';
import { useRoomSync } from '@/hooks/useRoomSync';
import { deleteMessageForEveryone } from '@/actions/chat';

interface RoomChatProps {
  roomId: string;
  currentUserRole: string | null;
}

export default function RoomChat({ roomId, currentUserRole }: RoomChatProps) {
  const [messages, setMessages] = useState<any[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [hiddenMessages, setHiddenMessages] = useState<Set<string>>(new Set());

  const scrollRef = useRef<HTMLDivElement>(null);
  const supabase = createClient();
  const { typingUsers, broadcastEvent } = useRoomSync(roomId);

  const isAdmin = currentUserRole === 'owner' || currentUserRole === 'admin';

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const savedHidden = localStorage.getItem(`hidden_msgs_${roomId}`);
      if (savedHidden) setHiddenMessages(new Set(JSON.parse(savedHidden)));
    }
  }, [roomId]);

  useEffect(() => {
    let isMounted = true;
    const setupChat = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user && isMounted) setCurrentUserId(user.id);

      const { data } = await supabase.from('messages').select('*').eq('room_id', roomId).order('created_at', { ascending: true });
      if (data && isMounted) setMessages(data);
    };
    setupChat();

    const chatChannel = supabase.channel(`chat_${roomId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `room_id=eq.${roomId}` }, (payload) => {
        if (isMounted) setMessages(prev => [...prev, payload.new]);
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `room_id=eq.${roomId}` }, (payload) => {
        if (isMounted) setMessages(prev => prev.map(msg => msg.id === payload.new.id ? payload.new : msg));
      })
      .subscribe();

    return () => { isMounted = false; supabase.removeChannel(chatChannel); };
  }, [roomId, supabase]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, typingUsers]);

  useEffect(() => {
    const handleClickOutside = () => setActiveMenuId(null);
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || !currentUserId) return;
    const messageText = newMessage.trim();
    setNewMessage('');
    await supabase.from('messages').insert({ room_id: roomId, sender_id: currentUserId, content: messageText });
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
    setActiveMenuId(null);
    setMessages(prev => prev.map(msg => msg.id === msgId ? { ...msg, is_deleted: true, content: '🚫 This message was deleted' } : msg));
    await deleteMessageForEveryone(msgId, roomId);
  };

  return (
    <div className="flex flex-col h-full bg-[#0a0a0a] border-l border-neutral-800 relative">
      <div className="p-4 border-b border-neutral-800 bg-[#0a0a0a] z-10 flex justify-between items-center shadow-md">
        <h3 className="text-white font-bold text-sm">Room Chat</h3>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
        {messages.length === 0 ? (
          <p className="text-xs text-neutral-500 text-center mt-10">No messages yet. Say hello!</p>
        ) : (
          messages.filter(msg => !hiddenMessages.has(msg.id)).map((msg) => {
            const isMe = msg.sender_id === currentUserId;
            return (
              <div key={msg.id} className={`flex flex-col relative group ${isMe ? 'items-end' : 'items-start'}`}>
                <div className={`relative max-w-[85%] px-4 py-2.5 rounded-2xl flex items-center gap-3 ${msg.is_deleted ? 'bg-transparent border border-neutral-800 text-neutral-500 italic' : isMe ? 'bg-indigo-600 text-white rounded-br-sm' : 'bg-neutral-800 text-white rounded-bl-sm'}`}>
                  <span className="text-sm leading-relaxed break-words">{msg.content}</span>
                  {!msg.is_deleted && (
                    <button onClick={(e) => { e.stopPropagation(); setActiveMenuId(activeMenuId === msg.id ? null : msg.id); }} className={`opacity-0 group-hover:opacity-100 transition p-1 hover:bg-black/20 rounded cursor-pointer ${isMe ? '-ml-2' : ''}`}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="19" r="1"></circle></svg>
                    </button>
                  )}
                </div>
                {activeMenuId === msg.id && (
                  <div className={`absolute top-full mt-1 z-50 bg-[#1a1a1a] border border-neutral-700 rounded-lg shadow-2xl py-1 w-40 flex flex-col overflow-hidden animate-in fade-in zoom-in-95 ${isMe ? 'right-0' : 'left-0'}`}>
                    <button onClick={(e) => { e.stopPropagation(); handleDeleteForMe(msg.id); }} className="px-4 py-2 text-left text-xs text-white hover:bg-neutral-800 font-semibold transition cursor-pointer">Delete for me</button>
                    {(isMe || isAdmin) && <button onClick={(e) => { e.stopPropagation(); handleDeleteForEveryone(msg.id); }} className="px-4 py-2 text-left text-xs text-red-400 hover:bg-neutral-800 font-semibold transition cursor-pointer">Delete for everyone</button>}
                  </div>
                )}
                <span className="text-[9px] text-neutral-600 mt-1 px-1 font-bold">{new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            );
          })
        )}
      </div>

      <div className="p-4 border-t border-neutral-800 bg-[#111]">
        <form onSubmit={handleSendMessage} className="flex gap-2">
          <input type="text" value={newMessage} onChange={handleTyping} placeholder="Message the room..." className="flex-1 bg-[#1a1a1a] border border-neutral-800 focus:border-indigo-500 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none transition shadow-inner" />
          <button type="submit" disabled={!newMessage.trim()} className="p-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-neutral-800 text-white rounded-xl transition cursor-pointer disabled:cursor-not-allowed">
            {/* The corrected SVG is below without the extra </path> */}
            <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" /></svg>
          </button>
        </form>
      </div>
    </div>
  );
}