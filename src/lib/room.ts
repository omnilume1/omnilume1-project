import { RoomLifecycle } from '@/types/room';

// ==========================================
// 1. ORIGINAL HELPER FUNCTIONS (RESTORED)
// ==========================================

export function createLocalRoomCode() {
  // Generates a random 6-character room code
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

export function normalizeRoomId(roomId: string) {
  // Cleans up the room ID (removes spaces, makes uppercase)
  return roomId.trim().toUpperCase();
}


// ==========================================
// 2. PHASE 9 EXPIRATION & LIFECYCLE LOGIC
// ==========================================

export interface ExtendedRoomLifecycle extends RoomLifecycle {
  deletionScheduledAt?: string | null;
  recoveryRequested?: boolean;
}

export function calculateExpirationStatus(room: ExtendedRoomLifecycle) {
  const now = new Date().getTime();

  // 1. Permanent Room Handling
  if (room.expirationType === 'permanent') {
    if (room.deletionScheduledAt) {
      const deletionTime = new Date(room.deletionScheduledAt).getTime();
      const gracePeriodMs = 7 * 24 * 3600 * 1000; // 7 Days Grace Period
      const permanentDeleteTime = deletionTime + gracePeriodMs;
      const daysRemaining = Math.max(0, Math.ceil((permanentDeleteTime - now) / (1000 * 3600 * 24)));

      return {
        isExpired: daysRemaining <= 0,
        isPendingDeletion: true,
        daysRemaining,
        label: `Deleting in ${daysRemaining} days`,
        canRecover: true,
      };
    }

    return { 
      isExpired: false, 
      isPendingDeletion: false, 
      label: 'Permanent Space', 
      canRecover: false 
    };
  }

  // 2. Temporary Rooms (Recoverable or Irreversible)
  if (!room.expiresAt) {
    return { isExpired: false, isPendingDeletion: false, label: 'Active', canRecover: false };
  }

  const expireTime = new Date(room.expiresAt).getTime();
  const isExpired = now >= expireTime;

  return {
    isExpired,
    isPendingDeletion: false,
    label: isExpired ? 'Expired' : 'Temporary Space',
    canRecover: isExpired && room.expirationType === 'recoverable',
  };
}