import Form from 'next/form';
import Link from 'next/link';
import { MusicIcon } from '@/components/music/MusicIcon';
import { AlbumLockup, Artwork, ArtistLockup, EmptyState, PageTitle, PlaylistLockup, Shelf, TrackLockups } from '@/components/music/MusicParts';
import { MUSIC_CATEGORIES, searchMusic } from '@/lib/music-fixtures';

export default async function MusicSearchPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const raw = (await searchParams).q;
  const query = (Array.isArray(raw) ? raw[0] : raw ?? '').trim().slice(0, 100);
  const results = searchMusic(query);
  const total = results.songs.length + results.albums.length + results.artists.length + results.playlists.length;

  return (
    <>
      <div className="mu-scope-bar">
        <Form action="/music/search" className="mu-search is-wide" role="search">
          <MusicIcon name="search" size={16} />
          <input name="q" type="search" defaultValue={query} placeholder="Artists, songs, albums" aria-label="Search music" maxLength={100} data-music-search />
        </Form>
      </div>
      {!query ? (
        <>
          <PageTitle>Search</PageTitle>
          <section className="mu-section" aria-label="Browse categories">
            <h2 className="mu-section-title">Browse Categories</h2>
            <div className="mu-tiles">
              {MUSIC_CATEGORIES.map((category) => (
                <Link key={category.name} href={`/music/search?q=${encodeURIComponent(category.name)}`} className="mu-tile">
                  <Artwork hue={category.hue} className="is-tile" />
                  <span>{category.name}</span>
                </Link>
              ))}
            </div>
          </section>
        </>
      ) : total === 0 ? (
        <EmptyState title={`No results for “${query}”`} detail="Check the spelling or try a different search." />
      ) : (
        <>
          <PageTitle>Results for “{query}”</PageTitle>
          {results.artists.length ? <Shelf title="Artists" kind="artists">{results.artists.map((artist) => <ArtistLockup key={artist.name} {...artist} />)}</Shelf> : null}
          {results.albums.length ? <Shelf title="Albums" kind="square">{results.albums.map((album) => <AlbumLockup key={album.id} album={album} />)}</Shelf> : null}
          {results.songs.length ? <Shelf title="Songs" kind="tracks"><TrackLockups tracks={results.songs} source={`Search: ${query}`} /></Shelf> : null}
          {results.playlists.length ? <Shelf title="Playlists" kind="square">{results.playlists.map((playlist) => <PlaylistLockup key={playlist.id} playlist={playlist} />)}</Shelf> : null}
        </>
      )}
    </>
  );
}
