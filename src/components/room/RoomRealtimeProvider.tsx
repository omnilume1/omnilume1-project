'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { RoomPresenceValue } from '@/hooks/useRoomPresence';
import type { RoomSyncValue } from '@/hooks/useRoomSync';

export type RoomRealtimeValue = RoomSyncValue & RoomPresenceValue;

const RoomRealtimeContext = createContext<RoomRealtimeValue | null>(null);

interface RoomRealtimeProviderProps {
  sync: RoomSyncValue;
  presence: RoomPresenceValue;
  children: ReactNode;
}

/**
 * Shares the room's already-created realtime values with every room surface.
 * The provider deliberately does not create another Supabase channel.
 */
export default function RoomRealtimeProvider({ sync, presence, children }: RoomRealtimeProviderProps) {
  const value: RoomRealtimeValue = { ...sync, ...presence };

  return <RoomRealtimeContext.Provider value={value}>{children}</RoomRealtimeContext.Provider>;
}

export function useRoomRealtime(): RoomRealtimeValue {
  const value = useContext(RoomRealtimeContext);
  if (!value) {
    throw new Error('useRoomRealtime must be used inside a RoomRealtimeProvider.');
  }
  return value;
}
