'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { createClient } from '@/utils/supabase/client';
import OmniLogo from '@/components/ui/OmniLogo';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const supabase = createClient();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setSent(false);
    setErrorMessage(null);

    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/auth/update-password`,
      });

      if (error) {
        setErrorMessage('We could not start password recovery. Please try again.');
        return;
      }

      setSent(true);
    } catch {
      setErrorMessage('We could not start password recovery. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="omni-state-screen">
      <section className="glass-panel omni-form-card !max-w-md">
        <OmniLogo />
        <p className="section-kicker mt-10">Account recovery</p>
        <h1 className="text-3xl font-bold tracking-tight text-white">Reset your password</h1>
        <p className="section-copy">We will send recovery instructions if this email can recover an account.</p>

        {sent && (
          <p className="form-success mt-4" role="status">
            Check your email for a secure password reset link.
          </p>
        )}
        {errorMessage && (
          <p className="form-error mt-4" role="alert">
            {errorMessage}
          </p>
        )}

        <form onSubmit={(event) => void handleSubmit(event)} className="mt-6 space-y-4">
          <div>
            <label htmlFor="recovery-email" className="form-label">Email</label>
            <input
              id="recovery-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
              className="omni-input"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !email.trim()}
            className="omni-button omni-button-primary w-full"
          >
            {loading ? 'Sending...' : 'Send reset link'}
          </button>
        </form>

        <Link href="/login" className="mt-5 block text-center text-sm text-neutral-400 underline hover:text-white">
          Back to sign in
        </Link>
      </section>
    </main>
  );
}
