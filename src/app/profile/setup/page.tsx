'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { completeIdentitySetup } from '@/actions/auth';
import { getMyProfile } from '@/actions/profiles';
import { getLoginPath, getSafeRedirectPath } from '@/lib/auth';
import { createClient } from '@/utils/supabase/client';
import ProfileForm from '@/components/profile/ProfileForm';
import OmniLogo from '@/components/ui/OmniLogo';

interface ProfileRecord {
  display_name: string | null;
  username: string | null;
  date_of_birth: string | null;
  gender: 'female' | 'male' | 'non_binary' | 'prefer_not_to_say' | 'other' | null;
  avatar_url: string | null;
  bio: string | null;
  is_private: boolean;
}

export default function ProfileSetupPage() {
  const [email, setEmail] = useState<string | null>(null);
  const [profile, setProfile] = useState<ProfileRecord | null>(null);
  const [nextPath, setNextPath] = useState('/home');
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
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
      try {
        const currentProfile = await getMyProfile();
        if (active) setProfile(currentProfile as ProfileRecord | null);
      } catch {
        // A profile row may not exist yet; ProfileForm can create it safely.
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadIdentity();
    return () => {
      active = false;
    };
  }, [router, supabase]);

  async function handleSaved() {
    const result = await completeIdentitySetup();
    if (!result.success) throw new Error(result.error);
    router.replace(nextPath);
  }

  if (loading) {
    return <main className="omni-state-screen text-sm text-zinc-400">Checking your account...</main>;
  }

  return (
    <main className="omni-state-screen profile-setup-screen">
      <div className="profile-setup-shell">
        <div className="profile-setup-intro">
          <OmniLogo />
          <div className="profile-setup-visual" aria-hidden="true">
            <span className="profile-setup-orb"><span /></span>
            <span className="profile-setup-orbit profile-setup-orbit-one" />
            <span className="profile-setup-orbit profile-setup-orbit-two" />
            <span className="profile-setup-visual-label">One profile<br />Many possibilities</span>
          </div>
          <p className="section-kicker text-violet-300">Your OmniLume identity</p>
          <h1>Make a space that feels like you.</h1>
          <p>Join a community that learns, creates and grows together. Sensitive details remain protected by the existing server and database rules.</p>
          {email && <p className="settings-note"><span>Signed in as</span> <strong>{email}</strong></p>}
          {pageError && <p className="form-error" role="alert">{pageError}</p>}
        </div>
        <ProfileForm
          initialProfile={profile}
          setup
          onSaved={async () => {
            try {
              await handleSaved();
            } catch {
              setPageError('We could not finish account setup. Please try again.');
              throw new Error('Profile setup could not be completed.');
            }
          }}
        />
      </div>
    </main>
  );
}
