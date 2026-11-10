'use client';

import { unwrapAction } from '@/lib/action-result';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/utils/supabase/client';
import PrivateChat from '@/components/chat/PrivateChat';
import GroupChat from '@/components/chat/GroupChat';
import { isPendingRequestContact } from '@/lib/conversation-model';
import { OmniIcon } from '@/components/ui/OmniIcon';
import styles from './messages.module.css';
import {
  usePersonalMessageNotifications,
  type PersonalMessageToast,
} from '@/hooks/usePersonalMessageNotifications';
import {
  getDeviceIdentity,
  deriveSharedKey,
} from '@/lib/encryption';
import { saveUserPublicKey, getUserPublicKey, getOrCreatePrivateChat } from '@/actions/chat';
import { unreadBadge } from '@/lib/room-chat-model';
import { parseMessagesDeepLink, resolveMessagesDeepLink, type MessagesDeepLink } from '@/lib/messages-deep-link';
import {
  getMyMessageInbox,
  sendMessageRequest,
  acceptMessageRequest,
  rejectMessageRequest,
  cancelMessageRequest,
  blockUser,
  unblockUser,
  markConversationRead,
  type InboxChatGroup,
  type MessageInbox,
  type InboxGeneralContact,
  type InboxGroup,
  type InboxPerson,
} from '@/actions/messages';

type TabId = 'personal' | 'general' | 'groups' | 'requests';
const TABS: Array<{ id: TabId; label: string; kicker: string }> = [
  { id: 'personal', label: 'Personal', kicker: 'Friends · end-to-end encrypted' },
  { id: 'general', label: 'General', kicker: 'Follow connections · end-to-end encrypted' },
  { id: 'groups', label: 'Groups', kicker: 'Groups you belong to' },
  { id: 'requests', label: 'Requests', kicker: 'Message requests and blocked members' },
];
type MemberAction = 'accept' | 'reject' | 'send' | 'cancel' | 'block' | 'unblock';

interface ActiveConversation {
  contactId: string;
  peerName: string;
  chatId: string | null;
  sharedKey: CryptoKey | null;
  phase: 'key' | 'no-key' | 'ready';
}

interface Notice {
  kind: 'info' | 'error';
  text: string;
}

// These caches are intentionally memory-only. Public keys and derived session
// keys are safe to reuse for the life of this browser tab; private keys and
// plaintext are never placed in them or sent to the server.
const peerPublicKeyPromises = new Map<string, Promise<string | null>>();
const sharedKeyPromises = new Map<string, Promise<CryptoKey>>();

function getCachedPeerPublicKey(userId: string, peerId: string) {
  const cacheKey = `${userId}:${peerId}`;
  const cached = peerPublicKeyPromises.get(cacheKey);
  if (cached) return cached;

  const promise = getUserPublicKey(peerId).then(unwrapAction).catch((error: unknown) => {
    peerPublicKeyPromises.delete(cacheKey);
    throw error;
  });
  peerPublicKeyPromises.set(cacheKey, promise);
  return promise;
}

function getCachedSharedKey(
  userId: string,
  peerId: string,
  privateKey: CryptoKey,
  publicKeyBase64: string,
) {
  const cacheKey = `${userId}:${peerId}:${publicKeyBase64}`;
  const cached = sharedKeyPromises.get(cacheKey);
  if (cached) return cached;

  const promise = deriveSharedKey(privateKey, publicKeyBase64).catch((error: unknown) => {
    sharedKeyPromises.delete(cacheKey);
    throw error;
  });
  sharedKeyPromises.set(cacheKey, promise);
  return promise;
}

function personName(person: InboxPerson) {
  return person.display_name || person.username || 'OmniLume member';
}

function PersonAvatar({ person, size = 'md', className = '' }: { person: InboxPerson; size?: 'md' | 'sm'; className?: string }) {
  const cls = `${size === 'sm' ? 'person-avatar !h-9 !w-9' : 'person-avatar'} ${className}`.trim();
  return (
    <span className={cls}>
      {person.avatar_url ? <img src={person.avatar_url} alt="" /> : personName(person).charAt(0).toUpperCase()}
    </span>
  );
}

