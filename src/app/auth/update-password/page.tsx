'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { createClient } from '@/utils/supabase/client';
import OmniLogo from '@/components/ui/OmniLogo';

type SessionState = 'loading' | 'ready' | 'missing';

export default function UpdatePasswordPage() {
  const [sessionState, setSessionState] = useState<SessionState>('loading');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    let active = true;

    async function loadSession() {
      const { data: { session } } = await supabase.auth.getSession();
      if (active) setSessionState(session ? 'ready' : 'missing');
    }

    void loadSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event: AuthChangeEvent, session: Session | null) => {
      if (active && session) setSessionState('ready');
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [supabase]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);

    if (password.length < 8) {
      setErrorMessage('Use a password with at least 8 characters.');
      return;
    }
    if (password !== confirmation) {
      setErrorMessage('The passwords do not match.');
      return;
    }

    setSaving(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) {
        setErrorMessage('We could not update your password. Request a new reset link and try again.');
        return;
      }

      setSuccessMessage('Password updated. Redirecting...');
      router.replace('/home');
    } catch {
      setErrorMessage('We could not update your password. Request a new reset link and try again.');
    } finally {
      setSaving(false);
    }
  }

  if (sessionState === 'loading') {
    return <main className="omni-state-screen text-sm text-neutral-400">Checking reset link...</main>;
  }

  if (sessionState === 'missing') {
    return (
      <main className="omni-state-screen">
        <section className="glass-panel omni-form-card !max-w-md text-center">
          <OmniLogo />
          <p className="section-kicker mt-10">Account recovery</p>
          <h1 className="text-2xl font-bold">Reset link unavailable</h1>
          <p className="mt-3 text-sm leading-6 text-neutral-400">This link may be expired or already used. Request a new one to continue.</p>
          <Link href="/forgot-password" className="omni-button omni-button-primary mt-6">Request a new link</Link>
        </section>
      </main>
    );
  }

  return (
    <main className="omni-state-screen">
      <section className="glass-panel omni-form-card !max-w-md">
        <OmniLogo />
        <p className="section-kicker mt-10">Account recovery</p>
        <h1 className="text-2xl font-bold">Choose a new password</h1>
        {errorMessage && <p className="mt-4 rounded-lg border border-red-900/70 bg-red-950/40 px-3 py-2 text-sm text-red-300" role="alert">{errorMessage}</p>}
        {successMessage && <p className="mt-4 rounded-lg border border-emerald-900/70 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-300" role="status">{successMessage}</p>}

        <form onSubmit={(event) => void handleSubmit(event)} className="mt-6 grid gap-4">
          <div>
            <label htmlFor="new-password" className="form-label">New password</label>
            <input id="new-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={8} required className="omni-input" />
          </div>
          <div>
            <label htmlFor="confirm-password" className="form-label">Confirm password</label>
            <input id="confirm-password" type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" minLength={8} required className="omni-input" />
          </div>
          <button type="submit" disabled={saving} className="omni-button omni-button-primary w-full">
            {saving ? 'Updating...' : 'Update password'}
          </button>
        </form>
      </section>
    </main>
  );
}
