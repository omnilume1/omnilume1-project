import { RoomLifecycle } from '@/types/room';
import { calculateExpirationStatus } from '@/lib/room';

export default function ExpirationBadge({ room }: { room: RoomLifecycle }) {
  const status = calculateExpirationStatus(room);

  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-neutral-800 bg-neutral-900 px-3 py-1 text-xs text-neutral-300">
      <span className={`h-2 w-2 rounded-full ${room.expirationType === 'irreversible' ? 'bg-red-500' : 'bg-emerald-500'}`} />
      <span>{status.label} ({room.expirationType})</span>
    </div>
  );
}