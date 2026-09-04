'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { createClient } from '@/utils/supabase/client';

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
    <main className="flex min-h-screen items-center justify-center bg-black px-6 text-white">
      <section className="w-full max-w-sm rounded-2xl border border-neutral-800 bg-[#0a0a0a] p-8 shadow-2xl">
        <h1 className="text-2xl font-bold">Reset your password</h1>
        <p className="mt-2 text-sm text-neutral-400">We will send recovery instructions if this email can recover an account.</p>

        {sent && (
          <p className="mt-4 rounded-lg border border-emerald-900/70 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-300" role="status">
            Check your email for a secure password reset link.
          </p>
        )}
        {errorMessage && (
          <p className="mt-4 rounded-lg border border-red-900/70 bg-red-950/40 px-3 py-2 text-sm text-red-300" role="alert">
            {errorMessage}
          </p>
        )}

        <form onSubmit={(event) => void handleSubmit(event)} className="mt-6 space-y-4">
          <div>
            <label htmlFor="recovery-email" className="mb-1 block text-xs uppercase tracking-wide text-neutral-500">Email</label>
            <input
              id="recovery-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
              className="w-full rounded-lg border border-neutral-800 bg-[#050505] px-3 py-2.5 text-sm text-white outline-none focus:border-indigo-500"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !email.trim()}
            className="w-full rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-60"
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