export default function MessagesWorkspace() {
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [myPrivateKey, setMyPrivateKey] = useState<CryptoKey | null>(null);

  const [inbox, setInbox] = useState<MessageInbox | null>(null);
  const [inboxStatus, setInboxStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [inboxError, setInboxError] = useState<string | null>(null);

  const [tab, setTab] = useState<TabId>('personal');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<ActiveConversation | null>(null);
  const [activeGroup, setActiveGroup] = useState<InboxChatGroup | null>(null);
  const [chatIdOverrides, setChatIdOverrides] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, MemberAction | undefined>>({});
  const [composerFor, setComposerFor] = useState<string | null>(null);
  const [composerText, setComposerText] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [inboxReloadToken, setInboxReloadToken] = useState(0);
  const {
    toasts,
    registerContacts,
    setActiveChat,
    dismissToast,
  } = usePersonalMessageNotifications();

  const inboxRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const beginChatRequestRef = useRef(0);
  const inboxLoadRequestRef = useRef(0);

  useEffect(() => {
    const supabase = createClient();
    async function initializeCrypto() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setNotice({ kind: 'info', text: 'You must be logged in to use secure messaging.' });
        return;
      }
      setCurrentUserId(user.id);
      try {
        const identity = await getDeviceIdentity(user.id);
        // Retry a failed first sync after refresh without generating a new
        // identity. The marker contains only the public key and is never used
        // as a substitute for the private key.
        const publicKeyMarker = `publicKeySynced_${user.id}`;
        if (localStorage.getItem(publicKeyMarker) !== identity.publicKeyBase64) {
          await saveUserPublicKey(identity.publicKeyBase64).then(unwrapAction);
          localStorage.setItem(publicKeyMarker, identity.publicKeyBase64);
        }
        setMyPrivateKey(identity.privateKey);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : '';
        setNotice({
          kind: 'error',
          text: message === 'Stored secure messaging identity is invalid.'
            ? 'This browser has an invalid secure messaging identity. Your existing encrypted history was not replaced; clear site storage only if you intentionally want to re-key this device.'
            : message === 'Secure messaging identity already exists on another device.'
              ? 'This account already has a secure messaging identity on another device. Your local identity was not replaced, so existing encrypted history remains protected.'
              : message === 'Secure messaging identity is inconsistent on the server.'
                ? 'Secure messaging setup is inconsistent on the server. No identity was replaced; contact support before sending new messages.'
                : 'Unable to initialize end-to-end encryption in this browser.',
        });
      }
    }
    void initializeCrypto();
  }, []);

  const loadInbox = useCallback(async () => {
    const requestId = inboxLoadRequestRef.current + 1;
    inboxLoadRequestRef.current = requestId;
    try {
      const data = await getMyMessageInbox().then(unwrapAction);
      if (inboxLoadRequestRef.current !== requestId) return;
      setInbox(data);
      setInboxStatus('ready');
      setInboxError(null);
    } catch (error: unknown) {
      if (inboxLoadRequestRef.current !== requestId) return;
      setInboxStatus('error');
      setInboxError(error instanceof Error ? error.message : 'Unable to load conversations.');
    }
  }, []);

  const quietLoadInbox = useCallback(() => {
    void loadInbox().catch(() => undefined);
  }, [loadInbox]);

  const scheduleInboxRefresh = useCallback(() => {
    if (inboxRefreshTimer.current) clearTimeout(inboxRefreshTimer.current);
    inboxRefreshTimer.current = setTimeout(() => {
      inboxRefreshTimer.current = null;
      quietLoadInbox();
    }, 450);
  }, [quietLoadInbox]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void loadInbox();
    });
    return () => {
      cancelled = true;
    };
  }, [inboxReloadToken, loadInbox]);

  // Inbox updates from other clients: new/updated message requests and new
  // private-chat rows are pushed to this client without a manual reload.
  useEffect(() => {
    if (!currentUserId) return;
    const supabase = createClient();
    const channel = supabase
      // Private-only Realtime: a per-user topic only this user may join
      // (migration 20261105210000).
      .channel(`messages_inbox_${currentUserId}`, { config: { private: true } })
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'message_requests', filter: `recipient_id=eq.${currentUserId}` },
        () => scheduleInboxRefresh(),
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'message_requests', filter: `recipient_id=eq.${currentUserId}` },
        () => scheduleInboxRefresh(),
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'message_requests', filter: `requester_id=eq.${currentUserId}` },
        () => scheduleInboxRefresh(),
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'message_requests', filter: `requester_id=eq.${currentUserId}` },
        () => scheduleInboxRefresh(),
      )
      // New personal/general messages refresh unread counts (RLS-filtered).
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `receiver_id=eq.${currentUserId}` },
        () => scheduleInboxRefresh(),
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'private_chats', filter: `user_one=eq.${currentUserId}` },
        () => scheduleInboxRefresh(),
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'private_chats', filter: `user_two=eq.${currentUserId}` },
        () => scheduleInboxRefresh(),
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'friendships', filter: `user_one=eq.${currentUserId}` },
        () => scheduleInboxRefresh(),
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'friendships', filter: `user_two=eq.${currentUserId}` },
        () => scheduleInboxRefresh(),
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'friendships', filter: `user_one=eq.${currentUserId}` },
        () => scheduleInboxRefresh(),
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'friendships', filter: `user_two=eq.${currentUserId}` },
        () => scheduleInboxRefresh(),
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'friendships', filter: `user_one=eq.${currentUserId}` },
        () => scheduleInboxRefresh(),
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'friendships', filter: `user_two=eq.${currentUserId}` },
        () => scheduleInboxRefresh(),
      )
      .subscribe();
    return () => {
      if (inboxRefreshTimer.current) {
        clearTimeout(inboxRefreshTimer.current);
        inboxRefreshTimer.current = null;
      }
      supabase.removeChannel(channel);
    };
  }, [currentUserId, scheduleInboxRefresh]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    registerContacts([...(inbox?.friends ?? []), ...(inbox?.general ?? [])]);
  }, [inbox, registerContacts]);

  useEffect(() => {
    setActiveChat(active?.chatId ?? null);
    return () => setActiveChat(null);
  }, [active?.chatId, setActiveChat]);

  // Read state for the open private chat; refreshed with the inbox.
  useEffect(() => {
    if (active?.phase === 'ready' && active.chatId) void markConversationRead(active.chatId).catch(() => undefined);
  }, [active?.phase, active?.chatId, inbox]);

  // Revocation (unfriend, block, request withdrawn): once the refreshed inbox
  // no longer lists an open conversation, close it. RLS already stops reads,
  // writes and realtime; this keeps the UI honest.
  useEffect(() => {
    if (!inbox) return;
    if (active?.chatId) {
      // shortcut: a chat created in this tab and then revoked stays open until
      // reload, but RLS already refuses its reads, writes and realtime.
      const stillOpen = [...inbox.friends, ...inbox.general].some((person) => person.user_id === active.contactId
        && (person.chat_id ?? chatIdOverrides[person.user_id] ?? null) === active.chatId);
      if (!stillOpen) {
        queueMicrotask(() => {
          setActive(null);
          setNotice({ kind: 'info', text: `The conversation with ${active.peerName} is no longer available.` });
        });
      }
    }
    if (activeGroup && !inbox.chatGroups.some((group) => group.group_id === activeGroup.group_id)) {
      queueMicrotask(() => setActiveGroup(null));
    }
  }, [inbox, active, activeGroup, chatIdOverrides]);

  const closeGroup = useCallback((message: string) => {
    setActiveGroup(null);
    setNotice({ kind: 'info', text: message });
    scheduleInboxRefresh();
  }, [scheduleInboxRefresh]);

  const setMemberBusy = (userId: string, action: MemberAction | undefined) => {
    setBusy((current) => ({ ...current, [userId]: action }));
  };

  const updateGeneralContact = (userId: string, update: (contact: InboxGeneralContact) => InboxGeneralContact) => {
    setInbox((current) => {
      if (!current) return current;
      const all = [...current.general, ...current.requests].map((contact) => (contact.user_id === userId ? update(contact) : contact));
      return { ...current, general: all.filter((contact) => !isPendingRequestContact(contact)), requests: all.filter(isPendingRequestContact) };
    });
  };

  const beginChat = useCallback(async (contact: InboxPerson) => {
    const peerName = personName(contact);
    if (!myPrivateKey || !currentUserId) {
      setNotice({ kind: 'info', text: 'Secure messaging is still being set up in this browser.' });
      return;
    }
    const requestId = beginChatRequestRef.current + 1;
    beginChatRequestRef.current = requestId;
    setActiveGroup(null);
    setActive({ contactId: contact.user_id, peerName, chatId: contact.chat_id ?? null, sharedKey: null, phase: 'key' });
    setNotice(null);
    try {
      const publicKeyBase64 = await getCachedPeerPublicKey(currentUserId, contact.user_id);
      if (beginChatRequestRef.current !== requestId) return;
      if (!publicKeyBase64) {
        setActive({ contactId: contact.user_id, peerName, chatId: contact.chat_id ?? null, sharedKey: null, phase: 'no-key' });
        return;
      }
      const sharedKey = await getCachedSharedKey(currentUserId, contact.user_id, myPrivateKey, publicKeyBase64);
      if (beginChatRequestRef.current !== requestId) return;
      const knownChatId = chatIdOverrides[contact.user_id] ?? contact.chat_id;
      const chatId = knownChatId ?? await getOrCreatePrivateChat(contact.user_id).then(unwrapAction);
      if (beginChatRequestRef.current !== requestId) return;
      if (!knownChatId) {
        setChatIdOverrides((current) => ({ ...current, [contact.user_id]: chatId }));
      }
      setActive({ contactId: contact.user_id, peerName, chatId, sharedKey, phase: 'ready' });
    } catch (error: unknown) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Unable to open the secure chat.' });
      setActive(null);
    }
  }, [currentUserId, myPrivateKey, chatIdOverrides]);

  const openPersonalToast = useCallback((notification: PersonalMessageToast) => {
    dismissToast(notification.id);
    setQuery('');
    const friend = inbox?.friends.find((person) => person.user_id === notification.senderId);
    const contact = friend ?? inbox?.general.find((person) => person.user_id === notification.senderId);
    setTab(friend || !contact ? 'personal' : 'general');
    if (!contact) {
      setNotice({ kind: 'info', text: 'Refresh Personal to open this secure conversation.' });
      return;
    }
    void beginChat({ ...contact, chat_id: notification.chatId });
  }, [beginChat, dismissToast, inbox]);

  // Deep link (a notification tap): /messages?chat=<id> or ?group=<id> opens that thread once.
  // The id is only looked up in this member's own inbox, so a thread they cannot see is ignored.
  const deepLinkRef = useRef<MessagesDeepLink | null | undefined>(undefined);
  useEffect(() => {
    if (!inbox) return;
    if (deepLinkRef.current === undefined) deepLinkRef.current = parseMessagesDeepLink(window.location.search);
    const link = deepLinkRef.current;
    if (!link) return;
    const target = resolveMessagesDeepLink(link, inbox);
    if (!target) { deepLinkRef.current = null; return; }
    if (target.kind === 'group') {
      deepLinkRef.current = null;
      queueMicrotask(() => { beginChatRequestRef.current += 1; setTab('groups'); setActive(null); setActiveGroup(target.group); });
      return;
    }
    // The chat opens as soon as this browser's secure messaging key is ready.
    if (!myPrivateKey || !currentUserId) return;
    deepLinkRef.current = null;
    queueMicrotask(() => { setTab(target.tab); void beginChat(target.contact); });
  }, [inbox, myPrivateKey, currentUserId, beginChat]);

  const handleAccept = async (contact: InboxGeneralContact) => {
    const request = contact.request;
    if (!request || request.direction !== 'incoming' || request.status !== 'pending') return;
    setMemberBusy(contact.user_id, 'accept');
    setNotice(null);
    try {
      await acceptMessageRequest(request.id).then(unwrapAction);
      const chatId = chatIdOverrides[contact.user_id]
        ?? contact.chat_id
        ?? await getOrCreatePrivateChat(contact.user_id).then(unwrapAction);
      setChatIdOverrides((current) => ({ ...current, [contact.user_id]: chatId }));
      // An accepted request opens a General conversation; it becomes
      // Personal only when the pair become friends.
      updateGeneralContact(contact.user_id, (c) => ({ ...c, chat_id: chatId, request: { ...request, status: 'accepted' } }));
      setTab('general');
      await beginChat({ ...contact, chat_id: chatId });
      scheduleInboxRefresh();
    } catch (error: unknown) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Unable to accept this message request.' });
      scheduleInboxRefresh();
    } finally {
      setMemberBusy(contact.user_id, undefined);
    }
  };

  const handleReject = async (contact: InboxGeneralContact) => {
    const request = contact.request;
    if (!request || request.direction !== 'incoming' || request.status !== 'pending') return;
    setMemberBusy(contact.user_id, 'reject');
    setNotice(null);
    try {
      await rejectMessageRequest(request.id).then(unwrapAction);
      updateGeneralContact(contact.user_id, (c) => ({ ...c, request: c.request ? { ...c.request, status: 'rejected' } : null }));
      setComposerFor(null);
    } catch (error: unknown) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Unable to reject this message request.' });
    } finally {
      setMemberBusy(contact.user_id, undefined);
    }
  };

  const handleSendRequest = async (contact: InboxGeneralContact) => {
    const text = composerText.trim();
    if (!text) return;
    setMemberBusy(contact.user_id, 'send');
    setNotice(null);
    try {
      const row = await sendMessageRequest(contact.user_id, text).then(unwrapAction) as {
        id: string;
        status: 'pending' | 'accepted' | 'rejected' | 'cancelled';
        message: string;
        created_at: string;
      };
      updateGeneralContact(contact.user_id, (c) => ({
        ...c,
        request: {
          id: row.id,
          direction: 'outgoing',
          status: row.status,
          message: row.message,
          created_at: row.created_at,
          responded_at: null,
        },
      }));
      setComposerFor(null);
      setComposerText('');
    } catch (error: unknown) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Unable to send the message request.' });
    } finally {
      setMemberBusy(contact.user_id, undefined);
    }
  };

  const handleBlock = async (person: InboxPerson) => {
    if (!window.confirm(`Block ${personName(person)}? This ends your friendship, follows, requests and conversations with them.`)) return;
    setMemberBusy(person.user_id, 'block');
    setNotice(null);
    try {
      await blockUser(person.user_id).then(unwrapAction);
      if (active?.contactId === person.user_id) setActive(null);
      setNotice({ kind: 'info', text: `${personName(person)} is blocked.` });
      quietLoadInbox();
    } catch (error: unknown) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Unable to block this member.' });
    } finally {
      setMemberBusy(person.user_id, undefined);
    }
  };

  const handleUnblock = async (person: InboxPerson) => {
    setMemberBusy(person.user_id, 'unblock');
    setNotice(null);
    try {
      await unblockUser(person.user_id).then(unwrapAction);
      quietLoadInbox();
    } catch (error: unknown) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Unable to unblock this member.' });
    } finally {
      setMemberBusy(person.user_id, undefined);
    }
  };

  const handleCancelRequest = async (contact: InboxGeneralContact) => {
    const request = contact.request;
    if (!request || request.direction !== 'outgoing' || request.status !== 'pending') return;
    setMemberBusy(contact.user_id, 'cancel');
    setNotice(null);
    try {
      await cancelMessageRequest(request.id).then(unwrapAction);
      updateGeneralContact(contact.user_id, (c) => ({ ...c, request: c.request ? { ...c.request, status: 'cancelled' } : null }));
      setComposerFor(null);
    } catch (error: unknown) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Unable to cancel this message request.' });
    } finally {
      setMemberBusy(contact.user_id, undefined);
    }
  };

  const filterRows = useCallback(<T extends InboxPerson>(rows: T[]) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) =>
      (row.display_name ?? '').toLowerCase().includes(needle)
      || (row.username ?? '').toLowerCase().includes(needle),
    );
  }, [query]);

  const filteredFriends = useMemo(() => filterRows(inbox?.friends ?? []), [inbox, filterRows]);
  const filteredGeneral = useMemo(() => filterRows(inbox?.general ?? []), [inbox, filterRows]);
  const filteredRequests = useMemo(() => filterRows(inbox?.requests ?? []), [inbox, filterRows]);
  const filteredBlocked = useMemo(() => filterRows(inbox?.blocked ?? []), [inbox, filterRows]);
  const filteredGroups = useMemo(() => {
    const rows = inbox?.groups ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((group) =>
      group.name.toLowerCase().includes(needle)
      || (group.username ?? '').toLowerCase().includes(needle),
    );
  }, [inbox, query]);
  const filteredChatGroups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (inbox?.chatGroups ?? []).filter((group) => !needle || group.name.toLowerCase().includes(needle));
  }, [inbox, query]);

  const counts: Record<TabId, number> = {
    personal: inbox?.friends.length ?? 0,
    general: inbox?.general.length ?? 0,
    groups: (inbox?.groups.length ?? 0) + (inbox?.chatGroups.length ?? 0),
    requests: inbox?.requests.filter((contact) => contact.request?.direction === 'incoming').length ?? 0,
  };

  const startInboxRetry = () => {
    setInboxStatus('loading');
    setInboxReloadToken((token) => token + 1);
  };

  const renderEmpty = () => {
    if (tab === 'personal') {
      return (
        <div className="empty-state">
          <OmniIcon name="users" size={22} />
          <h3>No friends yet</h3>
          <p>Accepted friends appear here automatically, ready for secure chats.</p>
        </div>
      );
    }
    if (tab === 'groups') {
      return (
        <div className="empty-state">
          <OmniIcon name="rooms" size={22} />
          <h3>No groups yet</h3>
          <p>Groups and channels you have joined appear here so you can jump back into the conversation.</p>
          <Link href="/explore" className="omni-button omni-button-ghost">Explore groups <OmniIcon name="arrow" size={14} /></Link>
        </div>
      );
    }
    if (tab === 'requests') {
      return (
        <div className="empty-state">
          <OmniIcon name="bell" size={22} />
          <h3>No message requests</h3>
          <p>Requests from people you follow or who follow you wait here until you accept, decline or block.</p>
        </div>
      );
    }
    return (
      <div className="empty-state">
        <OmniIcon name="message" size={22} />
        <h3>No connections yet</h3>
        <p>People who follow you or whom you follow appear here. Send them a message request to start a secure chat.</p>
      </div>
    );
  };

  const renderUnread = (count: number | undefined) => (count ? (
    <span className="chat-row-unread" aria-label={`${count >= 100 ? '99+' : count} unread messages`}>{unreadBadge(count)}</span>
  ) : null);

  const renderChatGroupRow = (group: InboxChatGroup) => {
    const isActive = activeGroup?.group_id === group.group_id;
    return (
      <button
        type="button"
        key={group.group_id}
        className={`chat-row ${isActive ? 'is-active' : ''}`}
        aria-current={isActive ? 'true' : undefined}
        onClick={() => {
          beginChatRequestRef.current += 1;
          setActive(null);
          setActiveGroup(group);
          setInbox((current) => (current ? { ...current, chatGroups: current.chatGroups.map((row) => (row.group_id === group.group_id ? { ...row, unread_count: 0 } : row)) } : current));
        }}
      >
        <span className="person-avatar chat-group-avatar"><OmniIcon name="users" size={16} /></span>
        <span className="chat-row-main">
          <strong className="chat-row-name">{group.name}</strong>
          <small className="chat-row-sub">{group.role === 'owner' ? 'Owner' : group.role === 'admin' ? 'Admin' : 'Member'} · Group chat</small>
        </span>
        {renderUnread(group.unread_count)}
        <OmniIcon name="message" size={15} className="chat-row-action" />
      </button>
    );
  };

  const renderBlockedRow = (person: InboxPerson) => (
    <div key={person.user_id} className="chat-row">
      <PersonAvatar person={person} />
      <span className="chat-row-main">
        <strong className="chat-row-name">{personName(person)}</strong>
        <small className="chat-row-sub">Blocked</small>
      </span>
      <button
        type="button"
        className="omni-button omni-button-ghost !min-h-[32px] !px-3"
        disabled={busy[person.user_id] === 'unblock'}
        onClick={() => void handleUnblock(person)}
      >
        {busy[person.user_id] === 'unblock' ? 'Unblocking…' : 'Unblock'}
      </button>
    </div>
  );

  const renderPersonRow = (friend: InboxPerson) => {
    const isActive = active?.contactId === friend.user_id;
    return (
      <button
        type="button"
        key={friend.user_id}
        onClick={() => void beginChat(friend)}
        className={`chat-row ${isActive ? 'is-active' : ''}`}
        aria-current={isActive ? 'true' : undefined}
      >
        <PersonAvatar person={friend} />
        <span className="chat-row-main">
          <strong className="chat-row-name">{personName(friend)}</strong>
          <small className="chat-row-sub">
            {friend.chat_id ? (
              <>&#x1F512; {friend.has_public_key ? 'End-to-end secured' : 'Encrypted · key pending'}</>
            ) : friend.has_public_key ? 'Ready for a secure chat' : 'Waiting for secure setup'}
          </small>
        </span>
        {renderUnread(friend.unread_count)}
        <OmniIcon name="message" size={15} className="chat-row-action" />
      </button>
    );
  };

  const renderGroupRow = (group: InboxGroup) => {
    const href = `/room/${group.username ? encodeURIComponent(group.username) : encodeURIComponent(group.room_id)}`;
    return (
      <Link href={href} key={group.room_id} className="chat-row">
        <span className="person-avatar chat-group-avatar"><OmniIcon name="rooms" size={16} /></span>
        <span className="chat-row-main">
          <strong className="chat-row-name">{group.name}</strong>
          <small className="chat-row-sub">
            {group.role === 'owner' ? 'Owner' : group.role === 'admin' ? 'Admin' : 'Member'}
            {group.description ? ` · ${group.description}` : ''}
          </small>
        </span>
        {group.unread_count > 0 && (
          <span className="chat-row-unread" aria-label={`${group.unread_count >= 100 ? '99+' : group.unread_count} unread messages`}>{unreadBadge(group.unread_count)}</span>
        )}
        <OmniIcon name="chevron" size={15} className="chat-row-action" />
      </Link>
    );
  };

  const renderGeneralRow = (contact: InboxGeneralContact) => {
    const request = contact.request;
    const chatId = chatIdOverrides[contact.user_id] ?? contact.chat_id;
    const isActive = active?.contactId === contact.user_id;
    const isComposing = composerFor === contact.user_id;
    const actionBusy = busy[contact.user_id];

    if (request?.status === 'pending' && request.direction === 'incoming') {
      return (
        <div key={contact.user_id} className="chat-row chat-row-block">
          <div className="chat-row-head">
            <PersonAvatar person={contact} />
            <span className="chat-row-main">
              <strong className="chat-row-name">{personName(contact)}</strong>
              <small className="chat-row-sub">{contact.username ? `@${contact.username}` : 'Wants to message you'}</small>
            </span>
            <span className="friend-badge"><OmniIcon name="message" size={13} /> Request</span>
          </div>
          <p className="chat-request-preview">{request.message}</p>
          <div className="chat-request-actions">
            <button
              type="button"
              className="omni-button omni-button-primary !min-h-[34px] !px-4"
              disabled={actionBusy === 'accept'}
              onClick={() => void handleAccept(contact)}
            >
              {actionBusy === 'accept' ? 'Accepting…' : 'Accept'}
            </button>
            <button
              type="button"
              className="omni-button omni-button-ghost !min-h-[34px] !px-4"
              disabled={actionBusy === 'reject'}
              onClick={() => void handleReject(contact)}
            >
              {actionBusy === 'reject' ? 'Declining…' : 'Decline'}
            </button>
            <button
              type="button"
              className="omni-button omni-button-ghost !min-h-[34px] !px-4"
              disabled={actionBusy !== undefined}
              onClick={() => void handleBlock(contact)}
            >
              {actionBusy === 'block' ? 'Blocking…' : 'Block'}
            </button>
          </div>
        </div>
      );
    }

    const canChat = chatId !== null || request?.status === 'accepted';
    return (
      <div key={contact.user_id}>
        <button
          type="button"
          className={`chat-row ${isActive ? 'is-active' : ''}`}
          aria-current={isActive ? 'true' : undefined}
          onClick={() => {
            if (canChat) {
              void beginChat(contact);
            } else {
              setComposerFor(isComposing ? null : contact.user_id);
              setComposerText('');
            }
          }}
        >
          <PersonAvatar person={contact} />
          <span className="chat-row-main">
            <strong className="chat-row-name">{personName(contact)}</strong>
            <small className="chat-row-sub">
              {contact.username ? `@${contact.username}` : ''}
              {canChat ? ' · Secure conversation' : ''}
            </small>
          </span>
          {renderUnread(contact.unread_count)}
          {request?.status === 'pending' && (
            <span className="chat-row-pill">
              {request.direction === 'outgoing' ? 'Sent' : 'Request'}
            </span>
          )}
          <OmniIcon name={canChat ? 'message' : 'plus'} size={15} className="chat-row-action" />
        </button>
        {isComposing && !canChat && (
          <form
            className="chat-request-composer"
            onSubmit={(e) => {
              e.preventDefault();
              void handleSendRequest(contact);
            }}
          >
            <input
              type="text"
              value={composerText}
              onChange={(e) => setComposerText(e.target.value)}
              maxLength={200}
              placeholder="Say hello… (short message)"
              className="omni-input"
              autoFocus
              aria-label={`Message ${personName(contact)}`}
            />
            <button
              type="submit"
              className="omni-button omni-button-primary !min-h-0 !px-3"
              disabled={!composerText.trim() || actionBusy === 'send'}
            >
              {actionBusy === 'send' ? '…' : 'Send'}
            </button>
            <button
              type="button"
              className="icon-button !h-9"
              aria-label="Cancel message request"
              onClick={() => setComposerFor(null)}
            >
              <OmniIcon name="close" size={15} />
            </button>
          </form>
        )}
        {request?.status === 'pending' && request.direction === 'outgoing' && (
          <div className="chat-request-note">
            <span><OmniIcon name="clock" size={13} /> Request sent. They can accept it from their Messages.</span>
            <button
              type="button"
              disabled={actionBusy === 'cancel'}
              onClick={() => void handleCancelRequest(contact)}
            >
              {actionBusy === 'cancel' ? '…' : 'Cancel'}
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderList = () => {
    if (inboxStatus === 'loading') {
      return (
        <div className="messages-list-scroll" aria-live="polite">
          <div className="chat-row chat-row-skeleton" aria-hidden="true" />
          <div className="chat-row chat-row-skeleton" aria-hidden="true" />
          <div className="chat-row chat-row-skeleton" aria-hidden="true" />
          <div className="chat-row chat-row-skeleton" aria-hidden="true" />
        </div>
      );
    }
    if (inboxStatus === 'error') {
      return (
        <div className="messages-list-scroll">
          <div className="empty-state">
            <OmniIcon name="shield" size={22} />
            <h3>Unable to load conversations</h3>
            <p>{inboxError}</p>
            <button type="button" className="omni-button omni-button-ghost" onClick={startInboxRetry}>Try again</button>
          </div>
        </div>
      );
    }
    if (tab === 'personal') {
      return filteredFriends.length === 0 ? renderEmpty() : <div className="messages-list-scroll">{filteredFriends.map(renderPersonRow)}</div>;
    }
    if (tab === 'groups') {
      return filteredGroups.length + filteredChatGroups.length === 0 ? renderEmpty() : (
        <div className="messages-list-scroll">{filteredChatGroups.map(renderChatGroupRow)}{filteredGroups.map(renderGroupRow)}</div>
      );
    }
    if (tab === 'requests') {
      if (filteredRequests.length + filteredBlocked.length === 0) return renderEmpty();
      return (
        <div className="messages-list-scroll">
          {filteredRequests.map(renderGeneralRow)}
          {filteredBlocked.length > 0 && <p className="section-kicker mt-3 px-2">Blocked</p>}
          {filteredBlocked.map(renderBlockedRow)}
        </div>
      );
    }
    return filteredGeneral.length === 0 ? renderEmpty() : <div className="messages-list-scroll">{filteredGeneral.map(renderGeneralRow)}</div>;
  };

  return (
    <div className={`messages-workspace ${styles.workspace} ${active || activeGroup ? 'is-expanded' : 'is-collapsed'}`}>
      <aside className={`messages-list ${styles.list}`}>
        <div className="msg-search">
          <OmniIcon name="search" size={15} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${tab === 'groups' ? 'groups' : 'chats and people'}…`}
            aria-label="Search chats and people"
          />
        </div>
        <div className="msg-tabs" role="tablist" aria-label="Message categories">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`msg-tab ${tab === id ? 'is-active' : ''}`}
              onClick={() => setTab(id)}
            >
              {label}
              {counts[id] > 0 && <span className="msg-tab-count">{counts[id]}</span>}
            </button>
          ))}
        </div>
        <div className="messages-list-headline">
          <p className="section-kicker">{TABS.find((entry) => entry.id === tab)?.kicker}</p>
          <span className="section-count">{counts[tab]}</span>
        </div>
        {notice && (
          <p className={`msg-notice msg-notice-${notice.kind}`} role="status">{notice.text}</p>
        )}
        {renderList()}
      </aside>

      <section className={`messages-pane ${styles.pane}`} aria-label="Active conversation">
        {activeGroup && currentUserId ? (
          <>
            <div className="lg:hidden">
              <div className={`msg-pane-topbar ${styles.head}`}>
                <button type="button" className="icon-button" aria-label="Back to conversation list" onClick={() => setActiveGroup(null)}>
                  <OmniIcon name="arrow" size={16} className="rotate-180" />
                </button>
                <span className="msg-pane-title"><span className="msg-pane-name">{activeGroup.name}</span></span>
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              <GroupChat key={activeGroup.group_id} groupId={activeGroup.group_id} groupName={activeGroup.name} currentUserId={currentUserId} onRevoked={closeGroup} />
            </div>
          </>
        ) : active ? (
          <>
            <div className={`msg-pane-topbar ${styles.head}`}>
              <button
                type="button"
                className="icon-button lg:hidden"
                aria-label="Back to conversation list"
                onClick={() => {
                  beginChatRequestRef.current += 1;
                  setActive(null);
                }}
              >
                <OmniIcon name="arrow" size={16} className="rotate-180" />
              </button>
              <span className="msg-pane-title">
                <span className={styles.avatar} aria-hidden="true">{active.peerName.charAt(0).toUpperCase()}</span>
                <span className="msg-pane-name">{active.phase === 'ready' ? active.peerName : `Starting secure chat with ${active.peerName}…`}</span>
              </span>
              <span className="msg-pane-badge"><OmniIcon name="shield" size={13} /> E2EE</span>
              <button
                type="button"
                className="omni-button omni-button-ghost !min-h-[30px] !px-3 text-xs"
                disabled={busy[active.contactId] !== undefined}
                onClick={() => void handleBlock({ user_id: active.contactId, display_name: active.peerName, username: null, avatar_url: null, chat_id: active.chatId, has_public_key: true })}
              >
                {busy[active.contactId] === 'block' ? 'Blocking…' : 'Block'}
              </button>
            </div>
            {active.phase === 'ready' && active.sharedKey && currentUserId && active.chatId ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <PrivateChat
                  key={active.chatId}
                  chatId={active.chatId}
                  currentUserId={currentUserId}
                  receiverId={active.contactId}
                  sharedKey={active.sharedKey}
                  peerName={active.peerName}
                />
              </div>
            ) : active.phase === 'no-key' ? (
              <div className="empty-state">
                <OmniIcon name="lock" size={22} />
                <h3>Secure messaging not ready yet</h3>
                <p>{active.peerName} has not set up their end-to-end keys yet. As soon as they open Messages on their own device, you can chat securely.</p>
              </div>
            ) : (
              <div className="empty-state">
                <span className="msg-negotiating"><OmniIcon name="shield" size={22} /></span>
                <p>Negotiating secure key exchange…</p>
              </div>
            )}
          </>
        ) : (
          <div className="chat-panel msg-placeholder">
            <span className="feature-float-icon"><OmniIcon name="message" size={19} /></span>
            <h2>Choose a conversation</h2>
            <p>Messages are encrypted on your device before they ever leave it. Personal, Groups and General keep your chats organized.</p>
          </div>
        )}
      </section>
      {toasts.length > 0 ? (
        <div className="personal-message-toast-stack" aria-label="New personal messages" aria-live="polite">
          {toasts.map((notification) => (
            <button
              type="button"
              key={notification.id}
              className="personal-message-toast"
              aria-label={`Open encrypted message from ${notification.senderName}`}
              onClick={() => openPersonalToast(notification)}
            >
              <PersonAvatar
                size="sm"
                className="personal-message-toast-avatar"
                person={{
                  user_id: notification.senderId,
                  display_name: notification.senderName,
                  username: notification.senderUsername,
                  avatar_url: notification.senderAvatarUrl,
                  chat_id: notification.chatId,
                  has_public_key: true,
                }}
              />
              <span className="personal-message-toast-copy">
                <strong>{notification.senderName}</strong>
                <span>{notification.preview}</span>
              </span>
              <OmniIcon name="chevron" size={15} className="personal-message-toast-arrow" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
