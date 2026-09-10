'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/utils/supabase/client';
import PrivateChat from '@/components/chat/PrivateChat';
import { OmniIcon } from '@/components/ui/OmniIcon';
import {
  generateKeyPair,
  exportPublicKey,
  exportPrivateKey,
  importPrivateKey,
  deriveSharedKey,
} from '@/lib/encryption';
import { saveUserPublicKey, getUserPublicKey, getOrCreatePrivateChat } from '@/actions/chat';
import {
  getMyMessageInbox,
  sendMessageRequest,
  acceptMessageRequest,
  rejectMessageRequest,
  cancelMessageRequest,
  type MessageInbox,
  type InboxGeneralContact,
  type InboxGroup,
  type InboxPerson,
} from '@/actions/messages';

type TabId = 'personal' | 'groups' | 'general';
type MemberAction = 'accept' | 'reject' | 'send' | 'cancel';

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

function personName(person: InboxPerson) {
  return person.display_name || person.username || 'OmniLume member';
}

function PersonAvatar({ person, size = 'md' }: { person: InboxPerson; size?: 'md' | 'sm' }) {
  const cls = size === 'sm' ? 'person-avatar !h-9 !w-9' : 'person-avatar';
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
  const [chatIdOverrides, setChatIdOverrides] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, MemberAction | undefined>>({});
  const [composerFor, setComposerFor] = useState<string | null>(null);
  const [composerText, setComposerText] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [inboxReloadToken, setInboxReloadToken] = useState(0);

  const inboxRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        const storedJwk = localStorage.getItem(`privKey_${user.id}`);
        if (storedJwk) {
          const privateKey = await importPrivateKey(JSON.parse(storedJwk));
          setMyPrivateKey(privateKey);
        } else {
          const keyPair = await generateKeyPair();
          setMyPrivateKey(keyPair.privateKey);
          const jwk = await exportPrivateKey(keyPair.privateKey);
          localStorage.setItem(`privKey_${user.id}`, JSON.stringify(jwk));
          const pubKeyBase64 = await exportPublicKey(keyPair.publicKey);
          await saveUserPublicKey(pubKeyBase64);
        }
      } catch {
        setNotice({ kind: 'error', text: 'Unable to initialize end-to-end encryption in this browser.' });
      }
    }
    void initializeCrypto();
  }, []);

  const loadInbox = useCallback(async () => {
    try {
      const data = await getMyMessageInbox();
      setInbox(data);
      setInboxStatus('ready');
      setInboxError(null);
    } catch (error: unknown) {
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
    async function fetchInitialInbox() {
      try {
        const data = await getMyMessageInbox();
        if (!cancelled) {
          setInbox(data);
          setInboxStatus('ready');
          setInboxError(null);
        }
      } catch (error: unknown) {
        if (!cancelled) {
          setInboxStatus('error');
          setInboxError(error instanceof Error ? error.message : 'Unable to load conversations.');
        }
      }
    }
    void fetchInitialInbox();
    return () => {
      cancelled = true;
    };
  }, [inboxReloadToken]);

  // Inbox updates from other clients: new/updated message requests and new
  // private-chat rows are pushed to this client without a manual reload.
  useEffect(() => {
    if (!currentUserId) return;
    const supabase = createClient();
    const channel = supabase
      .channel('messages_inbox')
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
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [currentUserId, scheduleInboxRefresh]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const setMemberBusy = (userId: string, action: MemberAction | undefined) => {
    setBusy((current) => ({ ...current, [userId]: action }));
  };

  const updateGeneralContact = (userId: string, update: (contact: InboxGeneralContact) => InboxGeneralContact) => {
    setInbox((current) => (current
      ? { ...current, general: current.general.map((contact) => (contact.user_id === userId ? update(contact) : contact)) }
      : current));
  };

  const beginChat = useCallback(async (contact: InboxPerson) => {
    const peerName = personName(contact);
    if (!myPrivateKey) {
      setNotice({ kind: 'info', text: 'Secure messaging is still being set up in this browser.' });
      return;
    }
    setActive({ contactId: contact.user_id, peerName, chatId: contact.chat_id ?? null, sharedKey: null, phase: 'key' });
    setNotice(null);
    try {
      const publicKeyBase64 = await getUserPublicKey(contact.user_id);
      if (!publicKeyBase64) {
        setActive({ contactId: contact.user_id, peerName, chatId: contact.chat_id ?? null, sharedKey: null, phase: 'no-key' });
        return;
      }
      const sharedKey = await deriveSharedKey(myPrivateKey, publicKeyBase64);
      const knownChatId = chatIdOverrides[contact.user_id] ?? contact.chat_id;
      const chatId = knownChatId ?? await getOrCreatePrivateChat(contact.user_id);
      if (!knownChatId) {
        setChatIdOverrides((current) => ({ ...current, [contact.user_id]: chatId }));
      }
      setActive({ contactId: contact.user_id, peerName, chatId, sharedKey, phase: 'ready' });
    } catch (error: unknown) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Unable to open the secure chat.' });
      setActive(null);
    }
  }, [myPrivateKey, chatIdOverrides]);

  const handleAccept = async (contact: InboxGeneralContact) => {
    const request = contact.request;
    if (!request || request.direction !== 'incoming' || request.status !== 'pending') return;
    setMemberBusy(contact.user_id, 'accept');
    setNotice(null);
    try {
      await acceptMessageRequest(request.id);
      const chatId = chatIdOverrides[contact.user_id]
        ?? contact.chat_id
        ?? await getOrCreatePrivateChat(contact.user_id);
      setChatIdOverrides((current) => ({ ...current, [contact.user_id]: chatId }));
      setInbox((current) => {
        if (!current) return current;
        const acceptedPerson: InboxPerson = { ...contact, chat_id: chatId };
        const friends = current.friends.some((friend) => friend.user_id === contact.user_id)
          ? current.friends.map((friend) => friend.user_id === contact.user_id ? acceptedPerson : friend)
          : [acceptedPerson, ...current.friends];
        return {
          ...current,
          friends,
          general: current.general.filter((candidate) => candidate.user_id !== contact.user_id),
        };
      });
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
      await rejectMessageRequest(request.id);
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
      const row = await sendMessageRequest(contact.user_id, text) as {
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

  const handleCancelRequest = async (contact: InboxGeneralContact) => {
    const request = contact.request;
    if (!request || request.direction !== 'outgoing' || request.status !== 'pending') return;
    setMemberBusy(contact.user_id, 'cancel');
    setNotice(null);
    try {
      await cancelMessageRequest(request.id);
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
  const filteredGroups = useMemo(() => {
    const rows = inbox?.groups ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((group) =>
      group.name.toLowerCase().includes(needle)
      || (group.username ?? '').toLowerCase().includes(needle),
    );
  }, [inbox, query]);

  const counts: Record<TabId, number> = {
    personal: inbox?.friends.length ?? 0,
    groups: inbox?.groups.length ?? 0,
    general: inbox?.general.length ?? 0,
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
    return (
      <div className="empty-state">
        <OmniIcon name="message" size={22} />
        <h3>No connections yet</h3>
        <p>People who follow you or whom you follow appear here. Message requests land here too.</p>
      </div>
    );
  };

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
              {actionBusy === 'reject' ? 'Rejecting…' : 'Reject'}
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
      return filteredGroups.length === 0 ? renderEmpty() : <div className="messages-list-scroll">{filteredGroups.map(renderGroupRow)}</div>;
    }
    return filteredGeneral.length === 0 ? renderEmpty() : <div className="messages-list-scroll">{filteredGeneral.map(renderGeneralRow)}</div>;
  };

  return (
    <div className={`messages-workspace ${active ? 'is-expanded' : 'is-collapsed'}`}>
      <aside className="messages-list">
        <div className="msg-search">
          <OmniIcon name="search" size={15} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${tab === 'groups' ? 'rooms' : 'chats and people'}…`}
            aria-label="Search chats and people"
          />
        </div>
        <div className="msg-tabs" role="tablist" aria-label="Message categories">
          {(['personal', 'groups', 'general'] as TabId[]).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`msg-tab ${tab === id ? 'is-active' : ''}`}
              onClick={() => setTab(id)}
            >
              {id === 'personal' ? 'Personal' : id === 'groups' ? 'Groups' : 'General'}
              {counts[id] > 0 && <span className="msg-tab-count">{counts[id]}</span>}
            </button>
          ))}
        </div>
        <div className="messages-list-headline">
          <p className="section-kicker">{tab === 'personal' ? 'Friends and personal chats' : tab === 'groups' ? 'Groups and channels' : 'Follow connections'}</p>
          <span className="section-count">{counts[tab]}</span>
        </div>
        {notice && (
          <p className={`msg-notice msg-notice-${notice.kind}`} role="status">{notice.text}</p>
        )}
        {renderList()}
      </aside>

      <section className="messages-pane" aria-label="Active conversation">
        {active ? (
          <>
            <div className="msg-pane-topbar">
              <button
                type="button"
                className="icon-button lg:hidden"
                aria-label="Back to conversation list"
                onClick={() => setActive(null)}
              >
                <OmniIcon name="arrow" size={16} className="rotate-180" />
              </button>
              <span className="msg-pane-title">
                <span className="msg-pane-lock">&#x1F512;</span>
                <span className="msg-pane-name">{active.phase === 'ready' ? active.peerName : `Starting secure chat with ${active.peerName}…`}</span>
              </span>
              <span className="msg-pane-badge"><OmniIcon name="shield" size={13} /> E2EE</span>
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
    </div>
  );
}
