import Link from 'next/link';
import FloatingDock from '@/components/ui/FloatingDock';
import InternalTopbar from '@/components/ui/InternalTopbar';
import { OmniIcon } from '@/components/ui/OmniIcon';

/**
 * This legacy route is intentionally context-free. Room-specific membership
 * controls need a concrete room identifier and continue to live in the active
 * room experience; showing placeholder people or editable roles here would be
 * misleading.
 */
export default function RoomSettingsPage() {
  return (
    <div className="omni-internal">
      <InternalTopbar eyebrow="Room management" title="Manage a room" description="Open a room first so its real members and permissions stay in context." />
      <main className="omni-main-content">
        <section className="glass-card-ambient empty-state">
          <span className="feature-float-icon"><OmniIcon name="rooms" size={20} /></span>
          <h2>Choose a room to manage</h2>
          <p>Room membership and permissions are available only from a specific room. This keeps real room data and owner controls scoped to the room they affect.</p>
          <Link href="/explore" className="omni-button omni-button-primary">Explore rooms <OmniIcon name="arrow" size={15} /></Link>
        </section>
      </main>
      <FloatingDock />
    </div>
  );
}
