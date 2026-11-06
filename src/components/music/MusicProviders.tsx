'use client';

import type { ReactNode } from 'react';
// App-wide styles ride along with the providers, so the landing never downloads them.
import '@/app/app.css';
import '@/app/management.css';
import GlobalMiniPlayer from '@/components/music/GlobalMiniPlayer';
import { ListenTogetherProvider } from '@/hooks/useListenTogether';
import { MusicPlayerProvider } from '@/hooks/useMusicPlayer';

// Music state for every app page, with the mini player that follows you between them.
// Everything off the landing renders inside this (see AppProviders).
export default function MusicProviders({ children }: { children: ReactNode }) {
  return (
    <MusicPlayerProvider>
      <ListenTogetherProvider>
        {children}
        <GlobalMiniPlayer />
      </ListenTogetherProvider>
    </MusicPlayerProvider>
  );
}
