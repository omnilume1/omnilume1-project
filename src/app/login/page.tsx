'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSafeRedirectPath } from '@/lib/auth';
import { createClient } from '@/utils/supabase/client';
import OmniLogo from '@/components/ui/OmniLogo';
import { OmniIcon } from '@/components/ui/OmniIcon';

type PasswordAction = 'login' | 'signup';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
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

  useEffect(() => {
    let active = true;

    async function redirectExistingSession() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!active) return;

      if (user) {
        router.replace(getSafeRedirectPath(new URLSearchParams(window.location.search).get('next')));
        return;
      }

      setCheckingSession(false);
    }

    void redirectExistingSession();
    return () => {
      active = false;
    };
  }, [router, supabase]);

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

  if (checkingSession) {
    return <main className="auth-shell"><div className="auth-session-check glass-card-ambient" role="status">Checking your session...</div></main>;
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="auth-form-pane">
          <OmniLogo />
          <p className="section-kicker mt-10">Welcome back</p>
          <h1 className="text-3xl font-bold tracking-tight text-white">Sign in to OmniLume</h1>
          <p className="section-copy mb-6">Enter your shared spaces, conversations and next focus session.</p>

          {errorMessage && (
            <p className="form-error mb-4" role="alert">
              {errorMessage}
            </p>
          )}
          {noticeMessage && (
            <p className="form-success mb-4" role="status">
              {noticeMessage}
            </p>
          )}

          <button
            type="button"
            onClick={() => void handleGoogleSignIn()}
            disabled={loading}
            className="omni-button omni-button-primary w-full"
          >
            {loading ? 'Please wait...' : <><span className="flex h-5 w-5 items-center justify-center rounded-full border border-black/20 text-xs font-bold">G</span> Continue with Google</>}
          </button>

          <div className="my-6 flex items-center gap-3 text-[10px] uppercase tracking-[0.2em] text-neutral-600">
            <span className="h-px flex-1 bg-neutral-800" />
            <span>Existing account</span>
            <span className="h-px flex-1 bg-neutral-800" />
          </div>

          <form onSubmit={(event) => { event.preventDefault(); void handlePasswordAuth('login'); }} className="flex flex-col gap-4">
            <div>
              <label htmlFor="email" className="form-label">Email</label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                className="omni-input"
                placeholder="you@example.com"
                required
              />
            </div>
            <div>
              <label htmlFor="password" className="form-label">Password</label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                className="omni-input"
                required
              />
            </div>

            <div className="flex gap-3 pt-2">
              <button
                type="submit"
                disabled={loading || !email || !password}
                className="omni-button omni-button-ghost flex-1"
              >
                {loading ? 'Signing in...' : 'Log In'}
              </button>
              <button
                type="button"
                onClick={() => void handlePasswordAuth('signup')}
                disabled={loading || !email || !password}
                className="omni-button omni-button-primary flex-1"
              >
                Create Account
              </button>
            </div>
          </form>

          <Link href="/forgot-password" className="mt-5 block text-center text-sm text-neutral-400 underline hover:text-white">
            Forgot password?
          </Link>
        </div>

        <aside className="auth-community-pane" aria-label="The OmniLume community">
          <div className="auth-community-orb" aria-hidden="true" />
          <div className="auth-avatar-stack auth-feature-stack" aria-hidden="true">
            <span><OmniIcon name="study" size={17} /></span><span><OmniIcon name="message" size={17} /></span><span><OmniIcon name="music" size={17} /></span><span><OmniIcon name="file" size={17} /></span>
          </div>
          <p className="section-kicker">A shared space for momentum</p>
          <h2>Good things happen together.</h2>
          <p>Find a calm room, bring your people and make space for the work that matters.</p>
          <div className="auth-stat-row auth-signal-row">
            <div><strong>Study</strong><span>make progress</span></div>
            <div><strong>Connect</strong><span>find your people</span></div>
            <div><strong>Create</strong><span>share momentum</span></div>
          </div>
          <div className="auth-preview" aria-hidden="true">
            <span className="auth-preview-dot" />
            <span className="auth-preview-title">Shared focus room</span>
            <span className="auth-preview-meta">A calm visual preview of working together</span>
            <span className="auth-preview-progress"><span /></span>
          </div>
        </aside>
      </section>
    </main>
  );
}
