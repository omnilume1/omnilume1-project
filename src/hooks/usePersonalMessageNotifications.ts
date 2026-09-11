'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { createClient } from '@/utils/supabase/client';

const STORAGE_VERSION = 1;
const MAX_STORED_UNREAD = 500;
const STORAGE_PREFIX = 'omnilume:personal-unread:';

export interface PersonalNotificationContact {
  user_id: string;
  display_name: string | null;
  username: string | null;
  avatar_url: string | null;
  chat_id: string | null;
}

export interface PersonalMessageToast {
  id: string;
  chatId: string;
  senderId: string;
  senderName: string;
  senderUsername: string | null;
  senderAvatarUrl: string | null;
  preview: string;
  createdAt: string;
}

export interface PersonalMessageNotificationSnapshot {
  unreadCount: number;
  toasts: PersonalMessageToast[];
}

interface StoredUnreadMessage {
  id: string;
  chatId: string;
  senderId: string;
  createdAt: string;
}

interface PersonalMessageRow {
  id?: unknown;
  sender_id?: unknown;
  receiver_id?: unknown;
  chat_id?: unknown;
  room_id?: unknown;
  created_at?: unknown;
}

interface NotificationState {
  userId: string;
  unread: Map<string, StoredUnreadMessage>;
  toasts: PersonalMessageToast[];
  contacts: Map<string, PersonalNotificationContact>;
  listeners: Set<() => void>;
  channel: RealtimeChannel | null;
  activeChatId: string | null;
  storageListener: ((event: StorageEvent) => void) | null;
  stopTimer: ReturnType<typeof setTimeout> | null;
  snapshot: PersonalMessageNotificationSnapshot;
}

const states = new Map<string, NotificationState>();
const EMPTY_SNAPSHOT: PersonalMessageNotificationSnapshot = { unreadCount: 0, toasts: [] };
let signedInUserIdPromise: Promise<string | null> | null = null;

function storageKey(userId: string) {
  return `${STORAGE_PREFIX}${userId}`;
}

function getState(userId: string) {
  const existing = states.get(userId);
  if (existing) return existing;

  const state: NotificationState = {
    userId,
    unread: new Map(),
    toasts: [],
    contacts: new Map(),
    listeners: new Set(),
    channel: null,
    activeChatId: null,
    storageListener: null,
    stopTimer: null,
    snapshot: EMPTY_SNAPSHOT,
  };
  loadUnread(state);
  updateSnapshot(state);
  states.set(userId, state);
  return state;
}

function loadUnread(state: NotificationState) {
  if (typeof window === 'undefined') return;

  try {
    const raw = window.localStorage.getItem(storageKey(state.userId));
    if (!raw) return;
    const parsed = JSON.parse(raw) as { version?: unknown; messages?: unknown };
    if (parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.messages)) return;

    for (const item of parsed.messages.slice(-MAX_STORED_UNREAD)) {
      if (!item || typeof item !== 'object') continue;
      const message = item as Partial<StoredUnreadMessage>;
      if (typeof message.id !== 'string' || typeof message.chatId !== 'string' || typeof message.senderId !== 'string') continue;
      state.unread.set(message.id, {
        id: message.id,
        chatId: message.chatId,
        senderId: message.senderId,
        createdAt: typeof message.createdAt === 'string' ? message.createdAt : '',
      });
    }
  } catch {
    // A malformed local notification marker must never affect messaging.
  }
}

function persistUnread(state: NotificationState) {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(storageKey(state.userId), JSON.stringify({
      version: STORAGE_VERSION,
      messages: Array.from(state.unread.values()).slice(-MAX_STORED_UNREAD),
    }));
  } catch {
    // Notifications are an optional client convenience; storage failure is safe.
  }
}

function updateSnapshot(state: NotificationState) {
  state.snapshot = {
    unreadCount: state.unread.size,
    toasts: state.toasts,
  };
}

function emit(state: NotificationState) {
  updateSnapshot(state);
  state.listeners.forEach((listener) => listener());
}

function contactPresentation(state: NotificationState, senderId: string) {
  const contact = state.contacts.get(senderId);
  const senderName = contact?.display_name || contact?.username || 'New personal message';
  return {
    senderName,
    senderUsername: contact?.username ?? null,
    senderAvatarUrl: contact?.avatar_url ?? null,
  };
}

function refreshToastContacts(state: NotificationState) {
  state.toasts = state.toasts.map((toast) => ({
    ...toast,
    ...contactPresentation(state, toast.senderId),
  }));
}

function removeToast(state: NotificationState, messageId: string) {
  const nextToasts = state.toasts.filter((toast) => toast.id !== messageId);
  if (nextToasts.length === state.toasts.length) return;
  state.toasts = nextToasts;
  emit(state);
}

