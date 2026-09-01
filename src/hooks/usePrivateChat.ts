import { useEffect, useState } from 'react';
import { createClient } from '@/utils/supabase/client';
import { decryptMessage } from '@/lib/encryption';

export type ChatMessageDecryptionStatus = 'decrypted' | 'undecryptable';
export type PrivateChatStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ChatMessage {
  id: string;
  sender_id: string;
  text: string | null;
  created_at: string;
  decryptionStatus: ChatMessageDecryptionStatus;
}

interface EncryptedMessageRow {
  id: string;
  sender_id: string;
  created_at: string;
  ciphertext: string;
  iv: string;
}

function createUndecryptableMessage(row: EncryptedMessageRow): ChatMessage {
  return {
    id: row.id,
    sender_id: row.sender_id,
    created_at: row.created_at,
    text: null,
    decryptionStatus: 'undecryptable',
  };
}

function sortMessages(messages: ChatMessage[]) {
  return [...messages].sort((left, right) => {
    const byTimestamp = left.created_at.localeCompare(right.created_at);
    return byTimestamp || left.id.localeCompare(right.id);
  });
}

function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]) {
  const messagesById = new Map(current.map((message) => [message.id, message]));
  incoming.forEach((message) => messagesById.set(message.id, message));
  return sortMessages(Array.from(messagesById.values()));
}

export function usePrivateChat(chatId: string | null, sharedKey: CryptoKey | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<PrivateChatStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const supabase = createClient();

  useEffect(() => {
    let cancelled = false;

    if (!sharedKey || !chatId) {
      return () => {
        cancelled = true;
      };
    }

    const fetchHistoricalMessages = async () => {
      setMessages([]);
      setStatus('loading');
      setError(null);

      try {
        const { data, error: fetchError } = await supabase
          .from('messages')
          .select('id, sender_id, created_at, ciphertext, iv')
          .eq('chat_id', chatId)
          .order('created_at', { ascending: true });

        if (fetchError) throw fetchError;

        const rows = (data ?? []) as EncryptedMessageRow[];
        const settledMessages = await Promise.allSettled(
          rows.map(async (row) => ({
            id: row.id,
            sender_id: row.sender_id,
            created_at: row.created_at,
            text: await decryptMessage(row.ciphertext, row.iv, sharedKey),
            decryptionStatus: 'decrypted' as const,
          })),
        );

        const decryptedMessages = settledMessages.map((result, index) => (
          result.status === 'fulfilled'
            ? result.value
            : createUndecryptableMessage(rows[index])
        ));

        if (!cancelled) {
          setMessages((current) => mergeMessages(current, decryptedMessages));
          setStatus('ready');
        }
      } catch {
        if (!cancelled) {
          setStatus('error');
          setError('Unable to load encrypted messages. Please try again.');
        }
      }
    };

    void fetchHistoricalMessages();

    const channel = supabase
      .channel(`chat_${chatId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `chat_id=eq.${chatId}` },
        (payload: unknown) => {
          const newPayload = (payload as { new: EncryptedMessageRow }).new;
          void Promise.allSettled([
            decryptMessage(newPayload.ciphertext, newPayload.iv, sharedKey),
          ]).then(([result]) => {
            if (cancelled) return;

            const message = result.status === 'fulfilled'
              ? {
                  id: newPayload.id,
                  sender_id: newPayload.sender_id,
                  created_at: newPayload.created_at,
                  text: result.value,
                  decryptionStatus: 'decrypted' as const,
                }
              : createUndecryptableMessage(newPayload);

            setMessages((current) => mergeMessages(current, [message]));
          });
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [chatId, sharedKey, supabase, reloadToken]);

  return {
    messages,
    status,
    error,
    retry: () => setReloadToken((token) => token + 1),
  };
}
