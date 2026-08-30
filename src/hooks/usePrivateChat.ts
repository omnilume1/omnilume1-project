import { useEffect, useState } from 'react';
import { createClient } from '@/utils/supabase/client';
import { decryptMessage } from '@/lib/encryption';

export interface ChatMessage {
  id: string;
  sender_id: string;
  text: string;
  created_at: string;
}

interface EncryptedMessageRow {
  id: string;
  sender_id: string;
  created_at: string;
  ciphertext: string;
  iv: string;
}

export function usePrivateChat(chatId: string | null, sharedKey: CryptoKey | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const supabase = createClient();

  useEffect(() => {
    if (!sharedKey || !chatId) return;

    const fetchHistoricalMessages = async () => {
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('chat_id', chatId)
        .order('created_at', { ascending: true });

      if (data && !error) {
        const decryptedPromises = (data as EncryptedMessageRow[]).map(async (msg) => ({
          id: msg.id,
          sender_id: msg.sender_id,
          created_at: msg.created_at,
          text: await decryptMessage(msg.ciphertext, msg.iv, sharedKey),
        }));
        
        const decryptedMessages = await Promise.all(decryptedPromises);
        setMessages(decryptedMessages);
      }
    };

    fetchHistoricalMessages();

    const channel = supabase
      .channel(`chat_${chatId}`)
      .on('postgres_changes', 
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `chat_id=eq.${chatId}` }, 
        async (payload: unknown) => {
          const newPayload = (payload as { new: EncryptedMessageRow }).new;
          const decryptedText = await decryptMessage(newPayload.ciphertext, newPayload.iv, sharedKey);
          
          setMessages((prev) => [
            ...prev, 
            {
              id: newPayload.id,
              sender_id: newPayload.sender_id,
              created_at: newPayload.created_at,
              text: decryptedText,
            }
          ]);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [chatId, sharedKey, supabase]);

  return { messages };
}
