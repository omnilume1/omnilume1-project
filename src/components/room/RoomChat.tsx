'use client';

import { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo, useId, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createClient } from '@/utils/supabase/client';
import { useRoomRealtime } from '@/components/room/RoomRealtimeProvider';
import { deleteMessageForEveryone } from '@/actions/chat';
import { isIsoTimestamp, isUuid, isValidRoomMessageContent, ROOM_MESSAGE_MAX_CHARS } from '@/lib/message-limits';
import { formatGifMessage, giphyImageUrl, parseGifMessage } from '@/lib/gif-message';
import {
  ROOM_MESSAGE_COLUMNS,
  ROOM_REACTION_EMOJIS,
  ROOM_REACTION_LABELS,
  activeMentionQuery,
  canEditMessage,
  firstUnreadMessageId,
  insertMention,
  memberLabel,
  mentionSuggestions,
  messageSegments,
  pinnedMessages,
  reactionChips,
  replyPreview,
  type MemberIdentity,
  type RoomChatMessage,
} from '@/lib/room-chat-model';
import { OmniIcon } from '@/components/ui/OmniIcon';
import GifPicker from '@/components/room/GifPicker';
import { useBookmarks } from '@/components/room/BookmarkButton';
import type { GifResult } from '@/actions/gifs';

const ROOM_CHAT_PAGE_SIZE = 50;
const MARK_READ_INTERVAL_MS = 3_000;

interface RoomChatProps {
  roomId: string;
}

interface RoomAnnouncementMessage { id: string; body: string; is_pinned: boolean; created_at: string; }
interface MessageCursor { createdAt: string; id: string; }
type RoomChatMessageUpdate = Partial<RoomChatMessage> & Pick<RoomChatMessage, 'id'>;

const isOptionalTimestamp = (value: unknown) => value === undefined || value === null || isIsoTimestamp(value);
const isOptionalUuid = (value: unknown) => value === undefined || value === null || isUuid(value);
const isOptionalSummary = (value: unknown) => value === undefined || value === null || (typeof value === 'object' && !Array.isArray(value));

function hasValidOptionalFields(message: Partial<RoomChatMessage>) {
  return isOptionalTimestamp(message.edited_at)
    && isOptionalUuid(message.reply_to_id)
    && isOptionalTimestamp(message.pinned_at)
    && isOptionalUuid(message.pinned_by)
    && isOptionalSummary(message.reaction_summary);
}

function isRoomChatMessage(value: unknown): value is RoomChatMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<RoomChatMessage>;
  return isUuid(message.id)
    && isUuid(message.sender_id)
    && isIsoTimestamp(message.created_at)
    && (message.content === null || (typeof message.content === 'string' && isValidRoomMessageContent(message.content)))
    && hasValidOptionalFields(message);
}

function isRoomChatMessageUpdate(value: unknown): value is RoomChatMessageUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Partial<RoomChatMessage>;
  return isUuid(message.id)
    && (message.content === undefined || message.content === null || (typeof message.content === 'string' && isValidRoomMessageContent(message.content)))
    && (message.is_deleted === undefined || typeof message.is_deleted === 'boolean')
    && hasValidOptionalFields(message);
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

function messageError(error: { code?: string; message?: string } | null | undefined, fallback: string) {
  if (!error) return fallback;
  if (error.code === '42501') return error.message && !/permission denied|row-level security/i.test(error.message) ? error.message : 'You do not have permission to do that in this room.';
  if (error.code === '23514' || error.code === 'P0002' || error.code === '22023') return error.message || fallback;
  return fallback;
}

