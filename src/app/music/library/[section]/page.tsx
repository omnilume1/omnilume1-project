import { notFound } from 'next/navigation';
import { LibrarySection } from '@/components/music/MusicViews';
import { LIBRARY_SECTIONS, type LibrarySectionKey } from '@/lib/music-model';

export function generateStaticParams() {
  return Object.keys(LIBRARY_SECTIONS).map((section) => ({ section }));
}

export default async function MusicLibraryPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!(section in LIBRARY_SECTIONS)) notFound();
  return <LibrarySection section={section as LibrarySectionKey} />;
}
