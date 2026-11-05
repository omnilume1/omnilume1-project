import { notFound } from 'next/navigation';
import { AlbumLockup, DetailHeader, Shelf, TrackList } from '@/components/music/MusicParts';
import { MUSIC_ALBUMS } from '@/lib/music-fixtures';

export default async function MusicAlbumPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const album = MUSIC_ALBUMS.find((item) => item.id === id);
  if (!album) notFound();
  const more = MUSIC_ALBUMS.filter((item) => item.artist === album.artist && item.id !== album.id);

  return (
    <>
      <DetailHeader title={album.title} subtitle={album.artist} meta={`${album.genre} · ${album.year}`} hue={album.hue} tracks={album.tracks} />
      <div className="mu-section"><TrackList tracks={album.tracks} source={album.title} showAlbum={false} /></div>
      {more.length ? (
        <div className="mu-alt-section">
          <Shelf title={`More by ${album.artist}`} kind="square">{more.map((item) => <AlbumLockup key={item.id} album={item} />)}</Shelf>
        </div>
      ) : null}
    </>
  );
}
