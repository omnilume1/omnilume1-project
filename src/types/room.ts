export type ExpirationType = 'permanent' | 'recoverable' | 'irreversible';

export interface RoomLifecycle {
  id: string;
  name: string;
  expirationType: ExpirationType;
  expiresAt: string | null;
  isQuarantined?: boolean;
}