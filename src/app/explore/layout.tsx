import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// The explore page is a client component, so its title lives here.
export const metadata: Metadata = { title: 'Explore Shared Rooms for Groups | Omnilume' };

export default function ExploreLayout({ children }: { children: ReactNode }) {
  return children;
}
