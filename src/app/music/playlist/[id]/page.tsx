import { notFound } from 'next/navigation';
import { DetailHeader, TrackList } from '@/components/music/MusicParts';
import { MUSIC_PLAYLISTS } from '@/lib/music-fixtures';

export default async function MusicPlaylistPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const playlist = MUSIC_PLAYLISTS.find((item) => item.id === id);
  if (!playlist) notFound();

  return (
    <>
      <DetailHeader title={playlist.title} subtitle="OmniLume" meta="Playlist" description={playlist.description} hue={playlist.hue} tracks={playlist.tracks} />
      <div className="mu-section"><TrackList tracks={playlist.tracks} source={playlist.title} showArt /></div>
    </>
  );
}
