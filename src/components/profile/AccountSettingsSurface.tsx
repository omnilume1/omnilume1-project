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
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [dialog, setDialog] = useState<'logout' | 'delete' | null>(null);

  const canDelete = confirmation === ACCOUNT_DELETION_CONFIRMATION && !deleting;

  function closeDialog() {
    if (deleting || loggingOut) return;
    setDialog(null);
    setDeleteError(null);
    setLogoutError(null);
  }

  function openDeleteDialog() {
    setConfirmation('');
    setDeleteError(null);
    setDialog('delete');
  }

  async function handleLogout(scope: 'local' | 'global') {
    setLoggingOut(true);
    setLogoutError(null);

    try {
      const { error } = await createClient().auth.signOut({ scope });
      if (error) throw error;

      // Supabase clears the browser session before this fresh request reaches
      // the existing proxy/session guard for the logged-out route.
      window.location.replace('/login');
    } catch {
      setLogoutError('We could not log you out. Please try again.');
      setLoggingOut(false);
    }
  }

  async function handleDelete(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canDelete) return;

    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteMyAccount(confirmation);
      // The secure server action removes the account. Clear browser state too
      // so a stale local session cannot linger before the logged-out redirect.
      await createClient().auth.signOut({ scope: 'local' });
      router.replace('/');
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'We could not delete your account. Please try again.');
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
        <section className="account-settings-grid !grid-cols-1">
          <div className="glass-panel settings-card">
            <p className="section-kicker">Account controls</p>
            <h2 className="section-title">Your account, your call.</h2>
            <p className="section-copy">Profile editing and visibility live on your profile page. This area is reserved for account-level actions that need extra care.</p>
            <div className="settings-link-list">
              <button type="button" onClick={() => router.push('/profile')} className="settings-link-row"><span><OmniIcon name="user" size={17} /><strong>Profile and privacy</strong><small>Update your identity, profile visibility and posts.</small></span><OmniIcon name="arrow" size={15} /></button>
              <button type="button" onClick={() => router.push('/home')} className="settings-link-row"><span><OmniIcon name="home" size={17} /><strong>Return to Home</strong><small>Continue to your rooms and shared spaces.</small></span><OmniIcon name="arrow" size={15} /></button>
            </div>
          </div>
        </section>

        <section className="mt-6 flex flex-col items-start gap-3" aria-label="Session and account actions">
          <button type="button" onClick={() => setDialog('logout')} className="omni-button omni-button-ghost !bg-black/60">
            <OmniIcon name="logout" size={15} /> Log out
          </button>
          <button type="button" onClick={openDeleteDialog} className="omni-button danger-button">
            <OmniIcon name="trash" size={15} /> Delete Account
          </button>
        </section>
      </main>
      <FloatingDock />

      {dialog === 'logout' && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" role="presentation">
          <section role="dialog" aria-modal="true" aria-labelledby="logout-dialog-title" className="w-full max-w-md rounded-2xl border border-white/10 bg-[#111217] p-6 shadow-2xl">
            <p className="section-kicker">Session control</p>
            <h2 id="logout-dialog-title" className="text-xl font-semibold tracking-tight text-white">Log out</h2>
            <p className="mt-3 text-sm leading-6 text-neutral-400">Choose whether to end this browser session only or revoke every active session for your account.</p>
            {logoutError && <p className="form-error mt-4" role="alert">{logoutError}</p>}
            <div className="mt-6 grid gap-3">
              <button type="button" disabled={loggingOut} onClick={() => void handleLogout('local')} className="omni-button omni-button-ghost !min-h-12 w-full !justify-start !bg-black/60 disabled:opacity-50">
                {loggingOut ? 'Logging out...' : 'Log out from this device'}
              </button>
              <button type="button" disabled={loggingOut} onClick={() => void handleLogout('global')} className="omni-button omni-button-ghost !min-h-12 w-full !justify-start !bg-black/60 disabled:opacity-50">
                {loggingOut ? 'Logging out...' : 'Log out from all devices'}
              </button>
            </div>
            <button type="button" disabled={loggingOut} onClick={closeDialog} className="mt-5 text-sm text-neutral-400 transition hover:text-white disabled:opacity-50">Cancel</button>
          </section>
        </div>
      )}

      {dialog === 'delete' && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" role="presentation">
          <section role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title" className="w-full max-w-md rounded-2xl border border-red-500/20 bg-[#111217] p-6 shadow-2xl">
            <div className="danger-zone-heading"><span className="danger-icon"><OmniIcon name="trash" size={17} /></span><div><p className="section-kicker">Permanent action</p><h2 id="delete-dialog-title">Delete Account</h2></div></div>
            <p className="mt-5 text-sm leading-6 text-neutral-300">This permanently removes your personal account data and files according to OmniLume&apos;s existing deletion policy. Shared room content continues to follow its server-side lifecycle rules.</p>
            <p className="settings-note mt-4"><OmniIcon name="lock" size={14} /> Your authenticated session and an exact confirmation are required.</p>
            <form onSubmit={(event) => void handleDelete(event)} className="delete-confirmation mt-5">
              <label htmlFor="delete-account-confirmation" className="form-label">Type <strong>{ACCOUNT_DELETION_CONFIRMATION}</strong> to continue</label>
              <input id="delete-account-confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className="omni-input" autoComplete="off" spellCheck={false} placeholder={ACCOUNT_DELETION_CONFIRMATION} disabled={deleting} />
              {deleteError && <p className="form-error" role="alert">{deleteError}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-4">
                <button type="submit" disabled={!canDelete} className="omni-button danger-button"><OmniIcon name="trash" size={15} /> {deleting ? 'Deleting account...' : 'Delete Account'}</button>
                <button type="button" disabled={deleting} onClick={closeDialog} className="text-sm text-neutral-400 transition hover:text-white disabled:opacity-50">Cancel</button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
