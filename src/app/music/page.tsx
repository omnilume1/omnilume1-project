import { AlbumLockup, ArtistLockup, PageTitle, PlaylistLockup, Shelf, TrackLockups } from '@/components/music/MusicParts';
import { MUSIC_ALBUMS, MUSIC_ARTISTS, MUSIC_PLAYLISTS, MUSIC_TRACKS } from '@/lib/music-fixtures';

export default function MusicHomePage() {
  return (
    <>
      <PageTitle>Home</PageTitle>
      <Shelf title="Recently Added" kind="square">
        {MUSIC_ALBUMS.map((album) => <AlbumLockup key={album.id} album={album} />)}
      </Shelf>
      <Shelf title="Top Songs" kind="tracks">
        <TrackLockups tracks={MUSIC_TRACKS.slice(0, 16)} source="Top Songs" />
      </Shelf>
      <Shelf title="Playlists" kind="square">
        {MUSIC_PLAYLISTS.map((playlist) => <PlaylistLockup key={playlist.id} playlist={playlist} />)}
      </Shelf>
      <Shelf title="Artists" kind="artists">
        {MUSIC_ARTISTS.map((artist) => <ArtistLockup key={artist.name} {...artist} />)}
      </Shelf>
    </>
  );
}