function handleIncomingMessage(state: NotificationState, payload: unknown) {
  const row = (payload as { new?: PersonalMessageRow } | null)?.new;
  const id = typeof row?.id === 'string' ? row.id : null;
  const senderId = typeof row?.sender_id === 'string' ? row.sender_id : null;
  const receiverId = typeof row?.receiver_id === 'string' ? row.receiver_id : null;
  const chatId = typeof row?.chat_id === 'string' ? row.chat_id : null;
  const roomId = typeof row?.room_id === 'string' ? row.room_id : null;
  if (!id || !senderId || !receiverId || receiverId !== state.userId || !chatId || roomId || senderId === state.userId) return;
  if (state.unread.has(id) || state.toasts.some((toast) => toast.id === id)) return;

  // An open conversation is already showing the message live, so it is read
  // immediately and must not create a second notification for the same event.
  if (state.activeChatId === chatId) return;

  const createdAt = typeof row?.created_at === 'string' ? row.created_at : new Date().toISOString();
  state.unread.set(id, { id, chatId, senderId, createdAt });
  const presentation = contactPresentation(state, senderId);
  state.toasts = [
    {
      id,
      chatId,
      senderId,
      ...presentation,
      // Ciphertext is intentionally never shown as a preview. The message is
      // decrypted only by the existing E2EE chat when it is opened.
      preview: 'New encrypted message',
      createdAt,
    },
    ...state.toasts,
  ].slice(0, 3);
  persistUnread(state);
  emit(state);
  window.setTimeout(() => removeToast(state, id), 7000);
}

function startState(state: NotificationState) {
  if (state.channel) return;

  const supabase = createClient();
  state.channel = supabase
    .channel(`personal_message_notifications_${state.userId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: `receiver_id=eq.${state.userId}` },
      (payload: unknown) => handleIncomingMessage(state, payload),
    )
    .subscribe();

  if (typeof window !== 'undefined') {
    state.storageListener = (event) => {
      if (event.key !== storageKey(state.userId)) return;
      state.unread.clear();
      loadUnread(state);
      state.toasts = state.toasts.filter((toast) => state.unread.has(toast.id));
      emit(state);
    };
    window.addEventListener('storage', state.storageListener);
  }
}

function stopState(state: NotificationState) {
  if (state.listeners.size > 0) return;
  if (state.stopTimer) {
    clearTimeout(state.stopTimer);
    state.stopTimer = null;
  }
  if (state.channel) {
    void state.channel.unsubscribe();
    state.channel = null;
  }
  if (state.storageListener && typeof window !== 'undefined') {
    window.removeEventListener('storage', state.storageListener);
    state.storageListener = null;
  }
}

function subscribeToState(userId: string, listener: () => void) {
  const state = getState(userId);
  if (state.stopTimer) {
    clearTimeout(state.stopTimer);
    state.stopTimer = null;
  }
  state.listeners.add(listener);
  startState(state);
  return () => {
    state.listeners.delete(listener);
    if (state.listeners.size === 0) {
      state.stopTimer = setTimeout(() => stopState(state), 0);
    }
  };
}

function getSnapshotForUser(userId: string | null) {
  return userId ? getState(userId).snapshot : EMPTY_SNAPSHOT;
}

function resolveSignedInUserId(): Promise<string | null> {
  if (signedInUserIdPromise) return signedInUserIdPromise;
  const promise = createClient().auth.getUser()
    .then((result: { data: { user: { id: string } | null } }) => result.data.user?.id ?? null)
    .catch(() => null);
  signedInUserIdPromise = promise;
  return promise;
}

export function registerPersonalNotificationContacts(userId: string, contacts: PersonalNotificationContact[]) {
  const state = getState(userId);
  state.contacts = new Map(contacts.map((contact) => [contact.user_id, contact]));
  refreshToastContacts(state);
  emit(state);
}

export function markPersonalChatRead(userId: string, chatId: string) {
  const state = getState(userId);
  let changed = false;
  for (const [messageId, message] of state.unread) {
    if (message.chatId === chatId) {
      state.unread.delete(messageId);
      changed = true;
    }
  }
  const nextToasts = state.toasts.filter((toast) => toast.chatId !== chatId);
  if (nextToasts.length !== state.toasts.length) {
    state.toasts = nextToasts;
    changed = true;
  }
  if (changed) {
    persistUnread(state);
    emit(state);
  }
}

export function setPersonalActiveChat(userId: string, chatId: string | null) {
  const state = getState(userId);
  state.activeChatId = chatId;
  if (chatId) markPersonalChatRead(userId, chatId);
}

export function dismissPersonalMessageToast(userId: string, messageId: string) {
  removeToast(getState(userId), messageId);
}

export function usePersonalMessageNotifications() {
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void resolveSignedInUserId().then((resolvedUserId) => {
      if (!cancelled) setUserId(resolvedUserId);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const subscribe = useCallback((listener: () => void) => (
    userId ? subscribeToState(userId, listener) : () => undefined
  ), [userId]);
  const getSnapshot = useCallback(() => getSnapshotForUser(userId), [userId]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_SNAPSHOT);

  const registerContacts = useCallback((contacts: PersonalNotificationContact[]) => {
    if (userId) registerPersonalNotificationContacts(userId, contacts);
  }, [userId]);
  const markChatRead = useCallback((chatId: string) => {
    if (userId) markPersonalChatRead(userId, chatId);
  }, [userId]);
  const setActiveChat = useCallback((chatId: string | null) => {
    if (userId) setPersonalActiveChat(userId, chatId);
  }, [userId]);
  const dismissToast = useCallback((messageId: string) => {
    if (userId) dismissPersonalMessageToast(userId, messageId);
  }, [userId]);

  return {
    userId,
    unreadCount: snapshot.unreadCount,
    toasts: snapshot.toasts,
    registerContacts,
    markChatRead,
    setActiveChat,
    dismissToast,
  };
}
