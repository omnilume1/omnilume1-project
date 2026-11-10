'use client';

import { useEffect } from 'react';

// Registers public/sw.js (generated from src/lib/sw-cache-policy.ts): build files
// from cache, an offline page, and the home for push. Production only, and after
// `load`, so it never competes with the first paint.
export default function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    const register = () => { void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined); };
    if (document.readyState === 'complete') { register(); return; }
    window.addEventListener('load', register, { once: true });
    return () => window.removeEventListener('load', register);
  }, []);
  return null;
}
