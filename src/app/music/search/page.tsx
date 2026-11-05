import Form from 'next/form';
import { MusicIcon } from '@/components/music/MusicIcon';
import { PageTitle } from '@/components/music/MusicParts';
import { SourceResults } from '@/components/music/MusicSources';
import { SearchResults } from '@/components/music/MusicViews';

export default async function MusicSearchPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const raw = (await searchParams).q;
  const query = (Array.isArray(raw) ? raw[0] : raw ?? '').trim().slice(0, 100);

  return (
    <>
      <div className="mu-scope-bar">
        <Form action="/music/search" className="mu-search is-wide" role="search">
          <MusicIcon name="search" size={16} />
          <input name="q" type="search" defaultValue={query} placeholder="Songs, albums, artists, playlists" aria-label="Search music" maxLength={100} data-music-search />
        </Form>
      </div>
      {query ? (
        <>
          <SearchResults query={query} />
          <SourceResults key={query} query={query} />
        </>
      ) : (
        <>
          <PageTitle>Search</PageTitle>
          <p className="mu-muted mu-section">Search your uploads, playlists, songs shared with you and your custom sources.</p>
        </>
      )}
    </>
  );
}