export default function RoomChat({ roomId }: RoomChatProps) {
  const bookmarks = useBookmarks('message', roomId);
  const [messages, setMessages] = useState<RoomChatMessage[]>([]);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [announcements, setAnnouncements] = useState<RoomAnnouncementMessage[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [identities, setIdentities] = useState<MemberIdentity[]>([]);
  const [identitiesLoaded, setIdentitiesLoaded] = useState(false);
  const [canPin, setCanPin] = useState(false);
  const [pinnedExtra, setPinnedExtra] = useState<Record<string, RoomChatMessage>>({});
  const [pinnedIndex, setPinnedIndex] = useState(0);
  const [replyTargets, setReplyTargets] = useState<Record<string, RoomChatMessage>>({});
  const [dividerMessageId, setDividerMessageId] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<RoomChatMessage | null>(null);
  const [editing, setEditing] = useState<RoomChatMessage | null>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [reactionPickerFor, setReactionPickerFor] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [hiddenMessages, setHiddenMessages] = useState<Set<string>>(new Set());
  const [chatError, setChatError] = useState<string | null>(null);
  const [deletingMessageId, setDeletingMessageId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const oldestCursorRef = useRef<MessageCursor | null>(null);
  const loadingOlderRef = useRef(false);
  const preserveScrollRef = useRef<{ height: number; top: number } | null>(null);
  const nearBottomRef = useRef(true);
  const lastMessageIdRef = useRef<string | null>(null);
  const initialScrollDoneRef = useRef(false);
  const requestedReplyTargetsRef = useRef(new Set<string>());
  const lastMarkReadRef = useRef(0);
  const markReadTimerRef = useRef<number | null>(null);
  const highlightTimerRef = useRef<number | null>(null);
  const mentionListId = useId();
  const supabase = useMemo(() => createClient(), []);
  const { currentUserId: roomCurrentUserId, typingUsers, broadcastEvent, roomMessageEvents, roomControlVersion, connectionGeneration } = useRoomRealtime();
  const me = currentUserId ?? roomCurrentUserId ?? null;

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const savedHidden = localStorage.getItem(`hidden_msgs_${roomId}`);
      if (savedHidden) {
        const timer = window.setTimeout(() => {
          try {
            const parsed = JSON.parse(savedHidden);
            if (Array.isArray(parsed) && parsed.every((value): value is string => typeof value === 'string')) {
              setHiddenMessages(new Set(parsed));
            }
          } catch {
            // Ignore malformed local-only preferences.
          }
        }, 0);
        return () => window.clearTimeout(timer);
      }
    }
  }, [roomId]);

  // Read markers use the server clock and never move back (mark_room_read).
  const markRead = useCallback(() => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    const run = () => {
      lastMarkReadRef.current = Date.now();
      markReadTimerRef.current = null;
      // Builders are lazy: the request is sent only when the promise is consumed.
      void supabase.rpc('mark_room_read', { p_room_id: roomId }).then(() => undefined, () => undefined);
    };
    const wait = MARK_READ_INTERVAL_MS - (Date.now() - lastMarkReadRef.current);
    if (wait <= 0) run();
    else if (markReadTimerRef.current === null) markReadTimerRef.current = window.setTimeout(run, wait);
  }, [roomId, supabase]);

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') markRead(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      // Leaving the chat flushes a pending (throttled) read marker.
      if (markReadTimerRef.current !== null) {
        window.clearTimeout(markReadTimerRef.current);
        markReadTimerRef.current = null;
        void supabase.rpc('mark_room_read', { p_room_id: roomId }).then(() => undefined, () => undefined);
      }
    };
  }, [markRead, roomId, supabase]);

  useEffect(() => {
    let isMounted = true;
    oldestCursorRef.current = null;
    initialScrollDoneRef.current = false;
    const setupChat = async () => {
      setMessages([]);
      setHasMoreMessages(false);
      setDividerMessageId(null);
      const { data: { user } } = await supabase.auth.getUser();
      if (user && isMounted) setCurrentUserId(user.id);

      const [pageResult, readResult] = await Promise.all([
        supabase
          .from('messages')
          .select(ROOM_MESSAGE_COLUMNS)
          .eq('room_id', roomId)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(ROOM_CHAT_PAGE_SIZE),
        supabase.from('room_read_states').select('last_read_at').eq('room_id', roomId).maybeSingle(),
      ]);
      if (pageResult.error || !isMounted) return;

      const rawPage = (pageResult.data ?? []) as unknown[];
      const page = rawPage.filter(isRoomChatMessage);
      const oldest = rawPage[rawPage.length - 1];
      if (isRoomChatMessage(oldest)) oldestCursorRef.current = { createdAt: oldest.created_at, id: oldest.id };
      setHasMoreMessages(rawPage.length === ROOM_CHAT_PAGE_SIZE && isRoomChatMessage(oldest));
      const ordered = [...page].reverse();
      const lastReadAt = typeof readResult.data?.last_read_at === 'string' ? readResult.data.last_read_at : null;
      setDividerMessageId(firstUnreadMessageId(ordered, lastReadAt, user?.id ?? null));
      setMessages((current) => ordered.reduce(mergeMessage, current));
      markRead();
    };
    void setupChat();

    return () => { isMounted = false; };
  }, [markRead, roomId, supabase]);

  // Postgres Changes does not replay rows committed before the feed became
  // ready: neither the gap after the initial fetch nor time spent
  // disconnected. Each time the feed is (re)confirmed, re-read the newest page
  // and the pinned messages through RLS. mergeMessage de-duplicates by id.
  useEffect(() => {
    if (connectionGeneration < 1) return;
    let active = true;
    void (async () => {
      const [pageResult, pinnedResult] = await Promise.all([
        supabase
          .from('messages')
          .select(ROOM_MESSAGE_COLUMNS)
          .eq('room_id', roomId)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(ROOM_CHAT_PAGE_SIZE),
        supabase
          .from('messages')
          .select(ROOM_MESSAGE_COLUMNS)
          .eq('room_id', roomId)
          .not('pinned_at', 'is', null)
          .order('pinned_at', { ascending: false })
          .limit(5),
      ]);
      if (!active) return;
      if (!pageResult.error) {
        const page = ((pageResult.data ?? []) as unknown[]).filter(isRoomChatMessage);
        if (page.length > 0) setMessages((current) => [...page].reverse().reduce(mergeMessage, current));
      }
      if (!pinnedResult.error) {
        const pinned = ((pinnedResult.data ?? []) as unknown[]).filter(isRoomChatMessage);
        setPinnedExtra(Object.fromEntries(pinned.map((message) => [message.id, message])));
      }
    })();
    return () => { active = false; };
  }, [connectionGeneration, roomId, supabase]);

  const loadOlderMessages = useCallback(async () => {
    const cursor = oldestCursorRef.current;
    if (!cursor || loadingOlderRef.current) return;

    loadingOlderRef.current = true;
    setIsLoadingOlder(true);
    const scroller = scrollRef.current;
    if (scroller) preserveScrollRef.current = { height: scroller.scrollHeight, top: scroller.scrollTop };

    try {
      const { data, error } = await supabase
        .from('messages')
        .select(ROOM_MESSAGE_COLUMNS)
        .eq('room_id', roomId)
        .or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(ROOM_CHAT_PAGE_SIZE);
      if (error) throw error;

      const rawPage = (data ?? []) as unknown[];
      const page = rawPage.filter(isRoomChatMessage);
      if (page.length === 0) preserveScrollRef.current = null;
      const oldest = rawPage[rawPage.length - 1];
      if (isRoomChatMessage(oldest)) oldestCursorRef.current = { createdAt: oldest.created_at, id: oldest.id };
      setHasMoreMessages(rawPage.length === ROOM_CHAT_PAGE_SIZE && isRoomChatMessage(oldest));
      if (page.length > 0) {
        setMessages((current) => [...page].reverse().reduce(mergeMessage, current));
      }
    } catch {
      preserveScrollRef.current = null;
      setChatError('Unable to load older messages.');
    } finally {
      loadingOlderRef.current = false;
      setIsLoadingOlder(false);
    }
  }, [roomId, supabase]);

  useEffect(() => {
    if (roomMessageEvents.length === 0) return;

    const timer = window.setTimeout(() => {
      setMessages((current) => roomMessageEvents.reduce((messagesForEvent, event) => {
        if (event.kind === 'insert' && isRoomChatMessage(event.message)) {
          return mergeMessage(messagesForEvent, event.message);
        }
        if (event.kind === 'update' && isRoomChatMessageUpdate(event.message)) {
          return messagesForEvent.map((message) => message.id === event.message.id
            ? { ...message, ...event.message }
            : message);
        }
        return messagesForEvent;
      }, current));
      // Pins of messages older than the loaded page arrive as full rows.
      setPinnedExtra((current) => {
        let next = current;
        for (const event of roomMessageEvents) {
          if (event.kind !== 'update' || !isRoomChatMessage(event.message)) continue;
          const message = event.message;
          if (message.pinned_at && !message.is_deleted) next = { ...next, [message.id]: message };
          else if (next[message.id]) {
            next = { ...next };
            delete next[message.id];
          }
        }
        return next;
      });
      markRead();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [markRead, roomMessageEvents]);

  // Announcements are readable by approved members while the room has them
  // enabled (RLS); read directly so chat does not queue behind server actions.
  useEffect(() => {
    let active = true;
    void (async () => {
      const { data, error } = await supabase
        .from('room_announcements')
        .select('id, body, is_pinned, created_at')
        .eq('room_id', roomId)
        .order('is_pinned', { ascending: false })
        .order('created_at', { ascending: false });
      if (active && !error) setAnnouncements((data ?? []) as RoomAnnouncementMessage[]);
    })();
    return () => { active = false; };
  }, [roomControlVersion, roomId, supabase]);

  // Names for senders, replies and @mention suggestions (membership changes
  // arrive as room control events). Read straight from the
  // membership-checked RPC rather than a server action, so the chat does not
  // wait behind the room page's queued server actions.
  useEffect(() => {
    let active = true;
    void (async () => {
      const { data, error } = await supabase.rpc('get_room_member_identities', { p_room_id: roomId });
      if (!active || error) return;
      setIdentities((Array.isArray(data) ? data : []) as MemberIdentity[]);
      setIdentitiesLoaded(true);
    })();
    return () => { active = false; };
  }, [roomControlVersion, roomId, supabase]);

  // Pin controls are shown to members who manage announcements; the server
  // re-checks on every pin (set_room_message_pin).
  useEffect(() => {
    if (!me) return;
    let active = true;
    void (async () => {
      const { data, error } = await supabase.rpc('room_has_capability', { p_room_id: roomId, p_user_id: me, p_capability: 'manage_announcements' });
      if (active) setCanPin(!error && data === true);
    })();
    return () => { active = false; };
  }, [me, roomControlVersion, roomId, supabase]);

  const messagesById = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages]);
  const identityById = useMemo(() => new Map(identities.map((identity) => [identity.user_id, identity])), [identities]);
  const visibleMessages = useMemo(() => messages.filter((message) => !hiddenMessages.has(message.id)), [hiddenMessages, messages]);
  const pinned = useMemo(() => {
    const merged = new Map<string, RoomChatMessage>(Object.entries(pinnedExtra));
    for (const message of messages) if (message.pinned_at || merged.has(message.id)) merged.set(message.id, message);
    return pinnedMessages(merged.values());
  }, [messages, pinnedExtra]);
  const currentPinned = pinned.length > 0 ? pinned[Math.min(pinnedIndex, pinned.length - 1)] : null;
  const suggestions = useMemo(() => (mention ? mentionSuggestions(identities, mention.query, me) : []), [identities, me, mention]);

  // Reply targets older than the loaded page are fetched once, by id.
  useEffect(() => {
    const missing = [...new Set(messages.map((message) => message.reply_to_id).filter((id): id is string => Boolean(id)))]
      .filter((id) => !messagesById.has(id) && !replyTargets[id] && !requestedReplyTargetsRef.current.has(id))
      .slice(0, 50);
    if (missing.length === 0) return;
    missing.forEach((id) => requestedReplyTargetsRef.current.add(id));
    void (async () => {
      const { data, error } = await supabase.from('messages').select(ROOM_MESSAGE_COLUMNS).eq('room_id', roomId).in('id', missing);
      if (error) return;
      const rows = ((data ?? []) as unknown[]).filter(isRoomChatMessage);
      if (rows.length > 0) setReplyTargets((current) => ({ ...current, ...Object.fromEntries(rows.map((row) => [row.id, row])) }));
    })();
  }, [messages, messagesById, replyTargets, roomId, supabase]);

  // "Former member" only once names have loaded and the sender is not among them.
  const senderName = useCallback((userId: string) => (
    userId === me ? 'You' : memberLabel(identityById.get(userId), identitiesLoaded ? 'Former member' : 'Member')
  ), [identitiesLoaded, identityById, me]);

  const highlight = useCallback((messageId: string) => {
    const element = document.getElementById(`message-${messageId}`);
    if (!element) return false;
    element.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setHighlightId(messageId);
    if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = window.setTimeout(() => setHighlightId(null), 2_200);
    return true;
  }, []);

  const jumpTo = useCallback((messageId: string) => {
    if (!highlight(messageId)) setChatError('That message is older than the loaded history. Use "Load older messages" to find it.');
  }, [highlight]);

  // Notification links point at #message-<id>.
  useEffect(() => {
    const fromHash = () => {
      const match = /^#message-([0-9a-f-]{36})$/i.exec(window.location.hash);
      if (match) highlight(match[1]);
    };
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, [highlight]);

  useEffect(() => () => { if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current); }, []);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const preserved = preserveScrollRef.current;
    if (preserved) {
      scroller.scrollTop = preserved.top + (scroller.scrollHeight - preserved.height);
      preserveScrollRef.current = null;
      return;
    }
    const last = visibleMessages[visibleMessages.length - 1];
    const lastId = last?.id ?? null;
    const appended = lastId !== lastMessageIdRef.current;
    lastMessageIdRef.current = lastId;
    if (!initialScrollDoneRef.current) {
      if (!lastId) return;
      initialScrollDoneRef.current = true;
      const hash = /^#message-([0-9a-f-]{36})$/i.exec(window.location.hash);
      if (hash && document.getElementById(`message-${hash[1]}`)) {
        const target = hash[1];
        window.requestAnimationFrame(() => highlight(target));
        return;
      }
      const divider = dividerMessageId ? document.getElementById(`message-${dividerMessageId}`) : null;
      if (divider) divider.scrollIntoView({ block: 'center' });
      else scroller.scrollTop = scroller.scrollHeight;
      return;
    }
    if ((appended && (nearBottomRef.current || last?.sender_id === me)) || (!appended && nearBottomRef.current)) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, [dividerMessageId, highlight, me, typingUsers, visibleMessages]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-message-menu-area]')) return;
      setActiveMenuId(null);
      setReactionPickerFor(null);
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  const [showGifPicker, setShowGifPicker] = useState(false);
  const closeGifPicker = useCallback(() => setShowGifPicker(false), [setShowGifPicker]);

  const resetComposerModes = () => {
    setReplyTo(null);
    setEditing(null);
    setMention(null);
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (editing) {
      await saveEdit(editing, newMessage.trim());
      return;
    }
    await sendRoomContent(newMessage.trim(), true);
  };

  const handleSendGif = async (gif: GifResult) => {
    setShowGifPicker(false);
    await sendRoomContent(formatGifMessage({ id: gif.id, title: gif.title }), false);
  };

  // A GIF is an ordinary room message, so it uses the same RLS-checked insert
  // (chat capability) and reaches members through Postgres Changes. The
  // database validates the reply target and fills server-owned columns.
  const sendRoomContent = async (messageText: string, fromComposer: boolean) => {
    if (!isValidRoomMessageContent(messageText)) {
      setChatError(`Messages must be 1-${ROOM_MESSAGE_MAX_CHARS} characters.`);
      return;
    }

    const senderId = me ?? (await supabase.auth.getUser()).data.user?.id ?? null;
    if (!senderId) {
      setChatError('Unable to send message. Please sign in again.');
      return;
    }

    if (!currentUserId) setCurrentUserId(senderId);

    const replyTarget = replyTo;
    if (fromComposer) setNewMessage('');
    setReplyTo(null);
    setMention(null);
    const { data, error } = await supabase
      .from('messages')
      .insert({ room_id: roomId, sender_id: senderId, content: messageText, reply_to_id: replyTarget?.id ?? null })
      .select(ROOM_MESSAGE_COLUMNS)
      .single();

    if (error || !data) {
      if (fromComposer) setNewMessage(messageText);
      setReplyTo(replyTarget);
      setChatError(messageError(error, 'Unable to send message.'));
      return;
    }

    // Other members receive the row through RLS-checked Postgres Changes, not
    // Broadcast, so chat text never reaches a stale or removed connection.
    if (isRoomChatMessage(data)) setMessages((current) => mergeMessage(current, data));
  };

  const saveEdit = async (message: RoomChatMessage, text: string) => {
    if (text === (message.content ?? '').trim()) {
      resetComposerModes();
      setNewMessage('');
      return;
    }
    if (!isValidRoomMessageContent(text)) {
      setChatError(`Messages must be 1-${ROOM_MESSAGE_MAX_CHARS} characters.`);
      return;
    }
    setPendingAction(`edit:${message.id}`);
    const { data, error } = await supabase
      .from('messages')
      .update({ content: text })
      .eq('id', message.id)
      .eq('room_id', roomId)
      .eq('sender_id', me ?? '')
      .eq('is_deleted', false)
      .select(ROOM_MESSAGE_COLUMNS)
      .maybeSingle();
    setPendingAction(null);
    if (error || !data) {
      setChatError(messageError(error, 'Unable to edit this message.'));
      return;
    }
    if (isRoomChatMessage(data)) setMessages((current) => mergeMessage(current, data));
    resetComposerModes();
    setNewMessage('');
  };

  const toggleReaction = async (messageId: string, emoji: string) => {
    const key = `react:${messageId}:${emoji}`;
    if (pendingAction === key) return;
    setReactionPickerFor(null);
    setActiveMenuId(null);
    setPendingAction(key);
    const { data, error } = await supabase.rpc('toggle_room_message_reaction', { p_message_id: messageId, p_emoji: emoji });
    setPendingAction(null);
    if (error) {
      setChatError(messageError(error, 'Unable to update that reaction.'));
      return;
    }
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      setMessages((current) => current.map((message) => message.id === messageId ? { ...message, reaction_summary: data as Record<string, unknown> } : message));
    }
  };

  const setPin = async (message: RoomChatMessage, pinnedState: boolean) => {
    setActiveMenuId(null);
    setPendingAction(`pin:${message.id}`);
    const { data, error } = await supabase.rpc('set_room_message_pin', { p_message_id: message.id, p_pinned: pinnedState });
    setPendingAction(null);
    if (error) {
      setChatError(messageError(error, pinnedState ? 'Unable to pin this message.' : 'Unable to unpin this message.'));
      return;
    }
    const pinnedAt = typeof data === 'string' ? data : null;
    const updated = { ...message, pinned_at: pinnedAt, pinned_by: pinnedAt ? me : null };
    setMessages((current) => current.map((entry) => entry.id === message.id ? { ...entry, pinned_at: updated.pinned_at, pinned_by: updated.pinned_by } : entry));
    setPinnedExtra((current) => {
      const next = { ...current };
      if (pinnedAt) next[message.id] = updated;
      else delete next[message.id];
      return next;
    });
    if (pinnedAt) setPinnedIndex(0);
  };

  const startReply = (message: RoomChatMessage) => {
    setEditing(null);
    setReplyTo(message);
    setActiveMenuId(null);
    inputRef.current?.focus();
  };

  const startEdit = (message: RoomChatMessage) => {
    setReplyTo(null);
    setEditing(message);
    setNewMessage(message.content ?? '');
    setActiveMenuId(null);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  const cancelComposerMode = () => {
    if (editing) setNewMessage('');
    resetComposerModes();
  };

  const refreshMention = (text: string, caret: number | null) => {
    const next = caret === null ? null : activeMentionQuery(text, caret);
    setMention(next);
    setMentionIndex(0);
  };

  const handleTyping = (e: React.ChangeEvent<HTMLInputElement>) => {
    setNewMessage(e.target.value);
    refreshMention(e.target.value, e.target.selectionStart);
    broadcastEvent('typing', { sender_id: me });
  };

  const chooseMention = (identity: MemberIdentity) => {
    if (!mention || !identity.username) return;
    const caret = inputRef.current?.selectionStart ?? newMessage.length;
    const next = insertMention(newMessage, mention.start, caret, identity.username);
    setNewMessage(next.text);
    setMention(null);
    window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.caret, next.caret);
    }, 0);
  };

  const handleComposerKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (mention && suggestions.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setMentionIndex((index) => (index + step + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        chooseMention(suggestions[Math.min(mentionIndex, suggestions.length - 1)]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMention(null);
        return;
      }
    }
    if (event.key === 'Escape' && (replyTo || editing)) {
      event.preventDefault();
      cancelComposerMode();
    }
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
    setChatError(null);
    setDeletingMessageId(msgId);

    try {
      const result = await deleteMessageForEveryone(msgId, roomId);
      if (!result.success) {
        setChatError(result.error ?? 'Unable to delete message.');
        return;
      }

      // The soft-delete UPDATE reaches other members through Postgres Changes.
      setMessages(prev => prev.map(msg => msg.id === msgId ? { ...msg, is_deleted: true, content: '🚫 This message was deleted', pinned_at: null, pinned_by: null, reaction_summary: {} } : msg));
      if (editing?.id === msgId) cancelComposerMode();
      if (replyTo?.id === msgId) setReplyTo(null);
    } catch {
      setChatError('Unable to delete message.');
    } finally {
      setDeletingMessageId(null);
    }
  };

  const renderContent = (msg: RoomChatMessage) => {
    const gif = msg.is_deleted ? null : parseGifMessage(msg.content);
    if (gif) {
      return (
        <figure className="m-0">
          {/* eslint-disable-next-line @next/next/no-img-element -- animated third-party GIF; next/image would re-encode it */}
          <img src={giphyImageUrl(gif.id)} alt={gif.title || 'GIF'} loading="lazy" referrerPolicy="no-referrer" width={200} className="block max-w-[200px] rounded-lg bg-black/20" />
          <figcaption className="mt-1 text-[9px] font-bold uppercase tracking-wider text-white/50">GIF via GIPHY</figcaption>
        </figure>
      );
    }
    if (msg.is_deleted || !msg.content) return <span className="text-sm leading-relaxed break-words">{msg.content}</span>;
    return (
      <span className="text-sm leading-relaxed break-words whitespace-pre-wrap">
        {messageSegments(msg.content, identities, me).map((segment, index) => segment.kind === 'mention'
          ? <span key={index} className={`room-chat-mention ${segment.isMe ? 'is-me' : ''}`}>{segment.text}</span>
          : <span key={index}>{segment.text}</span>)}
      </span>
    );
  };

  const composerLabel = editing ? 'Edit your message' : replyTo ? `Reply to ${senderName(replyTo.sender_id)}` : 'Message the room';

  return (
    <div className="chat-panel relative h-full border-l border-white/10">
      <div className="chat-topbar z-10 shadow-md">
        <h3 className="text-white font-bold text-sm">Room Chat</h3>
      </div>

      {currentPinned && (
        <div className="room-chat-pinned" aria-label="Pinned messages">
          <button type="button" className="room-chat-pinned-main" onClick={() => jumpTo(currentPinned.id)}>
            <OmniIcon name="pin" size={14} />
            <span className="min-w-0">
              <span className="room-chat-pinned-label">Pinned{pinned.length > 1 ? ` ${Math.min(pinnedIndex, pinned.length - 1) + 1}/${pinned.length}` : ''}</span>
              <span className="room-chat-pinned-text">{senderName(currentPinned.sender_id)}: {replyPreview(currentPinned)}</span>
            </span>
          </button>
          {pinned.length > 1 && (
            <button type="button" className="room-chat-pinned-icon" aria-label="Show next pinned message" onClick={() => setPinnedIndex((index) => (index + 1) % pinned.length)}>
              <OmniIcon name="chevron" size={14} />
            </button>
          )}
          {canPin && (
            <button type="button" className="room-chat-pinned-icon" aria-label="Unpin this message" disabled={pendingAction === `pin:${currentPinned.id}`} onClick={() => void setPin(currentPinned, false)}>
              <OmniIcon name="close" size={13} />
            </button>
          )}
        </div>
      )}

      {chatError && (
        <div className="flex items-start justify-between gap-2 border-b border-red-500/20 bg-red-500/5 px-4 py-2 text-xs text-red-300" role="alert">
          <p className="m-0">{chatError}</p>
          <button type="button" className="shrink-0 text-red-200/80 hover:text-red-100" aria-label="Dismiss" onClick={() => setChatError(null)}><OmniIcon name="close" size={12} /></button>
        </div>
      )}

      <div
        ref={scrollRef}
        className="chat-scroller flex flex-col gap-4"
        onScroll={(event) => {
          const element = event.currentTarget;
          nearBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
        }}
      >
        {hasMoreMessages && <button type="button" onClick={() => void loadOlderMessages()} disabled={isLoadingOlder} className="mx-auto rounded-lg border border-neutral-800 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-neutral-400 transition hover:border-neutral-600 hover:text-white disabled:cursor-wait disabled:opacity-50">{isLoadingOlder ? 'Loading older messages...' : 'Load older messages'}</button>}
        {announcements.map((announcement) => <article key={`announcement-${announcement.id}`} className="rounded-xl border border-violet-300/20 bg-violet-500/10 px-3 py-3"><p className="text-[10px] font-bold uppercase tracking-[.16em] text-violet-200">{announcement.is_pinned ? 'Pinned announcement' : 'Room announcement'}</p><p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-violet-50">{announcement.body}</p></article>)}
        {messages.length === 0 ? (
          <p className="text-xs text-neutral-500 text-center mt-10">No messages yet. Say hello!</p>
        ) : (
          visibleMessages.map((msg, index) => {
            const isMe = msg.sender_id === me;
            const previous = visibleMessages[index - 1];
            const showName = !isMe && (!previous || previous.sender_id !== msg.sender_id || msg.id === dividerMessageId);
            const replyTarget = msg.reply_to_id ? (messagesById.get(msg.reply_to_id) ?? replyTargets[msg.reply_to_id]) : null;
            const chips = msg.is_deleted ? [] : reactionChips(msg.reaction_summary, me);
            const menuOpen = activeMenuId === msg.id;
            const pickerOpen = reactionPickerFor === msg.id;
            return (
              <div key={msg.id} id={`message-${msg.id}`} className={`room-chat-row flex flex-col relative group ${isMe ? 'items-end' : 'items-start'} ${highlightId === msg.id ? 'is-highlighted' : ''}`}>
                {msg.id === dividerMessageId && (
                  <div className="room-chat-divider" role="separator" aria-label="New messages"><span>New messages</span></div>
                )}
                {showName && <span className="room-chat-sender">{senderName(msg.sender_id)}</span>}
                <div data-message-menu-area className={`message-bubble relative flex max-w-[85%] items-center gap-3 px-4 py-2.5 ${msg.is_deleted ? 'bg-transparent text-neutral-500 italic' : isMe ? 'is-own rounded-br-sm text-white' : 'rounded-bl-sm text-white'} ${msg.pinned_at && !msg.is_deleted ? 'is-pinned' : ''}`}>
                  <span className="flex min-w-0 flex-col gap-1.5">
                    {msg.reply_to_id && !msg.is_deleted && (
                      <button type="button" className="room-chat-reply-quote" onClick={() => msg.reply_to_id && jumpTo(msg.reply_to_id)}>
                        <span className="room-chat-reply-name">{replyTarget ? senderName(replyTarget.sender_id) : 'Reply'}</span>
                        <span className="room-chat-reply-text">{replyPreview(replyTarget)}</span>
                      </button>
                    )}
                    {renderContent(msg)}
                  </span>
                  {!msg.is_deleted && (
                    <button aria-label="Message actions" aria-haspopup="menu" aria-expanded={menuOpen} title="Message actions" onClick={(e) => { e.stopPropagation(); setReactionPickerFor(null); setActiveMenuId(menuOpen ? null : msg.id); }} className={`message-more rounded p-1 transition hover:bg-black/20 ${isMe ? '-ml-2' : ''}`}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="19" r="1"></circle></svg>
                    </button>
                  )}
                </div>
                {chips.length > 0 && (
                  <div className={`room-chat-reactions ${isMe ? 'justify-end' : ''}`}>
                    {chips.map((chip) => (
                      <button
                        key={chip.emoji}
                        type="button"
                        aria-pressed={chip.mine}
                        aria-label={`${chip.label}: ${chip.count} ${chip.count === 1 ? 'reaction' : 'reactions'}${chip.mine ? ', including yours' : ''}`}
                        disabled={pendingAction === `react:${msg.id}:${chip.emoji}`}
                        onClick={() => void toggleReaction(msg.id, chip.emoji)}
                        className={`room-chat-reaction ${chip.mine ? 'is-mine' : ''}`}
                      >
                        <span aria-hidden="true">{chip.emoji}</span><span>{chip.count}</span>
                      </button>
                    ))}
                  </div>
                )}
                {menuOpen && (
                  <div data-message-menu-area role="menu" aria-label="Message actions" className={`chat-menu absolute top-full z-50 mt-1 flex w-44 flex-col overflow-hidden rounded-xl py-1 shadow-2xl ${isMe ? 'right-0' : 'left-0'}`}>
                    <button role="menuitem" onClick={(e) => { e.stopPropagation(); startReply(msg); }} className="room-chat-menu-item"><OmniIcon name="reply" size={13} /> Reply</button>
                    <button role="menuitem" onClick={(e) => { e.stopPropagation(); setActiveMenuId(null); setReactionPickerFor(msg.id); }} className="room-chat-menu-item"><OmniIcon name="smile" size={13} /> React</button>
                    {canEditMessage(msg, me) && <button role="menuitem" onClick={(e) => { e.stopPropagation(); startEdit(msg); }} className="room-chat-menu-item"><OmniIcon name="pen" size={13} /> Edit</button>}
                    {!msg.is_deleted && msg.content && <button role="menuitem" disabled={bookmarks.busy === msg.id} onClick={(e) => { e.stopPropagation(); setActiveMenuId(null); void bookmarks.toggle(roomId, msg.id); }} className="room-chat-menu-item"><OmniIcon name="pin" size={13} /> {bookmarks.saved.has(msg.id) ? 'Remove from saved' : 'Save message'}</button>}
                    {canPin && <button role="menuitem" disabled={pendingAction === `pin:${msg.id}`} onClick={(e) => { e.stopPropagation(); void setPin(msg, !msg.pinned_at); }} className="room-chat-menu-item"><OmniIcon name="pin" size={13} /> {msg.pinned_at ? 'Unpin' : 'Pin'}</button>}
                    <button role="menuitem" onClick={(e) => { e.stopPropagation(); handleDeleteForMe(msg.id); }} className="room-chat-menu-item">Delete for me</button>
                    {isMe && <button role="menuitem" onClick={(e) => { e.stopPropagation(); handleDeleteForEveryone(msg.id); }} disabled={deletingMessageId === msg.id} className="room-chat-menu-item is-danger">{deletingMessageId === msg.id ? 'Deleting...' : 'Delete for everyone'}</button>}
                  </div>
                )}
                {pickerOpen && (
                  <div data-message-menu-area role="menu" aria-label="Add a reaction" className={`room-chat-reaction-picker absolute top-full z-50 mt-1 ${isMe ? 'right-0' : 'left-0'}`}>
                    {ROOM_REACTION_EMOJIS.map((emoji) => (
                      <button key={emoji} role="menuitem" type="button" aria-label={ROOM_REACTION_LABELS[emoji]} title={ROOM_REACTION_LABELS[emoji]} onClick={(e) => { e.stopPropagation(); void toggleReaction(msg.id, emoji); }}>{emoji}</button>
                    ))}
                  </div>
                )}
                <span className="text-[9px] text-neutral-600 mt-1 px-1 font-bold">
                  {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  {msg.edited_at && !msg.is_deleted && <span className="room-chat-edited" title={`Edited ${new Date(msg.edited_at).toLocaleString()}`}> · edited</span>}
                  {msg.pinned_at && !msg.is_deleted && <span className="room-chat-edited"> · pinned</span>}
                </span>
              </div>
            );
          })
        )}
      </div>

      <div className="message-composer relative">
        {(replyTo || editing) && (
          <div className="room-chat-composer-mode">
            <OmniIcon name={editing ? 'pen' : 'reply'} size={13} />
            <span className="min-w-0 flex-1">
              <span className="room-chat-composer-mode-title">{editing ? 'Editing message' : `Replying to ${senderName(replyTo!.sender_id)}`}</span>
              <span className="room-chat-composer-mode-text">{replyPreview(editing ?? replyTo)}</span>
            </span>
            <button type="button" aria-label={editing ? 'Cancel editing' : 'Cancel reply'} onClick={cancelComposerMode} className="shrink-0 rounded p-1 text-neutral-400 hover:text-white"><OmniIcon name="close" size={12} /></button>
          </div>
        )}
        {mention && suggestions.length > 0 && (
          <ul id={mentionListId} role="listbox" aria-label="Mention a member" className="room-chat-mentions">
            {suggestions.map((identity, index) => (
              <li
                key={identity.user_id}
                id={`${mentionListId}-${index}`}
                role="option"
                aria-selected={index === mentionIndex}
                className={index === mentionIndex ? 'is-active' : ''}
                onMouseDown={(event) => { event.preventDefault(); chooseMention(identity); }}
              >
                <strong>{memberLabel(identity)}</strong>
                <span>@{identity.username}</span>
              </li>
            ))}
          </ul>
        )}
        {showGifPicker && <GifPicker onSelect={(gif) => void handleSendGif(gif)} onClose={closeGifPicker} />}
        <form onSubmit={handleSendMessage} className="flex gap-2">
          {!editing && <button type="button" onClick={() => setShowGifPicker((value) => !value)} aria-expanded={showGifPicker} aria-label="Send a GIF" title="Send a GIF" className={`shrink-0 rounded-xl border px-2.5 text-[11px] font-black tracking-wide transition ${showGifPicker ? 'border-indigo-500 bg-indigo-500/20 text-indigo-200' : 'border-neutral-800 text-neutral-400 hover:border-neutral-600 hover:text-white'}`}>GIF</button>}
          <input
            ref={inputRef}
            type="text"
            value={newMessage}
            onChange={handleTyping}
            onKeyDown={handleComposerKeyDown}
            onSelect={(event) => refreshMention(event.currentTarget.value, event.currentTarget.selectionStart)}
            onBlur={() => window.setTimeout(() => setMention(null), 150)}
            maxLength={ROOM_MESSAGE_MAX_CHARS}
            placeholder={editing ? 'Edit your message...' : 'Message the room... (@ to mention)'}
            aria-label={composerLabel}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={Boolean(mention && suggestions.length > 0)}
            aria-controls={mention && suggestions.length > 0 ? mentionListId : undefined}
            aria-activedescendant={mention && suggestions.length > 0 ? `${mentionListId}-${Math.min(mentionIndex, suggestions.length - 1)}` : undefined}
            className="omni-input"
          />
          <button type="submit" disabled={!newMessage.trim() || pendingAction?.startsWith('edit:')} aria-label={editing ? 'Save edit' : 'Send message'} className="omni-button omni-button-primary !min-h-0 !rounded-xl !px-3">
            {editing ? <span className="text-xs font-bold">Save</span> : <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" /></svg>}
          </button>
        </form>
      </div>
    </div>
  );
}
