'use client';

import { useEffect } from 'react';

// Registers public/sw.js (generated from src/lib/sw-cache-policy.ts): build files
// from cache, an offline page, and the home for push. Production only, and after
// `load`, so it never competes with the first paint.
export default function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    const register = () => {
      void navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(() => {
        // Devices that turned notifications on: keep the subscription fresh, at most once a day.
        // Loaded only for them, so no other page pays for the Supabase client here.
        let enabled = false;
        try { enabled = 'Notification' in window && Notification.permission === 'granted' && localStorage.getItem('omnilume:push-enabled') === '1'; } catch { enabled = false; }
        if (enabled) void import('@/lib/push-client').then((push) => push.refreshPush()).catch(() => undefined);
      }).catch(() => undefined);
    };
    if (document.readyState === 'complete') { register(); return; }
    window.addEventListener('load', register, { once: true });
    return () => window.removeEventListener('load', register);
  }, []);
  return null;
}
