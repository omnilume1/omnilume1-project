import { useEffect, useState } from 'react';
import { createClient } from '@/utils/supabase/client';

export interface RoomMessage {
  id: string;
  user_id: string;
  text: string;
  created_at: string;
}

export function useRoomChat(roomId: string) {
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const supabase = createClient();

  useEffect(() => {
    if (!roomId) return;

    // Fetch history
    const fetchMessages = async () => {
      const { data } = await supabase
        .from('room_messages')
        .select('*')
        .eq('room_id', roomId)
        .order('created_at', { ascending: true });
      if (data) setMessages(data);
    };
    fetchMessages();

    // Subscribe to live changes
    const channel = supabase
      .channel(`room_${roomId}`)
      .on('postgres_changes', 
        { event: 'INSERT', schema: 'public', table: 'room_messages', filter: `room_id=eq.${roomId}` }, 
        (payload: unknown) => {
          setMessages((prev) => [...prev, (payload as { new: RoomMessage }).new]);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [roomId, supabase]);

  return { messages };
}
