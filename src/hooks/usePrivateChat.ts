import { useCallback, useEffect, useState } from 'react';
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
  ciphertext?: string;
  iv?: string;
  pending?: boolean;
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
    ciphertext: row.ciphertext,
    iv: row.iv,
  };
}

const decryptPromises = new WeakMap<CryptoKey, Map<string, Promise<string>>>();

function encryptedMessageCacheKey(row: Pick<EncryptedMessageRow, 'id' | 'ciphertext' | 'iv'>) {
  return `${row.id}:${row.ciphertext}:${row.iv}`;
}

function decryptMessageCached(row: EncryptedMessageRow, sharedKey: CryptoKey) {
  let keyCache = decryptPromises.get(sharedKey);
  if (!keyCache) {
    keyCache = new Map<string, Promise<string>>();
    decryptPromises.set(sharedKey, keyCache);
  }

  const cacheKey = encryptedMessageCacheKey(row);
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;

  const promise = decryptMessage(row.ciphertext, row.iv, sharedKey).catch((error: unknown) => {
    // Do not retain failed decryptions. A later refresh with the same session
    // key should be able to retry a transient browser/runtime failure.
    keyCache?.delete(cacheKey);
    throw error;
  });
  keyCache.set(cacheKey, promise);
  return promise;
}

function sortMessages(messages: ChatMessage[]) {
  return [...messages].sort((left, right) => {
    const byTimestamp = left.created_at.localeCompare(right.created_at);
    return byTimestamp || left.id.localeCompare(right.id);
  });
}

function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]) {
  const incomingEncryptedKeys = new Set(
    incoming
      .map((message) => message.ciphertext && message.iv ? `${message.ciphertext}:${message.iv}` : null)
      .filter((value): value is string => value !== null),
  );
  const messagesById = new Map(current.map((message) => [message.id, message]));
  for (const [id, message] of messagesById) {
    if (id.startsWith('optimistic-') && message.ciphertext && message.iv
      && incomingEncryptedKeys.has(`${message.ciphertext}:${message.iv}`)) {
      messagesById.delete(id);
    }
  }
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
            text: await decryptMessageCached(row, sharedKey),
            decryptionStatus: 'decrypted' as const,
            ciphertext: row.ciphertext,
            iv: row.iv,
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
            decryptMessageCached(newPayload, sharedKey),
          ]).then(([result]) => {
            if (cancelled) return;

            const message = result.status === 'fulfilled'
              ? {
                  id: newPayload.id,
                  sender_id: newPayload.sender_id,
                  created_at: newPayload.created_at,
                  text: result.value,
                  decryptionStatus: 'decrypted' as const,
                  ciphertext: newPayload.ciphertext,
                  iv: newPayload.iv,
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

  const addOptimisticMessage = useCallback((message: {
    sender_id: string;
    text: string;
    ciphertext: string;
    iv: string;
  }) => {
    const id = `optimistic-${window.crypto.randomUUID()}`;
    setMessages((current) => mergeMessages(current, [{
      id,
      sender_id: message.sender_id,
      text: message.text,
      created_at: new Date().toISOString(),
      decryptionStatus: 'decrypted',
      ciphertext: message.ciphertext,
      iv: message.iv,
      pending: true,
    }]));
    return id;
  }, []);

  const removeOptimisticMessage = useCallback((id: string) => {
    setMessages((current) => current.filter((message) => message.id !== id));
  }, []);

  return {
    messages,
    status,
    error,
    retry: () => setReloadToken((token) => token + 1),
    addOptimisticMessage,
    removeOptimisticMessage,
  };
}
