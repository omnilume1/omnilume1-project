'use client';

import { useState } from 'react';
import { OmniIcon } from '@/components/ui/OmniIcon';
import { MEDIA_SEARCH_SOURCES, type MediaSearchResult, type MediaSearchSource } from '@/lib/media-search';
import { searchMedia, type LinkOutcome } from '@/lib/watch-links';

const SOURCE_LABEL: Record<MediaSearchSource, string> = { youtube: 'YouTube', twitch: 'Twitch' };
const PLACEHOLDER: Record<MediaSearchSource, string> = { youtube: 'Search YouTube videos', twitch: 'Search Twitch channels' };

interface WatchSearchPanelProps {
  onPlay: (result: MediaSearchResult) => Promise<LinkOutcome>;
  onQueue: (result: MediaSearchResult, place: 'next' | 'last') => Promise<LinkOutcome>;
  onClose: () => void;
}

// Search YouTube and Twitch from the room, then play a result now, next, or
// at the end of the queue. Shown to Watch controllers, who can add links.
export default function WatchSearchPanel({ onPlay, onQueue, onClose }: WatchSearchPanelProps) {
  const [source, setSource] = useState<MediaSearchSource>('youtube');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MediaSearchResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (next: MediaSearchSource = source) => {
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    const found = await searchMedia(next, q);
    setLoading(false);
    if (found.ok) setResults(found.results);
    else { setResults(null); setError(found.error); }
  };

  const pickSource = (next: MediaSearchSource) => {
    setSource(next);
    setResults(null);
    if (query.trim()) void run(next);
  };

  const act = async (key: string, work: () => Promise<LinkOutcome>, done: string) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    const result = await work();
    setBusy(null);
    if (result.ok) setNotice(done);
    else setError(result.error);
  };

  return (
    <section className="watch-panel" aria-label="Search videos and streams">
      <header className="watch-panel-header">
        <div role="tablist" aria-label="Search on" className="watch-panel-tabs">
          {MEDIA_SEARCH_SOURCES.map((id) => (
            <button key={id} type="button" role="tab" aria-selected={source === id} onClick={() => pickSource(id)}>{SOURCE_LABEL[id]}</button>
          ))}
        </div>
        <button type="button" onClick={onClose} className="watch-panel-close" aria-label="Close search"><OmniIcon name="close" size={13} /></button>
      </header>

      <form className="watch-panel-link-form watch-search-form" onSubmit={(event) => { event.preventDefault(); void run(); }}>
        <label className="sr-only" htmlFor="watch-search-query">{PLACEHOLDER[source]}</label>
        <input id="watch-search-query" className="omni-input" type="search" value={query} maxLength={100} onChange={(event) => setQuery(event.target.value)} placeholder={PLACEHOLDER[source]} autoFocus />
        <button type="submit" className="omni-button omni-button-primary omni-button-sm" disabled={loading || !query.trim()}>{loading ? 'Searching…' : 'Search'}</button>
      </form>

      {error && <p role="alert" className="watch-panel-error">{error}</p>}
      {notice && <p role="status" className="watch-panel-progress">{notice}</p>}

      <div className="watch-panel-body">
        {loading ? (
          <div className="watch-panel-skeleton" aria-busy="true" aria-label="Searching" />
        ) : results === null ? (
          <div className="watch-panel-empty"><p>Find something to watch together.</p><p className="watch-panel-hint">{source === 'youtube' ? 'Search for any video, then play it now or add it to the queue.' : 'Search for a streamer. Live channels come first.'}</p></div>
        ) : results.length === 0 ? (
          <div className="watch-panel-empty"><p>Nothing found for “{query.trim()}”.</p></div>
        ) : (
          <ul className="watch-panel-list">
            {results.map((result) => (
              <li key={`${result.source}:${result.id}`} className="watch-search-row">
                {result.thumbnail
                  // eslint-disable-next-line @next/next/no-img-element -- remote provider thumbnails at their own size; next/image would need every provider host configured
                  ? <img src={result.thumbnail} alt="" className={`watch-search-thumb${result.source === 'twitch' ? ' is-avatar' : ''}`} loading="lazy" referrerPolicy="no-referrer" />
                  : <span className="watch-search-thumb" aria-hidden="true" />}
                <span className="min-w-0 flex-1">
                  <span className="watch-panel-title" title={result.title}>{result.title}</span>
                  <span className="watch-panel-meta">{result.live && <b className="watch-search-live">Live</b>}{result.channel}</span>
                  <span className="watch-search-actions">
                    <button type="button" className="omni-button omni-button-primary omni-button-sm" disabled={busy !== null} onClick={() => void act(`play:${result.id}`, () => onPlay(result), 'Playing now.')}>{busy === `play:${result.id}` ? 'Starting…' : 'Play now'}</button>
                    <button type="button" className="omni-button omni-button-ghost omni-button-sm" disabled={busy !== null} onClick={() => void act(`next:${result.id}`, () => onQueue(result, 'next'), 'Plays next.')}>Play next</button>
                    <button type="button" className="omni-button omni-button-ghost omni-button-sm" disabled={busy !== null} onClick={() => void act(`last:${result.id}`, () => onQueue(result, 'last'), 'Added to the end of the queue.')}>Add to queue</button>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
