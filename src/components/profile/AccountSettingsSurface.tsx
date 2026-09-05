'use client';

import { useRouter } from 'next/navigation';
import AccountControlActions from '@/components/profile/AccountControlActions';
import FloatingDock from '@/components/ui/FloatingDock';
import InternalTopbar from '@/components/ui/InternalTopbar';
import { OmniIcon } from '@/components/ui/OmniIcon';

export default function AccountSettingsSurface() {
  const router = useRouter();

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

        <AccountControlActions className="mt-6 flex flex-col items-start gap-3" />
      </main>
      <FloatingDock />
    </div>
  );
}
