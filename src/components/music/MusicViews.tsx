'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useMusicLibrary } from '@/hooks/useMusicLibrary';
import { formatExpiry, LIBRARY_SECTIONS, type LibrarySectionKey } from '@/lib/music-model';
import { NewPlaylistForm, UploadPanel } from './MusicLibraryParts';
import { FriendsListening } from './MusicTogether';
import { AlbumLockup, ArtistLockup, DetailHeader, EmptyState, PageTitle, PlaylistLockup, Shelf, TrackList, TrackLockups } from './MusicParts';


function Ready({ children }: { children: ReactNode }) {
  const library = useMusicLibrary();
  if (library.status === 'loading') {
    return (
      <div className="mu-skeleton" role="status" aria-label="Loading">
        <span className="mu-skel is-title" />
        <div className="mu-skel-row">{Array.from({ length: 6 }, (_, i) => <span key={i} className="mu-skel is-square" />)}</div>
      </div>
    );
  }
  if (library.status === 'error') {
    return (
      <EmptyState title="Couldn’t load your music" detail="Check your connection and try again.">
        <button type="button" className="mu-pill-button is-key" onClick={() => void library.reload()}>Try Again</button>
      </EmptyState>
    );
  }
  return children;
}

/** Expiry labels tick once a minute without re-fetching. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function HomeView() {
  const library = useMusicLibrary();
  const recent = [...new Map(library.history.filter((entry) => entry.available).map((entry) => [entry.id, entry])).values()];
  const empty = library.songs.length + library.shared.length + library.playlists.length === 0;
  return (
    <>
      <PageTitle>Home</PageTitle>
      <FriendsListening />
      <Ready>
        {empty ? (
          <EmptyState title="Your library is empty" detail="Upload your own music to play it here and anywhere in OmniLume.">
            <Link href="/music/library/uploads" className="mu-pill-button is-key">Upload Music</Link>
          </EmptyState>
        ) : (
          <>
            {library.songs.length ? <Shelf title="Recently Added" kind="tracks"><TrackLockups tracks={library.songs.slice(0, 16)} source="Recently Added" /></Shelf> : null}
            {recent.length ? <Shelf title="Recently Played" kind="tracks"><TrackLockups tracks={recent.slice(0, 16)} source="Recently Played" /></Shelf> : null}
            {library.albums.length ? <Shelf title="Albums" kind="square">{library.albums.map((album) => <AlbumLockup key={album.id} album={album} />)}</Shelf> : null}
            {library.playlists.length ? <Shelf title="Your Playlists" kind="square">{library.playlists.map((playlist) => <PlaylistLockup key={playlist.id} playlist={playlist} />)}</Shelf> : null}
            {library.shared.length ? <Shelf title="Shared with You" kind="tracks"><TrackLockups tracks={library.shared} source="Shared with You" /></Shelf> : null}
            {library.artists.length ? <Shelf title="Artists" kind="artists">{library.artists.map((artist) => <ArtistLockup key={artist.name} {...artist} />)}</Shelf> : null}
          </>
        )}
      </Ready>
    </>
  );
}

export function SearchResults({ query }: { query: string }) {
  const library = useMusicLibrary();
  const q = query.toLowerCase();
  const has = (...values: (string | undefined)[]) => values.some((value) => value?.toLowerCase().includes(q));
  const songs = [...library.songs, ...library.shared].filter((track) => has(track.title, track.artist, track.album));
  const albums = library.albums.filter((album) => has(album.title, album.artist));
  const artists = library.artists.filter((artist) => has(artist.name));
  const playlists = library.playlists.filter((playlist) => has(playlist.title));
  return (
    <Ready>
      {songs.length + albums.length + artists.length + playlists.length === 0 ? (
        <EmptyState title={`No results for “${query}”`} detail="Search looks through your uploads, playlists and songs shared with you." />
      ) : (
        <>
          <PageTitle>Results for “{query}”</PageTitle>
          {artists.length ? <Shelf title="Artists" kind="artists">{artists.map((artist) => <ArtistLockup key={artist.name} {...artist} />)}</Shelf> : null}
          {albums.length ? <Shelf title="Albums" kind="square">{albums.map((album) => <AlbumLockup key={album.id} album={album} />)}</Shelf> : null}
          {songs.length ? <Shelf title="Songs" kind="tracks"><TrackLockups tracks={songs} source={`Search: ${query}`} /></Shelf> : null}
          {playlists.length ? <Shelf title="Playlists" kind="square">{playlists.map((playlist) => <PlaylistLockup key={playlist.id} playlist={playlist} />)}</Shelf> : null}
        </>
      )}
    </Ready>
  );
}

export function LibrarySection({ section }: { section: LibrarySectionKey }) {
  const library = useMusicLibrary();
  const now = useNow();
  const { reload } = library;
  // History changes while listening elsewhere, so this view refreshes on open.
  useEffect(() => {
    if (section === 'history') void reload();
  }, [section, reload]);

  return (
    <>
      <PageTitle>{LIBRARY_SECTIONS[section]}</PageTitle>
      <div className="mu-section">
        {section === 'uploads' ? <UploadPanel /> : null}
        <Ready>
          {section === 'uploads' ? (
            library.uploads.length
              ? <TrackList tracks={library.uploads.filter((track) => track.available)} source="Uploads" showArt detail={(track) => (track.expiresAt ? formatExpiry(track.expiresAt, now) : undefined)} />
              : null
          ) : null}
          {section === 'songs' ? (
            library.songs.length ? <TrackList tracks={library.songs} source="Songs" showArt /> : <EmptyState title="No songs yet" detail="Songs you upload appear here."><Link href="/music/library/uploads" className="mu-pill-button is-key">Upload Music</Link></EmptyState>
          ) : null}
          {section === 'albums' ? (
            library.albums.length ? <div className="mu-grid">{library.albums.map((album) => <AlbumLockup key={album.id} album={album} />)}</div> : <EmptyState title="No albums yet" detail="Albums come from your uploads’ tags." />
          ) : null}
          {section === 'artists' ? (
            library.artists.length ? <div className="mu-grid is-artists">{library.artists.map((artist) => <ArtistLockup key={artist.name} {...artist} />)}</div> : <EmptyState title="No artists yet" />
          ) : null}
          {section === 'playlists' ? (
            <>
              <NewPlaylistForm />
              {library.playlists.length ? <div className="mu-grid">{library.playlists.map((playlist) => <PlaylistLockup key={playlist.id} playlist={playlist} />)}</div> : <EmptyState title="No playlists yet" detail="Create one, then add your uploads from a song’s ⋯ menu." />}
            </>
          ) : null}
          {section === 'shared' ? (
            library.shared.length
              ? <TrackList tracks={library.shared} source="Shared with Me" showArt detail={(track) => (track.expiresAt ? formatExpiry(track.expiresAt, now) : undefined)} />
              : <EmptyState title="Nothing shared with you" detail="Songs that members share to your rooms and groups appear here." />
          ) : null}
          {section === 'history' ? (
            library.history.length ? (
              <>
                <div className="mu-section-actions">
                  <button type="button" className="mu-text-button" onClick={() => window.confirm('Clear your listening history?') && void library.clearHistory()}>Clear History</button>
                </div>
                <TrackList tracks={library.history} source="Recently Played" showArt detail={(track) => new Date((track as { playedAt?: string }).playedAt ?? '').toLocaleString()} />
              </>
            ) : <EmptyState title="Nothing played yet" detail="Songs you play are listed here. Only you can see this." />
          ) : null}
        </Ready>
      </div>
    </>
  );
}

export function AlbumView({ id }: { id: string }) {
  const library = useMusicLibrary();
  const album = library.albums.find((item) => item.id === id);
  return (
    <Ready>
      {album ? (
        <>
          <DetailHeader title={album.title} subtitle={album.artist} meta={album.year ? `Album · ${album.year}` : 'Album'} hue={album.hue} artwork={album.artwork} tracks={album.tracks} />
          <div className="mu-section"><TrackList tracks={album.tracks} source={album.title} detail={() => undefined} /></div>
        </>
      ) : <EmptyState title="This album isn’t in your library" detail="Its songs may have expired or been deleted." />}
    </Ready>
  );
}

export function PlaylistView({ id }: { id: string }) {
  const library = useMusicLibrary();
  const router = useRouter();
  const playlist = library.playlists.find((item) => item.id === id);
  const remove = async () => {
    if (!playlist || !window.confirm(`Delete the playlist “${playlist.title}”? Your uploads stay in your library.`)) return;
    await library.deletePlaylist(playlist.id);
    router.push('/music/library/playlists');
  };
  return (
    <Ready>
      {playlist ? (
        <>
          <DetailHeader title={playlist.title} subtitle="Your playlist" meta="Playlist" hue={playlist.hue} artwork={playlist.tracks[0]?.artwork} tracks={playlist.tracks}>
            <button type="button" className="mu-text-button is-destructive" onClick={() => void remove()}>Delete Playlist</button>
          </DetailHeader>
          <div className="mu-section">
            {playlist.tracks.length
              ? <TrackList tracks={playlist.tracks} source={playlist.title} showArt playlistId={playlist.id} />
              : <EmptyState title="This playlist is empty" detail="Add songs from the ⋯ menu on any of your uploads." />}
          </div>
        </>
      ) : <EmptyState title="Playlist not found" detail="It may have been deleted." />}
    </Ready>
  );
}
