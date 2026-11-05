import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { DM_Sans } from 'next/font/google';
import MusicShell from '@/components/music/MusicShell';
import './music.css';

const dmSans = DM_Sans({ subsets: ['latin'], variable: '--mu-font' });

export const metadata: Metadata = { title: 'Music · Omnilume' };

export default function MusicLayout({ children }: { children: ReactNode }) {
  return <MusicShell fontClass={dmSans.variable}>{children}</MusicShell>;
}
