'use client';

import { useRouter } from 'next/navigation';
import AccountControlActions from '@/components/profile/AccountControlActions';
import AppearanceSettings from '@/components/profile/AppearanceSettings';
import { PushSettingsRow } from '@/components/ui/PushControls';
import FloatingDock from '@/components/ui/FloatingDock';
import InternalTopbar from '@/components/ui/InternalTopbar';
import { OmniIcon } from '@/components/ui/OmniIcon';
import styles from './settings.module.css';

export default function AccountSettingsSurface() {
  const router = useRouter();

  return (
    <div className="omni-internal settings-page">
      <InternalTopbar
        eyebrow="Account"
        title="Settings"
        description="Choose your theme and manage your profile, privacy and account."
        actions={<button type="button" onClick={() => router.back()} className="omni-button omni-button-ghost"><OmniIcon name="arrow" size={15} /> Back</button>}
      />
      <main className="omni-main-content account-settings-content">
        <div className={styles.layout}>
          <nav className={styles.nav} aria-label="Settings sections">
            <a href="#appearance"><OmniIcon name="spark" size={16} /> Appearance</a>
            <a href="#account"><OmniIcon name="user" size={16} /> Account</a>
          </nav>
          <div className={styles.content}>
            <AppearanceSettings />
            <section id="account" className={styles.group} aria-labelledby="account-title">
              <div className={styles.groupHead}>
                <h2 id="account-title">Account</h2>
                <p>Profile editing and visibility live on your profile page. This area is reserved for account-level actions that need extra care.</p>
              </div>
              <div className={styles.card}>
                <button type="button" onClick={() => router.push('/profile')} className={`${styles.row} ${styles.linkRow}`}><span className={styles.rowText}><strong>Profile and privacy</strong><small>Update your identity, profile visibility and posts.</small></span><span className={styles.rowControl}><OmniIcon name="arrow" size={15} /></span></button>
                <button type="button" onClick={() => router.push('/home')} className={`${styles.row} ${styles.linkRow}`}><span className={styles.rowText}><strong>Return to Home</strong><small>Continue to your rooms and shared spaces.</small></span><span className={styles.rowControl}><OmniIcon name="arrow" size={15} /></span></button>
                <PushSettingsRow classes={{ row: styles.row, rowText: styles.rowText, rowControl: styles.rowControl }} />
                <div className={styles.row}>
                  <div className={styles.rowText}><strong>Session and account</strong><small>Log out of this device or every device, or delete your account.</small></div>
                  <div className={styles.rowControl}><AccountControlActions className={styles.actions} /></div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </main>
      <FloatingDock />
    </div>
  );
}
