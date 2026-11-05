import { notFound } from 'next/navigation';
import { AlbumLockup, ArtistLockup, PageTitle, PlaylistLockup, TrackList } from '@/components/music/MusicParts';
import { MUSIC_ALBUMS, MUSIC_ARTISTS, MUSIC_PLAYLISTS, MUSIC_TRACKS } from '@/lib/music-fixtures';

const TITLES = { songs: 'Songs', albums: 'Albums', artists: 'Artists', playlists: 'Playlists' } as const;

export function generateStaticParams() {
  return Object.keys(TITLES).map((section) => ({ section }));
}

export default async function MusicLibraryPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!(section in TITLES)) notFound();
  const key = section as keyof typeof TITLES;

  return (
    <>
      <PageTitle>{TITLES[key]}</PageTitle>
      <div className="mu-section">
        {key === 'songs' ? <TrackList tracks={MUSIC_TRACKS} source="Songs" showArt /> : null}
        {key === 'albums' ? <div className="mu-grid">{MUSIC_ALBUMS.map((album) => <AlbumLockup key={album.id} album={album} />)}</div> : null}
        {key === 'playlists' ? <div className="mu-grid">{MUSIC_PLAYLISTS.map((playlist) => <PlaylistLockup key={playlist.id} playlist={playlist} />)}</div> : null}
        {key === 'artists' ? <div className="mu-grid is-artists">{MUSIC_ARTISTS.map((artist) => <ArtistLockup key={artist.name} {...artist} />)}</div> : null}
      </div>
    </>
  );
}
