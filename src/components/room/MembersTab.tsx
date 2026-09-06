'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getRoomMembersList, manageMemberRequest } from '@/actions/members';
import {
  getRoomMemberControlStates,
  moderateRoomMember,
  setRoomMemberRole,
  transferRoomOwnership,
} from '@/actions/room-controls';
import { useRoomRealtime } from '@/components/room/RoomRealtimeProvider';
import { OmniIcon } from '@/components/ui/OmniIcon';

interface MembersTabProps {
  roomId: string;
  currentUserRole: string | null;
  canManageMembers?: boolean;
  onChangeRole?: (userId: string) => void;
}

type RoomMember = {
  user_id: string;
  join_status: 'approved' | 'pending' | 'rejected';
  role: 'owner' | 'admin' | 'member' | 'guest';
};
type MemberState = {
  user_id: string;
  role: RoomMember['role'] | null;
  join_status: string | null;
  guest_expires_at: string | null;
  restriction_types: string[] | null;
};
type MemberAction = 'kick' | 'ban' | 'block' | 'unban' | 'unblock' | 'admin' | 'member' | 'transfer';

function messageFrom(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function userLabel(userId: string) {
  return `User ${userId.slice(0, 8)}`;
}

function formatExpiry(value: string | null) {
  return value ? new Date(value).toLocaleString() : 'No expiry';
}

export default function MembersTab({ roomId, currentUserRole, canManageMembers = false, onChangeRole }: MembersTabProps) {
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [memberStates, setMemberStates] = useState<MemberState[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ userId: string; action: MemberAction } | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { onlineUserIds, currentUserId, roomControlVersion } = useRoomRealtime();
  const canManage = currentUserRole === 'owner' || canManageMembers;

  const fetchMembers = useCallback(async () => {
    setLoading(true);
    try {
      const [memberData, controlStateData] = await Promise.all([
        getRoomMembersList(roomId),
        getRoomMemberControlStates(roomId),
      ]);
      setMembers((memberData as RoomMember[]) || []);
      setMemberStates((controlStateData as MemberState[]) || []);
      setError(null);
    } catch (loadError) {
      setError(messageFrom(loadError, 'Unable to load room members.'));
    } finally {
      setLoading(false);
    }
  }, [roomId]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void fetchMembers(); }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchMembers, roomControlVersion]);

  const handleManage = async (targetId: string, action: 'approve' | 'reject') => {
    setError(null);
    try {
      await manageMemberRequest(roomId, targetId, action);
      await fetchMembers();
    } catch (actionError) {
      setError(messageFrom(actionError, 'Unable to update member.'));
    }
  };

  const runMemberAction = async () => {
    if (!confirmAction) return;
    setWorking(true);
    setError(null);
    try {
      if (confirmAction.action === 'admin' || confirmAction.action === 'member') {
        await setRoomMemberRole(roomId, confirmAction.userId, confirmAction.action);
      } else if (confirmAction.action === 'transfer') {
        await transferRoomOwnership(roomId, confirmAction.userId);
      } else {
        await moderateRoomMember(roomId, confirmAction.userId, confirmAction.action);
      }
      setConfirmAction(null);
      setActiveMenuId(null);
      await fetchMembers();
    } catch (actionError) {
      setError(messageFrom(actionError, 'Unable to update this member.'));
    } finally {
      setWorking(false);
    }
  };

  const stateByUserId = useMemo(() => new Map(memberStates.map((state) => [state.user_id, state])), [memberStates]);
  const approvedMembers = members.filter((member) => member.join_status === 'approved');
  const pendingMembers = members.filter((member) => member.join_status === 'pending');
  const restrictedFormerMembers = memberStates.filter((state) => !members.some((member) => member.user_id === state.user_id) && (state.restriction_types?.length ?? 0) > 0);

  if (loading) return <div className="omni-state-screen min-h-0 p-4 text-xs text-neutral-500">Loading members...</div>;

  return (
    <div className="chat-panel flex h-full flex-col">
      <div className="chat-topbar shrink-0">
        <span className="text-xs font-semibold uppercase tracking-wider text-neutral-400">Room roster</span>
        <div className="flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-1"><div className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" /><span className="text-[10px] font-bold text-emerald-500">{onlineUserIds.length} online</span></div>
      </div>

      <div className="chat-scroller flex flex-col gap-6 custom-scrollbar">
        {error && <p role="alert" className="rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</p>}
        {canManage && pendingMembers.length > 0 && <section><h4 className="mb-3 text-[10px] font-bold uppercase tracking-wider text-amber-500">Pending requests ({pendingMembers.length})</h4><div className="flex flex-col gap-3">{pendingMembers.map((member) => <div key={member.user_id} className="flex flex-col gap-3 rounded-lg border border-amber-900/30 bg-[#121212] p-3"><span className="truncate text-xs text-neutral-300" title={member.user_id}>{userLabel(member.user_id)}</span><div className="flex gap-2"><button type="button" onClick={() => void handleManage(member.user_id, 'approve')} className="flex-1 rounded bg-emerald-500/10 py-1.5 text-xs font-semibold text-emerald-500 hover:bg-emerald-500/20">Approve</button><button type="button" onClick={() => void handleManage(member.user_id, 'reject')} className="flex-1 rounded bg-red-500/10 py-1.5 text-xs font-semibold text-red-500 hover:bg-red-500/20">Reject</button></div></div>)}</div></section>}

        <section><h4 className="mb-3 text-[10px] font-bold uppercase tracking-wider text-neutral-500">In room ({approvedMembers.length})</h4><div className="flex flex-col gap-2">{approvedMembers.map((member) => {
          const memberState = stateByUserId.get(member.user_id);
          const isOnline = onlineUserIds.includes(member.user_id);
          const canModerateTarget = canManage && member.user_id !== currentUserId && member.role !== 'owner' && !(currentUserRole === 'admin' && member.role === 'admin');
          return <article key={member.user_id} className="relative flex items-center justify-between gap-2 rounded-lg border border-transparent p-3 transition hover:border-neutral-800 hover:bg-neutral-900/50"><div className="flex min-w-0 items-center gap-3"><div className="relative"><div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-500/20 text-xs font-bold text-indigo-400">{member.user_id.slice(0, 2).toUpperCase()}</div><div className={`absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-[#050505] transition-all ${isOnline ? 'scale-100 bg-emerald-500' : 'scale-75 bg-neutral-600'}`} /></div><div className="min-w-0"><span className="block max-w-[120px] truncate text-sm font-medium text-white" title={member.user_id}>{userLabel(member.user_id)}</span><span className={`text-[10px] font-bold uppercase tracking-wider ${member.role === 'owner' ? 'text-amber-500' : member.role === 'admin' ? 'text-indigo-400' : 'text-neutral-500'}`}>{member.role}</span>{member.role === 'guest' && <span className="mt-1 block text-[10px] text-amber-300">Temporary guest · expires {formatExpiry(memberState?.guest_expires_at ?? null)}</span>}{(memberState?.restriction_types?.length ?? 0) > 0 && <span className="mt-1 block text-[10px] text-red-300">Restricted: {memberState?.restriction_types?.join(', ')}</span>}</div></div>{member.user_id !== currentUserId && <div className="relative"><button type="button" onClick={() => setActiveMenuId(activeMenuId === member.user_id ? null : member.user_id)} className="rounded-lg p-2 text-neutral-400 hover:bg-white/10 hover:text-white" aria-label={`Member actions for ${userLabel(member.user_id)}`}><OmniIcon name="more" size={17} /></button>{activeMenuId === member.user_id && canModerateTarget && <div className="absolute right-0 top-full z-30 mt-1 flex w-44 flex-col overflow-hidden rounded-xl border border-white/10 bg-[#15161d] py-1 shadow-2xl"><MenuAction label="Kick user" onClick={() => setConfirmAction({ userId: member.user_id, action: 'kick' })} /><MenuAction label="Ban user" tone="danger" onClick={() => setConfirmAction({ userId: member.user_id, action: 'ban' })} /><MenuAction label="Change role" onClick={() => { onChangeRole?.(member.user_id); setActiveMenuId(null); }} /></div>}</div>}</article>;
        })}</div></section>

        {canManage && restrictedFormerMembers.length > 0 && <section><h4 className="mb-3 text-[10px] font-bold uppercase tracking-wider text-red-300">Restricted accounts</h4><div className="space-y-2">{restrictedFormerMembers.map((state) => <article key={state.user_id} className="rounded-xl border border-red-400/20 bg-red-500/5 p-3"><p className="text-xs font-semibold text-white">{userLabel(state.user_id)}</p><p className="mt-1 text-xs text-red-200">{state.restriction_types?.join(', ')}</p><div className="mt-3 flex flex-wrap gap-2">{state.restriction_types?.includes('ban') && <button type="button" onClick={() => setConfirmAction({ userId: state.user_id, action: 'unban' })} className="omni-button omni-button-ghost text-xs">Remove ban</button>}{state.restriction_types?.includes('block') && <button type="button" onClick={() => setConfirmAction({ userId: state.user_id, action: 'unblock' })} className="omni-button omni-button-ghost text-xs">Remove block</button>}</div></article>)}</div></section>}
      </div>

      {confirmAction && <div className="border-t border-white/10 bg-[#121319] p-4" role="alertdialog" aria-label="Confirm member action"><p className="text-sm font-semibold text-white">{confirmAction.action === 'transfer' ? 'Transfer room ownership?' : `${confirmAction.action[0].toUpperCase()}${confirmAction.action.slice(1)} this member?`}</p><p className="mt-1 text-xs leading-5 text-neutral-400">{confirmAction.action === 'transfer' ? 'You will become an admin and must receive ownership again to reverse this.' : 'This action is checked and enforced by the room backend.'}</p><div className="mt-3 flex gap-2"><button type="button" disabled={working} onClick={() => void runMemberAction()} className="omni-button omni-button-primary">{working ? 'Saving…' : 'Confirm'}</button><button type="button" disabled={working} onClick={() => setConfirmAction(null)} className="omni-button omni-button-ghost">Cancel</button></div></div>}
    </div>
  );
}

function MenuAction({ label, onClick, tone = 'normal' }: { label: string; onClick: () => void; tone?: 'normal' | 'warning' | 'danger' }) {
  const toneClass = tone === 'danger' ? 'text-red-300 hover:bg-red-500/10' : tone === 'warning' ? 'text-amber-200 hover:bg-amber-500/10' : 'text-neutral-200 hover:bg-white/5';
  return <button type="button" onClick={onClick} className={`px-3 py-2 text-left text-xs font-medium ${toneClass}`}>{label}</button>;
}
