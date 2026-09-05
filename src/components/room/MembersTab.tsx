'use client';

import { useCallback, useEffect, useState } from 'react';
import { getRoomMembersList, manageMemberRequest } from '@/actions/members';
import { useRoomRealtime } from '@/components/room/RoomRealtimeProvider';

interface MembersTabProps {
  roomId: string;
  currentUserRole: string | null;
}

// 1. Strongly type the Database Member
interface RoomMember {
  user_id: string;
  join_status: 'approved' | 'pending' | 'rejected';
  role: 'owner' | 'admin' | 'member';
}

export default function MembersTab({ roomId, currentUserRole }: MembersTabProps) {
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [loading, setLoading] = useState(true);

  const { onlineUserIds } = useRoomRealtime();

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
  }, [fetchMembers]);

  const handleManage = async (targetId: string, action: 'approve' | 'reject') => {
    try {
      await manageMemberRequest(roomId, targetId, action);
      void fetchMembers(); // Refresh the list
    } catch (error: unknown) {
      alert(error instanceof Error ? error.message : 'Unable to update member.');
    }
  };

  if (loading) return <div className="omni-state-screen min-h-0 p-4 text-xs text-neutral-500">Loading members...</div>;

  const approvedMembers = members.filter(m => m.join_status === 'approved');
  const pendingMembers = members.filter(m => m.join_status === 'pending');
  const canManage = currentUserRole === 'owner' || currentUserRole === 'admin';

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
                <div key={member.user_id} className="flex items-center justify-between p-3 hover:bg-neutral-900/50 rounded-lg transition border border-transparent hover:border-neutral-800">
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
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
