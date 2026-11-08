'use client';

import { useLayoutEffect, useSyncExternalStore } from 'react';
import { APP_THEME_EVENT, APP_THEME_STORAGE_KEY, DEFAULT_APP_THEME, parseAppTheme, type AppTheme } from '@/lib/app-theme';

// Used only when the browser blocks storage (some private modes): the choice then lasts for this visit.
let unsavedTheme: AppTheme | null = null;

export function readStoredAppTheme(): AppTheme {
  if (unsavedTheme) return unsavedTheme;
  try {
    return parseAppTheme(window.localStorage.getItem(APP_THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_APP_THEME;
  }
}

function subscribe(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === APP_THEME_STORAGE_KEY) onChange();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(APP_THEME_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(APP_THEME_EVENT, onChange);
  };
}

/** The saved theme (per device). The server and the first client render use the default. */
export function useAppTheme(): AppTheme {
  return useSyncExternalStore(subscribe, readStoredAppTheme, () => DEFAULT_APP_THEME);
}

export function saveAppTheme(theme: AppTheme) {
  try {
    if (theme === DEFAULT_APP_THEME) window.localStorage.removeItem(APP_THEME_STORAGE_KEY);
    else window.localStorage.setItem(APP_THEME_STORAGE_KEY, theme);
    unsavedTheme = null;
  } catch {
    unsavedTheme = theme;
  }
  window.dispatchEvent(new Event(APP_THEME_EVENT));
}

/** Sets an attribute on <html> while the caller is mounted (before paint), and removes it after. */
export function useRootAttribute(name: string, value: string | null) {
  useLayoutEffect(() => {
    if (value === null) return;
    const root = document.documentElement;
    root.setAttribute(name, value);
    return () => root.removeAttribute(name);
  }, [name, value]);
}
