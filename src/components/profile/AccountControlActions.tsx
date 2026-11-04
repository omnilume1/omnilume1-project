'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { deleteMyAccount } from '@/actions/account';
import { ACCOUNT_DELETION_CONFIRMATION, ACCOUNT_DELETION_REAUTH_WINDOW_SECONDS } from '@/lib/account-deletion';
import { OmniIcon } from '@/components/ui/OmniIcon';
import { createClient } from '@/utils/supabase/client';

/**
 * The same protected session and deletion controls are used from Settings and
 * the mobile profile surface. Keeping their handlers here prevents either
 * location from creating a second logout or account-deletion flow.
 */
export default function AccountControlActions({ className = '' }: { className?: string }) {
  const router = useRouter();
  const [confirmation, setConfirmation] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [reauthRequired, setReauthRequired] = useState(false);
  const [reauthenticating, setReauthenticating] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [dialog, setDialog] = useState<'logout' | 'delete' | null>(null);

  const canDelete = confirmation === ACCOUNT_DELETION_CONFIRMATION && !deleting;

  function closeDialog() {
    if (deleting || loggingOut || reauthenticating) return;
    setDialog(null);
    setDeleteError(null);
    setReauthRequired(false);
    setLogoutError(null);
  }

  function openDeleteDialog() {
    setConfirmation('');
    setDeleteError(null);
    setReauthRequired(false);
    setDialog('delete');
  }

  // A fresh sign-in starts a new session with a new authentication time. The
  // user returns here and can confirm deletion within the allowed window.
  async function signInAgain() {
    setReauthenticating(true);
    const returnTo = `${window.location.pathname}${window.location.search}`;
    await createClient().auth.signOut({ scope: 'local' }).catch(() => undefined);
    window.location.replace(`/login?next=${encodeURIComponent(returnTo)}`);
  }

  async function handleLogout(scope: 'local' | 'global') {
    setLoggingOut(true);
    setLogoutError(null);

    try {
      const { error } = await createClient().auth.signOut({ scope });
      if (error) throw error;
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
      const result = await deleteMyAccount(confirmation);
      if (!result.success) {
        // Nothing was deleted: the server requires a recent sign-in.
        setReauthRequired(true);
        setDeleting(false);
        return;
      }
      await createClient().auth.signOut({ scope: 'local' });
      router.replace('/');
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'We could not delete your account. Please try again.');
      setDeleting(false);
    }
  }

  return (
    <>
      <section className={className} aria-label="Session and account actions">
        <button type="button" onClick={() => setDialog('logout')} className="omni-button omni-button-ghost !bg-black/60">
          <OmniIcon name="logout" size={15} /> Log out
        </button>
        <button type="button" onClick={openDeleteDialog} className="omni-button danger-button">
          <OmniIcon name="trash" size={15} /> Delete Account
        </button>
      </section>

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
            <p className="settings-note mt-4"><OmniIcon name="lock" size={14} /> For your security you must have signed in within the last {ACCOUNT_DELETION_REAUTH_WINDOW_SECONDS / 60} minutes, and type an exact confirmation.</p>
            {reauthRequired && (
              <div className="mt-4 rounded-xl border border-amber-400/20 bg-amber-500/10 p-3" role="alert">
                <p className="text-sm leading-6 text-amber-100">Please sign in again to confirm it&apos;s you. Your account was not deleted.</p>
                <button type="button" disabled={reauthenticating} onClick={() => void signInAgain()} className="omni-button omni-button-primary mt-3 disabled:opacity-50">
                  {reauthenticating ? 'Signing out...' : 'Sign in again'}
                </button>
              </div>
            )}
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
    </>
  );
}
