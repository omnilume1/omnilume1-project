'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSafeRedirectPath } from '@/lib/auth';
import { createClient } from '@/utils/supabase/client';

type PasswordAction = 'login' | 'signup';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);

  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    const error = new URLSearchParams(window.location.search).get('error');
    if (error === 'oauth_callback') {
      queueMicrotask(() => setErrorMessage('Google sign-in could not be completed. Please try again.'));
    }
  }, []);

  function getNextPath() {
    return getSafeRedirectPath(new URLSearchParams(window.location.search).get('next'));
  }

  async function handlePasswordAuth(type: PasswordAction) {
    setLoading(true);
    setErrorMessage(null);
    setNoticeMessage(null);

    try {
      if (type === 'login') {
        const { data, error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });

        if (error) {
          setErrorMessage(error.message);
          return;
        }
        if (!data.user) {
          setErrorMessage('We could not sign you in. Please try again.');
          return;
        }
      } else {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
        });

        if (error) {
          setErrorMessage(error.message);
          return;
        }
        if (!data.session) {
          setNoticeMessage('Check your email to confirm your account, then sign in.');
          return;
        }
      }

      router.replace(getNextPath());
    } catch {
      setErrorMessage('Authentication failed. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogleSignIn() {
    setLoading(true);
    setErrorMessage(null);
    setNoticeMessage(null);

    try {
      const nextPath = getNextPath();
      const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(nextPath)}`;
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo,
          queryParams: { prompt: 'select_account' },
        },
      });

      if (error) setErrorMessage('Google sign-in is unavailable right now. Please try again.');
    } catch {
      setErrorMessage('Google sign-in is unavailable right now. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-black px-6 text-white">
      <section className="w-full max-w-sm rounded-2xl border border-neutral-800 bg-[#0a0a0a] p-8 shadow-2xl">
        <h1 className="text-2xl font-bold">Omnilume Auth</h1>
        <p className="mb-6 mt-2 text-sm text-neutral-400">Sign in to access secure features.</p>

        {errorMessage && (
          <p className="mb-4 rounded border border-red-900 bg-red-950/50 p-3 text-xs text-red-300" role="alert">
            {errorMessage}
          </p>
        )}
        {noticeMessage && (
          <p className="mb-4 rounded border border-emerald-900 bg-emerald-950/40 p-3 text-xs text-emerald-300" role="status">
            {noticeMessage}
          </p>
        )}

        <button
          type="button"
          onClick={() => void handleGoogleSignIn()}
          disabled={loading}
          className="w-full rounded-lg border border-neutral-700 bg-white px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-neutral-200 disabled:cursor-wait disabled:opacity-60"
        >
          {loading ? 'Please wait...' : 'Continue with Google'}
        </button>

        <div className="my-6 flex items-center gap-3 text-[10px] uppercase tracking-[0.2em] text-neutral-600">
          <span className="h-px flex-1 bg-neutral-800" />
          <span>Existing account</span>
          <span className="h-px flex-1 bg-neutral-800" />
        </div>

        <form onSubmit={(event) => { event.preventDefault(); void handlePasswordAuth('login'); }} className="flex flex-col gap-4">
          <div>
            <label htmlFor="email" className="mb-1 block text-xs uppercase text-neutral-500">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              className="w-full rounded border border-neutral-800 bg-[#050505] px-3 py-2 text-sm text-white outline-none focus:border-neutral-500"
              placeholder="you@example.com"
              required
            />
          </div>
          <div>
            <label htmlFor="password" className="mb-1 block text-xs uppercase text-neutral-500">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              className="w-full rounded border border-neutral-800 bg-[#050505] px-3 py-2 text-sm text-white outline-none focus:border-neutral-500"
              required
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              disabled={loading || !email || !password}
              className="flex-1 rounded bg-neutral-800 py-2 text-sm text-white transition hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? 'Signing in...' : 'Log In'}
            </button>
            <button
              type="button"
              onClick={() => void handlePasswordAuth('signup')}
              disabled={loading || !email || !password}
              className="flex-1 rounded bg-white py-2 text-sm font-semibold text-black transition hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Create Account
            </button>
          </div>
        </form>

        <Link href="/forgot-password" className="mt-5 block text-center text-sm text-neutral-400 underline hover:text-white">
          Forgot password?
        </Link>
      </section>
    </main>
  );
}
