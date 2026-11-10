// Master plan §9: the room's deletion policy must be clear before people
// join. No imports: unit tests load this module directly.

export type RoomPolicyInput = {
  expiration_type: string | null | undefined;
  deletion_scheduled_at?: string | null;
};

export type RoomDeletionPolicy = {
  kind: 'permanent' | 'recoverable' | 'irreversible' | 'unknown';
  label: string;
  description: string;
};

export const ROOM_RECOVERY_WINDOW_DAYS = 7;

// A pending recovery request that no site owner answers lapses after this many
// days; the room is then deleted (public.room_lifecycle_state).
export const RECOVERY_REQUEST_LAPSE_DAYS = 7;

export function recoveryRequestLapsesAt(requestedAt: string): Date {
  return new Date(new Date(requestedAt).getTime() + RECOVERY_REQUEST_LAPSE_DAYS * 86_400_000);
}

export function roomDeletionPolicy(room: RoomPolicyInput): RoomDeletionPolicy {
  switch (room.expiration_type) {
    case 'permanent':
      return room.deletion_scheduled_at
        ? {
          kind: 'permanent',
          label: 'Permanent · deletion scheduled',
          description: `Permanent room. The owner scheduled deletion for ${new Date(room.deletion_scheduled_at).toLocaleDateString([], { dateStyle: 'medium' })}; everything is deleted then unless they cancel.`,
        }
        : {
          kind: 'permanent',
          label: 'Permanent',
          description: 'Never expires. Deleted only if the owner schedules deletion, after a 7–14 day grace period.',
        };
    case 'recoverable':
      return {
        kind: 'recoverable',
        label: `Temporary · ${ROOM_RECOVERY_WINDOW_DAYS}-day recovery`,
        description: `Closes when its timer ends. Members can request recovery for ${ROOM_RECOVERY_WINDOW_DAYS} days; without a request, or if a request isn't answered within ${RECOVERY_REQUEST_LAPSE_DAYS} days, all chats and files are permanently deleted.`,
      };
    case 'irreversible':
      return {
        kind: 'irreversible',
        label: 'Temporary · deleted at expiry',
        description: 'Closes when its timer ends and is permanently deleted. It can never be recovered, not even by a site owner.',
      };
    default:
      return { kind: 'unknown', label: 'Deletion policy unavailable', description: 'This room did not report its deletion policy.' };
  }
}
