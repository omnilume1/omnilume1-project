'use client';

import { usePathname } from 'next/navigation';
import { useLayoutEffect } from 'react';
import { readStoredAppTheme, useAppTheme } from '@/hooks/useAppTheme';
import { applyThemeAttributes, themeAttributes } from '@/lib/app-theme';

/**
 * Keeps <html data-section data-app-theme> right after client navigation and theme changes.
 * The <head> boot script sets them before the first paint; this re-applies them when the
 * page changes, when another tab changes the theme, and after React's dev remount clears them.
 */
export default function AppThemeSync() {
  const pathname = usePathname();
  // Subscribing re-runs the effect on change; the effect reads storage itself, so the
  // hydration render (which reports the default) never strips a saved theme.
  const theme = useAppTheme();
  useLayoutEffect(() => {
    applyThemeAttributes(document.documentElement, themeAttributes(pathname, readStoredAppTheme()));
  }, [pathname, theme]);
  return null;
}
