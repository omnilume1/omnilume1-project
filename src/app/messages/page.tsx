'use client';

import InternalTopbar from '@/components/ui/InternalTopbar';
import FloatingDock from '@/components/ui/FloatingDock';
import MessagesWorkspace from '@/components/chat/MessagesWorkspace';

export default function MessagesPage() {
  return (
    <div className="omni-internal">
      <InternalTopbar
        eyebrow="Private, by design"
        title="Messages"
        description="End-to-end encrypted conversations stay on your devices."
      />
      <main className="omni-main-content">
        <MessagesWorkspace />
      </main>
      <FloatingDock />
    </div>
  );
}
