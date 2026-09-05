'use client';

import { useCallback, useEffect, useState } from 'react';
import { getRoomMembersList, manageMemberRequest } from '@/actions/members';
import { moderateRoomMember, setRoomMemberRole, transferRoomOwnership } from '@/actions/room-controls';
import { OmniIcon } from '@/components/ui/OmniIcon';
import { useRoomRealtime } from '@/components/room/RoomRealtimeProvider';

interface MembersTabProps {
  roomId: string;
  currentUserRole: string | null;
  canManageMembers?: boolean;
}

// 1. Strongly type the Database Member
interface RoomMember {
  user_id: string;
  join_status: 'approved' | 'pending' | 'rejected';
  role: 'owner' | 'admin' | 'member' | 'guest';
}

type MemberAction = 'kick' | 'ban' | 'block' | 'admin' | 'member' | 'transfer';

export default function MembersTab({ roomId, currentUserRole, canManageMembers = false }: MembersTabProps) {
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ userId: string; action: MemberAction } | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { onlineUserIds, currentUserId, roomControlVersion } = useRoomRealtime();

  const fetchMembers = useCallback(async () => {
    try {
      const data = await getRoomMembersList(roomId);
      setMembers((data as RoomMember[]) || []);
    } catch (error) {
      console.error("Failed to load members:", error);
    } finally {
      setLoading(false);
    }
  }, [roomId]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void fetchMembers();
    }, 0);
    return () => clearTimeout(timer);
  }, [fetchMembers, roomControlVersion]);

  const handleManage = async (targetId: string, action: 'approve' | 'reject') => {
    try {
      await manageMemberRequest(roomId, targetId, action);
      void fetchMembers(); // Refresh the list
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : 'Unable to update member.');
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
      setError(actionError instanceof Error ? actionError.message : 'Unable to update this member.');
    } finally {
      setWorking(false);
    }
  };

  if (loading) return <div className="omni-state-screen min-h-0 p-4 text-xs text-neutral-500">Loading members...</div>;

  const approvedMembers = members.filter(m => m.join_status === 'approved');
  const pendingMembers = members.filter(m => m.join_status === 'pending');
  const canManage = currentUserRole === 'owner' || canManageMembers;

  return (
    <div className="chat-panel flex h-full flex-col">
      
      {/* PHASE 21: Live Status Header */}
      <div className="chat-topbar shrink-0">
        <span className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">Room Roster</span>
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20">
          <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></div>
          <span className="text-[10px] font-bold text-emerald-500">{onlineUserIds.length} Online</span>
        </div>
      </div>

      <div className="chat-scroller flex flex-col gap-6 custom-scrollbar">
        {error && <p role="alert" className="rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</p>}
        
        {/* Pending Requests (Only visible to Owners/Admins) */}
        {canManage && pendingMembers.length > 0 && (
          <div>
            <h4 className="text-[10px] font-bold text-amber-500 mb-3 uppercase tracking-wider">Pending Requests ({pendingMembers.length})</h4>
            <div className="flex flex-col gap-3">
              {pendingMembers.map((member) => (
                <div key={member.user_id} className="bg-[#121212] border border-amber-900/30 p-3 rounded-lg flex flex-col gap-3">
                  <span className="text-xs text-neutral-300 truncate" title={member.user_id}>
                    User: {member.user_id.substring(0, 8)}...
                  </span>
                  <div className="flex gap-2">
                    <button 
                      onClick={() => handleManage(member.user_id, 'approve')}
                      className="flex-1 py-1.5 bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 text-xs font-semibold rounded transition"
                    >
                      Approve
                    </button>
                    <button 
                      onClick={() => handleManage(member.user_id, 'reject')}
                      className="flex-1 py-1.5 bg-red-500/10 text-red-500 hover:bg-red-500/20 text-xs font-semibold rounded transition"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Approved Members List */}
        <div>
          <h4 className="text-[10px] font-bold text-neutral-500 mb-3 uppercase tracking-wider">In Room ({approvedMembers.length})</h4>
          <div className="flex flex-col gap-2">
            {approvedMembers.map((member) => {
              // PHASE 21: Check if this specific member is currently in the active WebSocket array
              const isOnline = onlineUserIds.includes(member.user_id);

              return (
              <div key={member.user_id} className="relative flex items-center justify-between gap-2 p-3 hover:bg-neutral-900/50 rounded-lg transition border border-transparent hover:border-neutral-800">
                  <div className="flex items-center gap-3">
                    
                    {/* Avatar with Live Status Indicator */}
                    <div className="relative">
                      <div className="w-8 h-8 rounded-full bg-indigo-500/20 text-indigo-400 flex items-center justify-center text-xs font-bold shrink-0">
                        {member.user_id.substring(0, 2).toUpperCase()}
                      </div>
                      {/* The Green Dot */}
                      <div className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-[#050505] transition-all duration-300 ${isOnline ? 'bg-emerald-500 scale-100' : 'bg-neutral-600 scale-75'}`}></div>
                    </div>

                    <div className="flex flex-col">
                      <span className="text-sm font-medium text-white truncate max-w-[120px]" title={member.user_id}>
                        User {member.user_id.substring(0, 4)}
                      </span>
                      <span className={`text-[10px] uppercase font-bold tracking-wider ${member.role === 'owner' ? 'text-amber-500' : member.role === 'admin' ? 'text-indigo-400' : 'text-neutral-500'}`}>
                        {member.role}
                      </span>
                      {member.role === 'guest' && <span className="mt-1 text-[10px] text-amber-300">Temporary guest · expiry is enforced by the server</span>}
                    </div>
                  </div>
                  {member.user_id !== currentUserId && canManage && member.role !== 'owner' && !(currentUserRole === 'admin' && member.role === 'admin') && (
                    <div className="relative">
                      <button type="button" onClick={() => setActiveMenuId(activeMenuId === member.user_id ? null : member.user_id)} className="rounded-lg p-2 text-neutral-400 hover:bg-white/10 hover:text-white" aria-label={`Manage member ${member.user_id}`}><OmniIcon name="more" size={17} /></button>
                      {activeMenuId === member.user_id && <div className="absolute right-0 top-full z-30 mt-1 flex w-44 flex-col overflow-hidden rounded-xl border border-white/10 bg-[#15161d] py-1 shadow-2xl">
                        {currentUserRole === 'owner' && member.role !== 'guest' && <>
                          <MenuAction label={member.role === 'admin' ? 'Make member' : 'Make admin'} onClick={() => setConfirmAction({ userId: member.user_id, action: member.role === 'admin' ? 'member' : 'admin' })} />
                          <MenuAction label="Transfer ownership" tone="warning" onClick={() => setConfirmAction({ userId: member.user_id, action: 'transfer' })} />
                        </>}
                        <MenuAction label="Kick from room" onClick={() => setConfirmAction({ userId: member.user_id, action: 'kick' })} />
                        <MenuAction label="Ban from room" tone="danger" onClick={() => setConfirmAction({ userId: member.user_id, action: 'ban' })} />
                        <MenuAction label="Block from room" tone="danger" onClick={() => setConfirmAction({ userId: member.user_id, action: 'block' })} />
                      </div>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {confirmAction && <div className="border-t border-white/10 bg-[#121319] p-4" role="alertdialog" aria-label="Confirm member action"><p className="text-sm font-semibold text-white">{confirmAction.action === 'transfer' ? 'Transfer room ownership?' : `${confirmAction.action[0].toUpperCase()}${confirmAction.action.slice(1)} this member?`}</p><p className="mt-1 text-xs leading-5 text-neutral-400">{confirmAction.action === 'transfer' ? 'You will become an admin and must receive ownership again to reverse this.' : 'This action is checked and enforced by the room backend.'}</p><div className="mt-3 flex gap-2"><button type="button" disabled={working} onClick={() => void runMemberAction()} className="omni-button omni-button-primary">{working ? 'Saving…' : 'Confirm'}</button><button type="button" disabled={working} onClick={() => setConfirmAction(null)} className="omni-button omni-button-ghost">Cancel</button></div></div>}
    </div>
  );
}

function MenuAction({ label, onClick, tone = 'normal' }: { label: string; onClick: () => void; tone?: 'normal' | 'warning' | 'danger' }) {
  const toneClass = tone === 'danger' ? 'text-red-300 hover:bg-red-500/10' : tone === 'warning' ? 'text-amber-200 hover:bg-amber-500/10' : 'text-neutral-200 hover:bg-white/5';
  return <button type="button" onClick={onClick} className={`px-3 py-2 text-left text-xs font-medium ${toneClass}`}>{label}</button>;
}
