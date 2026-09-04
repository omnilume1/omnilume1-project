'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { deleteMyAccount } from '@/actions/account';
import { ACCOUNT_DELETION_CONFIRMATION } from '@/lib/account-deletion';
import FloatingDock from '@/components/ui/FloatingDock';
import InternalTopbar from '@/components/ui/InternalTopbar';
import { OmniIcon } from '@/components/ui/OmniIcon';
import { createClient } from '@/utils/supabase/client';

export default function AccountSettingsSurface() {
  const router = useRouter();
  const [confirmation, setConfirmation] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const canDelete = confirmation === ACCOUNT_DELETION_CONFIRMATION && !deleting;

  async function handleDelete(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canDelete) return;

    setDeleting(true);
    setErrorMessage(null);
    try {
      await deleteMyAccount(confirmation);
      // The server action invalidates the server session. Clearing the local
      // client session as well prevents stale identity data after redirect.
      await createClient().auth.signOut({ scope: 'local' });
      router.replace('/');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'We could not delete your account. Please try again.');
      setDeleting(false);
    }
  }

  return (
    <div className="omni-internal settings-page">
      <InternalTopbar
        eyebrow="Account"
        title="Settings"
        description="Manage your profile, privacy and account lifecycle from one protected space."
        actions={<button type="button" onClick={() => router.back()} className="omni-button omni-button-ghost"><OmniIcon name="arrow" size={15} /> Back</button>}
      />
      <main className="omni-main-content account-settings-content">
        <section className="account-settings-grid">
          <div className="glass-panel settings-card">
            <p className="section-kicker">Account controls</p>
            <h2 className="section-title">Your account, your call.</h2>
            <p className="section-copy">Profile editing and visibility live on your profile page. This area is reserved for account-level actions that need extra care.</p>
            <div className="settings-link-list">
              <button type="button" onClick={() => router.push('/profile')} className="settings-link-row"><span><OmniIcon name="user" size={17} /><strong>Profile and privacy</strong><small>Update your identity, profile visibility and posts.</small></span><OmniIcon name="arrow" size={15} /></button>
              <button type="button" onClick={() => router.push('/home')} className="settings-link-row"><span><OmniIcon name="home" size={17} /><strong>Return to Home</strong><small>Continue to your rooms and shared spaces.</small></span><OmniIcon name="arrow" size={15} /></button>
            </div>
          </div>

          <section className="glass-panel danger-zone">
            <div className="danger-zone-heading"><span className="danger-icon"><OmniIcon name="trash" size={17} /></span><div><p className="section-kicker">Permanent action</p><h2>Delete account</h2></div></div>
            <p>This permanently removes your personal account data and personal files according to OmniLume’s existing deletion policy. Shared room content is handled by the server-side lifecycle rules and is not blindly deleted with your account.</p>
            <p className="settings-note"><OmniIcon name="lock" size={14} /> Your authenticated session and an exact confirmation are required. Provider-specific reauthentication is not claimed by the current backend.</p>
            <form onSubmit={(event) => void handleDelete(event)} className="delete-confirmation">
              <label htmlFor="delete-account-confirmation" className="form-label">Type <strong>{ACCOUNT_DELETION_CONFIRMATION}</strong> to continue</label>
              <input id="delete-account-confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className="omni-input" autoComplete="off" spellCheck={false} placeholder={ACCOUNT_DELETION_CONFIRMATION} disabled={deleting} />
              {errorMessage && <p className="form-error" role="alert">{errorMessage}</p>}
              <button type="submit" disabled={!canDelete} className="omni-button danger-button"><OmniIcon name="trash" size={15} /> {deleting ? 'Deleting account...' : 'Delete my account'}</button>
            </form>
          </section>
        </section>
      </main>
      <FloatingDock />
    </div>
  );
}
