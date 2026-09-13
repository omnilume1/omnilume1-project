import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/utils/supabase/client';
import { decryptMessage } from '@/lib/encryption';
import { isIsoTimestamp, isUuid, isValidEncryptedPayload } from '@/lib/message-limits';

const PRIVATE_CHAT_PAGE_SIZE = 50;
const DECRYPT_BATCH_SIZE = 8;

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

interface MessageCursor { createdAt: string; id: string; }

function isEncryptedMessageRow(value: unknown): value is EncryptedMessageRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<EncryptedMessageRow>;
  return isUuid(row.id)
    && isUuid(row.sender_id)
    && isIsoTimestamp(row.created_at)
    && typeof row.ciphertext === 'string'
    && typeof row.iv === 'string'
    && isValidEncryptedPayload(row.ciphertext, row.iv);
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

async function decryptRows(rows: EncryptedMessageRow[], sharedKey: CryptoKey) {
  const decryptedMessages: ChatMessage[] = [];
  for (let index = 0; index < rows.length; index += DECRYPT_BATCH_SIZE) {
    const batch = rows.slice(index, index + DECRYPT_BATCH_SIZE);
    const settledMessages = await Promise.allSettled(
      batch.map(async (row) => ({
        id: row.id,
        sender_id: row.sender_id,
        created_at: row.created_at,
        text: await decryptMessageCached(row, sharedKey),
        decryptionStatus: 'decrypted' as const,
        ciphertext: row.ciphertext,
        iv: row.iv,
      })),
    );
    decryptedMessages.push(...settledMessages.map((result, batchIndex) => (
      result.status === 'fulfilled'
        ? result.value
        : createUndecryptableMessage(batch[batchIndex])
    )));
  }
  return decryptedMessages;
}

export function usePrivateChat(chatId: string | null, sharedKey: CryptoKey | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<PrivateChatStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const supabase = createClient();
  const oldestCursorRef = useRef<MessageCursor | null>(null);
  const loadingOlderRef = useRef(false);
  const generationRef = useRef(0);
  const realtimeDecryptQueueRef = useRef(Promise.resolve());
  const realtimeDecryptQueueLengthRef = useRef(0);

  const loadOlder = useCallback(async () => {
    const cursor = oldestCursorRef.current;
    if (!chatId || !sharedKey || !cursor || loadingOlderRef.current || !hasMore) return;

    loadingOlderRef.current = true;
    setIsLoadingOlder(true);
    const generation = generationRef.current;
    try {
      const { data, error: fetchError } = await supabase
        .from('messages')
        .select('id, sender_id, created_at, ciphertext, iv')
        .eq('chat_id', chatId)
        .or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(PRIVATE_CHAT_PAGE_SIZE);
      if (fetchError) throw fetchError;
      if (generation !== generationRef.current) return;

      const rawRows = data ?? [];
      const rows = rawRows.filter(isEncryptedMessageRow);
      const oldest = rawRows[rawRows.length - 1];
      if (isEncryptedMessageRow(oldest)) oldestCursorRef.current = { createdAt: oldest.created_at, id: oldest.id };
      setHasMore(rawRows.length === PRIVATE_CHAT_PAGE_SIZE && isEncryptedMessageRow(oldest));
      const decryptedMessages = await decryptRows(rows, sharedKey);
      if (generation === generationRef.current) {
        setMessages((current) => mergeMessages(current, decryptedMessages));
      }
    } catch {
      if (generation === generationRef.current) setError('Unable to load older encrypted messages.');
    } finally {
      loadingOlderRef.current = false;
      setIsLoadingOlder(false);
    }
  }, [chatId, hasMore, sharedKey, supabase]);

  useEffect(() => {
    let cancelled = false;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    oldestCursorRef.current = null;
    realtimeDecryptQueueRef.current = Promise.resolve();
    realtimeDecryptQueueLengthRef.current = 0;

    if (!sharedKey || !chatId) {
      return () => {
        cancelled = true;
        generationRef.current += 1;
      };
    }

    const fetchHistoricalMessages = async () => {
      setHasMore(false);
      setMessages([]);
      setStatus('loading');
      setError(null);

      try {
        const { data, error: fetchError } = await supabase
          .from('messages')
          .select('id, sender_id, created_at, ciphertext, iv')
          .eq('chat_id', chatId)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(PRIVATE_CHAT_PAGE_SIZE);

        if (fetchError) throw fetchError;

        const rawRows = data ?? [];
        const rows = rawRows.filter(isEncryptedMessageRow);
        const oldest = rawRows[rawRows.length - 1];
        if (isEncryptedMessageRow(oldest)) oldestCursorRef.current = { createdAt: oldest.created_at, id: oldest.id };
        setHasMore(rawRows.length === PRIVATE_CHAT_PAGE_SIZE && isEncryptedMessageRow(oldest));
        const decryptedMessages = await decryptRows(rows, sharedKey);

        if (!cancelled && generation === generationRef.current) {
          setMessages((current) => mergeMessages(current, decryptedMessages.reverse()));
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
          const newPayload = (payload as { new: unknown }).new;
          if (!isEncryptedMessageRow(newPayload)) return;
          if (realtimeDecryptQueueLengthRef.current >= 50) return;
          realtimeDecryptQueueLengthRef.current += 1;
          realtimeDecryptQueueRef.current = realtimeDecryptQueueRef.current.then(async () => {
            const result = await Promise.allSettled([decryptMessageCached(newPayload, sharedKey)]).then(([settled]) => settled);
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
          }).catch(() => undefined).finally(() => {
            realtimeDecryptQueueLengthRef.current = Math.max(0, realtimeDecryptQueueLengthRef.current - 1);
          });
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      generationRef.current += 1;
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
    hasMore,
    isLoadingOlder,
    loadOlder,
    retry: () => setReloadToken((token) => token + 1),
    addOptimisticMessage,
    removeOptimisticMessage,
  };
}
