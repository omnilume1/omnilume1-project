'use client';

import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';

// The music providers bring the Supabase client and the player with them. The landing uses neither,
// so they load on the first app page instead (server-rendered there, so app pages hydrate as before)
// and then stay mounted for the rest of the visit, keeping playback going across every page.
const MusicProviders = dynamic(() => import('@/components/music/MusicProviders'));

export default function AppProviders({ children }: { children: ReactNode }) {
  const onLanding = usePathname() === '/';
  const [needed, setNeeded] = useState(!onLanding);
  if (!needed && !onLanding) setNeeded(true);
  return needed ? <MusicProviders>{children}</MusicProviders> : children;
}
