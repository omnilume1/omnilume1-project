'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/utils/supabase/client';
import { unwrapAction } from '@/lib/action-result';
import { leaveGroup, markConversationRead, removeGroupMember, sendGroupMessage } from '@/actions/messages';
import { canRemoveGroupMember } from '@/lib/conversation-model';

// Group messages are plaintext protected by RLS (owner decision, Action 15),
// separate from room messages and room keys. Access = current group_members row.
interface GroupMessage { id: string; sender_id: string; content: string; created_at: string }
interface GroupMember { user_id: string; role: string; name: string }

const PAGE_SIZE = 50;

export default function GroupChat({ groupId, groupName, currentUserId, onRevoked }: {
  groupId: string;
  groupName: string;
  currentUserId: string;
  onRevoked: (message: string) => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [messages, setMessages] = useState<GroupMessage[]>([]);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [reloadToken, setReloadToken] = useState(0);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [busyMember, setBusyMember] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const myRole = members.find((member) => member.user_id === currentUserId)?.role ?? 'member';
  const nameOf = (userId: string) => (userId === currentUserId ? 'You' : members.find((member) => member.user_id === userId)?.name ?? 'Former member');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [messagesRes, membersRes] = await Promise.all([
        supabase.from('group_messages').select('id, sender_id, content, created_at').eq('group_id', groupId)
          .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(PAGE_SIZE),
        supabase.from('group_members').select('user_id, role').eq('group_id', groupId),
      ]);
      if (cancelled) return;
      if (messagesRes.error || membersRes.error) { setStatus('error'); return; }
      const memberRows = (membersRes.data ?? []) as Array<{ user_id: string; role: string }>;
      // RLS returns no member rows once access is revoked.
      if (!memberRows.some((row) => row.user_id === currentUserId)) { onRevoked('You are no longer a member of this group.'); return; }
      const { data: profiles } = await supabase.from('public_profiles').select('id, display_name, username').in('id', memberRows.map((row) => row.user_id));
      if (cancelled) return;
      const profileById = new Map(((profiles ?? []) as Array<{ id: string; display_name: string | null; username: string | null }>).map((p) => [p.id, p.display_name || p.username || 'OmniLume member']));
      setMembers(memberRows.map((row) => ({ ...row, name: profileById.get(row.user_id) ?? 'OmniLume member' })));
      setMessages(((messagesRes.data ?? []) as GroupMessage[]).reverse());
      setStatus('ready');
      void markConversationRead(groupId).catch(() => undefined);
    };
    void load().catch(() => { if (!cancelled) setStatus('error'); });

    // Private-only Realtime: topic policy admits current group members only;
    // Postgres Changes rows are filtered again by group_messages RLS.
    const channel = supabase
      .channel(`group_${groupId}`, { config: { private: true } })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'group_messages', filter: `group_id=eq.${groupId}` }, (payload: { new: unknown }) => {
        const row = payload.new as GroupMessage;
        if (!row?.id || typeof row.content !== 'string') return;
        setMessages((current) => (current.some((message) => message.id === row.id) ? current : [...current, row]));
        void markConversationRead(groupId).catch(() => undefined);
      })
      .subscribe();
    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [groupId, currentUserId, supabase, reloadToken, onRevoked]);

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!text.trim() || sending) return;
    setSending(true);
    setActionError(null);
    try {
      const row = await sendGroupMessage(groupId, text).then(unwrapAction);
      setMessages((current) => (current.some((message) => message.id === row.id) ? current : [...current, row]));
      setText('');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to send the message.');
    } finally {
      setSending(false);
    }
  };

  const runMemberAction = useCallback(async (userId: string, work: () => Promise<unknown>, onDone: () => void) => {
    setBusyMember(userId);
    setActionError(null);
    try {
      await work();
      onDone();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'That action failed. Try again.');
    } finally {
      setBusyMember(null);
    }
  }, []);

  return (
    <div className="chat-panel h-full overflow-hidden rounded-2xl border border-white/10">
      <div className="chat-topbar shrink-0">
        <h3 className="font-medium text-sm text-white">{groupName}</h3>
        <details className="relative ml-auto text-right">
          <summary className="cursor-pointer text-[11px] text-neutral-400 hover:text-white">Members ({members.length})</summary>
          <div className="absolute right-0 top-6 z-10 w-72 rounded-xl border border-white/15 bg-[#121318] p-3 text-left text-xs shadow-xl">
            <p className="mb-2 text-[11px] text-neutral-500">Group messages are protected by membership, not end-to-end encrypted.</p>
            <ul className="flex flex-col gap-1">
              {members.map((member) => (
                <li key={member.user_id} className="flex items-center justify-between gap-2">
                  <span className="text-neutral-200">{member.user_id === currentUserId ? 'You' : member.name} <small className="text-neutral-500">{member.role}</small></span>
                  {member.user_id !== currentUserId && canRemoveGroupMember(myRole, member.role) && (
                    <button type="button" className="text-amber-300 hover:text-amber-200 disabled:opacity-50" disabled={busyMember !== null}
                      aria-label={`Remove ${member.name} from the group`}
                      onClick={() => void runMemberAction(member.user_id, () => removeGroupMember(groupId, member.user_id).then(unwrapAction),
                        () => setMembers((current) => current.filter((row) => row.user_id !== member.user_id)))}>
                      {busyMember === member.user_id ? 'Removing…' : 'Remove'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {myRole !== 'owner' && (
              <button type="button" className="omni-button omni-button-ghost mt-3 w-full !min-h-[32px]" disabled={busyMember !== null}
                onClick={() => void runMemberAction(currentUserId, () => leaveGroup(groupId).then(unwrapAction), () => onRevoked('You left the group.'))}>
                {busyMember === currentUserId ? 'Leaving…' : 'Leave group'}
              </button>
            )}
          </div>
        </details>
      </div>

      <div className="chat-scroller flex flex-col gap-4" aria-live="polite">
        {status === 'loading' ? (
          <div className="my-auto text-center text-xs text-neutral-500">Loading group messages...</div>
        ) : status === 'error' ? (
          <div className="my-auto flex flex-col items-center gap-3 text-center" role="alert">
            <p className="text-xs text-amber-300">Unable to load group messages.</p>
            <button type="button" onClick={() => { setStatus('loading'); setReloadToken((token) => token + 1); }} className="rounded-md border border-neutral-700 px-3 py-2 text-xs text-neutral-300 hover:text-white">Try again</button>
          </div>
        ) : messages.length === 0 ? (
          <div className="my-auto text-center text-xs text-neutral-500">No group messages yet. Start the conversation!</div>
        ) : messages.map((message) => {
          const isMe = message.sender_id === currentUserId;
          return (
            <div key={message.id} className={`flex flex-col gap-1 ${isMe ? 'items-end' : 'items-start'}`}>
              <span className="text-[10px] font-semibold text-neutral-500">{nameOf(message.sender_id)}</span>
              <div className={`message-bubble max-w-[80%] p-3 text-sm text-white ${isMe ? 'is-own rounded-tr-sm' : 'rounded-tl-sm'}`}>{message.content}</div>
            </div>
          );
        })}
      </div>

      {actionError && <p className="border-t border-amber-500/20 bg-amber-500/5 px-4 py-2 text-xs text-amber-300" role="alert">{actionError}</p>}
      <form onSubmit={send} className="message-composer flex shrink-0 gap-2">
        <input type="text" value={text} onChange={(event) => setText(event.target.value)} maxLength={4000}
          placeholder={`Message ${groupName}…`} className="omni-input" disabled={sending || status !== 'ready'} aria-label={`Message ${groupName}`} />
        <button type="submit" disabled={!text.trim() || sending || status !== 'ready'} className="omni-button omni-button-primary">{sending ? '...' : 'Send'}</button>
      </form>
    </div>
  );
}
