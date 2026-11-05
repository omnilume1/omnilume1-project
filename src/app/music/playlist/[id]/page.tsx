import { notFound } from 'next/navigation';
import { PlaylistView } from '@/components/music/MusicViews';
import { isUuid } from '@/lib/music-upload-validation';

export default async function MusicPlaylistPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  return <PlaylistView id={id} />;
}
