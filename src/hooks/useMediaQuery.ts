'use client';

import { useCallback, useSyncExternalStore } from 'react';

// True while the media query matches. The server (and the first hydration
// render) sees false, so markup never mismatches.
export function useMediaQuery(query: string) {
  const subscribe = useCallback((onChange: () => void) => {
    const list = window.matchMedia(query);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}
