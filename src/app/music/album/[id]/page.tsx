import { notFound } from 'next/navigation';
import { AlbumView } from '@/components/music/MusicViews';

export default async function MusicAlbumPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-z]{1,13}$/.test(id)) notFound();
  return <AlbumView id={id} />;
}
