import { notFound } from 'next/navigation';
import FloatingDock from '@/components/ui/FloatingDock';
import InternalTopbar from '@/components/ui/InternalTopbar';
import RecoveryReviewQueue from '@/components/admin/RecoveryReviewQueue';
import type { RecoveryReviewItem } from '@/actions/recovery';
import { createClient } from '@/utils/supabase/server';

// Site owners only (master plan §9: "The site owner can review and restore
// eligible data"). Everyone else gets the standard 404, so the page's
// existence is not revealed. The RPCs enforce the same rule server-side.
export default async function AdminRecoveryPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) notFound();

  const { data: isSiteOwner, error: ownerError } = await supabase.rpc('is_site_owner', { p_user_id: user.id });
  if (ownerError || isSiteOwner !== true) notFound();

  const { data, error } = await supabase.rpc('list_recovery_review_queue');

  return (
    <div className="omni-internal">
      <InternalTopbar
        eyebrow="Site owner"
        title="Room recovery"
        description="Review recovery requests for expired rooms. Approving reopens the room for 7 days."
      />
      <main className="omni-main-content">
        <RecoveryReviewQueue
          initialRequests={(data ?? []) as RecoveryReviewItem[]}
          initialError={error ? 'Unable to load recovery requests.' : null}
        />
      </main>
      <FloatingDock />
    </div>
  );
}
