'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { completeIdentitySetup } from '@/actions/auth';
import { getLoginPath, getSafeRedirectPath } from '@/lib/auth';
import { createClient } from '@/utils/supabase/client';

export default function ProfileSetupPage() {
  const [email, setEmail] = useState<string | null>(null);
  const [nextPath, setNextPath] = useState('/home');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    let active = true;
    const requestedNext = new URLSearchParams(window.location.search).get('next');
    const safeNextPath = getSafeRedirectPath(requestedNext);
    queueMicrotask(() => {
      if (active) setNextPath(safeNextPath);
    });

    async function loadIdentity() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!active) return;

      if (!user) {
        router.replace(getLoginPath(`/profile/setup?next=${encodeURIComponent(safeNextPath)}`));
        return;
      }

      setEmail(user.email ?? null);
      setLoading(false);
    }

    void loadIdentity();
    return () => {
      active = false;
    };
  }, [router, supabase]);

  async function handleContinue() {
    setSaving(true);
    setErrorMessage(null);

    try {
      const result = await completeIdentitySetup();
      if (!result.success) {
        setErrorMessage(result.error);
        return;
      }

      router.replace(nextPath);
    } catch {
      setErrorMessage('We could not finish account setup. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-black px-6 text-sm text-zinc-400">
        Checking your account...
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-black px-6 text-white">
      <section className="w-full max-w-md rounded-2xl border border-neutral-800 bg-[#0a0a0a] p-8 shadow-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">First step</p>
        <h1 className="mt-3 text-2xl font-bold">Set up your OmniLume identity</h1>
        <p className="mt-3 text-sm leading-6 text-neutral-400">
          Confirm this account before entering the app. Your full profile details can be added in the profile setup stage.
        </p>

        {email && (
          <p className="mt-5 rounded-lg border border-neutral-800 bg-black/40 px-3 py-2 text-sm text-neutral-300">
            Signed in as <span className="font-medium text-white">{email}</span>
          </p>
        )}

        {errorMessage && (
          <p className="mt-4 rounded-lg border border-red-900/70 bg-red-950/40 px-3 py-2 text-sm text-red-300" role="alert">
            {errorMessage}
          </p>
        )}

        <button
          type="button"
          onClick={() => void handleContinue()}
          disabled={saving}
          className="mt-6 w-full rounded-xl bg-white px-4 py-3 text-sm font-semibold text-black transition hover:bg-neutral-200 disabled:cursor-wait disabled:opacity-60"
        >
          {saving ? 'Saving...' : 'Continue to OmniLume'}
        </button>
      </section>
    </main>
  );
}
