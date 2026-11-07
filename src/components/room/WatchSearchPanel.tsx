'use client';

import { useState } from 'react';
import { OmniIcon } from '@/components/ui/OmniIcon';
import { MEDIA_SEARCH_SOURCES, SOURCE_NAME, SOURCE_SITE, type MediaSearchResult, type MediaSearchSource } from '@/lib/media-search';
import { searchMedia, type LinkOutcome } from '@/lib/watch-links';

export type SearchTab = 'all' | MediaSearchSource;
const TABS: SearchTab[] = ['all', ...MEDIA_SEARCH_SOURCES];
const TAB_LABEL: Record<SearchTab, string> = { all: 'All', youtube: 'YouTube', twitch: 'Twitch', archive: 'Archive', vimeo: 'Vimeo' };
const PLACEHOLDER: Record<SearchTab, string> = {
  all: 'Search everywhere',
  youtube: 'Search YouTube videos',
  twitch: 'Search Twitch channels',
  archive: 'Search free films on the Internet Archive',
  vimeo: 'Search Vimeo videos',
};
const HINT: Record<SearchTab, string> = {
  all: 'Searches YouTube, Twitch, the Internet Archive and Vimeo at once.',
  youtube: 'Search for any video.',
  twitch: 'Search for a streamer. Live channels come first.',
  archive: 'Old films, cartoons and shows that are free to watch.',
  vimeo: 'Videos their owners let anyone embed.',
};

// Round-robin so one source does not fill the whole list.
function interleave(lists: MediaSearchResult[][]) {
  const out: MediaSearchResult[] = [];
  for (let i = 0; lists.some((list) => i < list.length); i++) for (const list of lists) if (i < list.length) out.push(list[i]);
  return out;
}

interface WatchSearchPanelProps {
  initialTab?: SearchTab;
  // Something is on the stage: a click then asks Play next or Add to queue
  // instead of replacing what everyone is watching.
  hasMedia: boolean;
  onPlay: (result: MediaSearchResult) => Promise<LinkOutcome>;
  onQueue: (result: MediaSearchResult, place: 'next' | 'last') => Promise<LinkOutcome>;
  onClose: () => void;
}

// Search YouTube, Twitch, the Internet Archive and Vimeo from the room. With
// nothing playing, clicking a result casts it; otherwise it offers Play next
// or Add to queue. Shown to Watch controllers, who can add links.
export default function WatchSearchPanel({ initialTab = 'all', hasMedia, onPlay, onQueue, onClose }: WatchSearchPanelProps) {
  const [tab, setTab] = useState<SearchTab>(initialTab);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MediaSearchResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ text: string; site?: MediaSearchSource } | null>(null);
  const [skipped, setSkipped] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<string | null>(null);

  const run = async (next: SearchTab = tab) => {
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    setSkipped(null);
    setNotice(null);
    setChoosing(null);
    if (next === 'all') {
      const found = await Promise.all(MEDIA_SEARCH_SOURCES.map((source) => searchMedia(source, q)));
      setLoading(false);
      const ok = found.flatMap((item) => (item.ok ? [item.results] : []));
      const failed = MEDIA_SEARCH_SOURCES.filter((_, i) => !found[i].ok).map((source) => SOURCE_NAME[source]);
      if (ok.length === 0) {
        setResults(null);
        const first = found.find((item) => !item.ok);
        setError({ text: first && !first.ok ? first.error : 'Search did not work. Try again.' });
        return;
      }
      setResults(interleave(ok));
      if (failed.length) setSkipped(`Not included right now: ${failed.join(', ')}.`);
      return;
    }
    const found = await searchMedia(next, q);
    setLoading(false);
    if (found.ok) setResults(found.results);
    else { setResults(null); setError({ text: found.error, site: next }); }
  };

  const pickTab = (next: SearchTab) => {
    setTab(next);
    setResults(null);
    setError(null);
    setSkipped(null);
    if (query.trim()) void run(next);
  };

  const act = async (key: string, work: () => Promise<LinkOutcome>, done: string) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    const result = await work();
    setBusy(null);
    setChoosing(null);
    if (result.ok) setNotice(done);
    else setError({ text: result.error });
  };

  return (
    <section className="watch-panel" aria-label="Search videos and streams">
      <header className="watch-panel-header">
        <div role="tablist" aria-label="Search on" className="watch-panel-tabs watch-search-tabs">
          {TABS.map((id) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => pickTab(id)}>{TAB_LABEL[id]}</button>
          ))}
        </div>
        <button type="button" onClick={onClose} className="watch-panel-close" aria-label="Close search"><OmniIcon name="close" size={13} /></button>
      </header>

      <form className="watch-panel-link-form watch-search-form" onSubmit={(event) => { event.preventDefault(); void run(); }}>
        <label className="sr-only" htmlFor="watch-search-query">{PLACEHOLDER[tab]}</label>
        <input id="watch-search-query" className="omni-input" type="search" value={query} maxLength={100} onChange={(event) => setQuery(event.target.value)} placeholder={PLACEHOLDER[tab]} autoFocus />
        <button type="submit" className="omni-button omni-button-primary omni-button-sm" disabled={loading || !query.trim()}>{loading ? 'Searching…' : 'Search'}</button>
      </form>

      {error && (
        <p role="alert" className="watch-panel-error">
          {error.text}
          {error.site && <> <a href={SOURCE_SITE[error.site]} target="_blank" rel="noopener noreferrer" className="watch-search-site">Open {SOURCE_NAME[error.site]} in a new tab</a></>}
        </p>
      )}
      {skipped && <p role="status" className="watch-panel-hint watch-search-skipped">{skipped}</p>}
      {notice && <p role="status" className="watch-panel-progress">{notice}</p>}

      <div className="watch-panel-body">
        {loading ? (
          <div className="watch-panel-skeleton" aria-busy="true" aria-label="Searching" />
        ) : results === null ? (
          <div className="watch-panel-empty"><p>Find something to watch together.</p><p className="watch-panel-hint">{HINT[tab]} {hasMedia ? 'Click a result to play it next or add it to the queue.' : 'Click a result to play it for everyone.'}</p></div>
        ) : results.length === 0 ? (
          <div className="watch-panel-empty"><p>Nothing found for “{query.trim()}”.</p></div>
        ) : (
          <ul className="watch-panel-list">
            {results.map((result) => {
              const key = `${result.source}:${result.id}`;
              const open = choosing === key;
              return (
                <li key={key} className={`watch-search-row${open ? ' is-choosing' : ''}`}>
                  <button
                    type="button"
                    className="watch-search-pick"
                    disabled={busy !== null}
                    aria-expanded={hasMedia ? open : undefined}
                    onClick={() => (hasMedia ? setChoosing(open ? null : key) : void act(`play:${key}`, () => onPlay(result), 'Playing now.'))}
                  >
                    {result.thumbnail
                      // eslint-disable-next-line @next/next/no-img-element -- remote provider thumbnails at their own size; next/image would need every provider host configured
                      ? <img src={result.thumbnail} alt="" className={`watch-search-thumb${result.source === 'twitch' ? ' is-avatar' : ''}`} loading="lazy" referrerPolicy="no-referrer" />
                      : <span className="watch-search-thumb" aria-hidden="true" />}
                    <span className="min-w-0 flex-1">
                      <span className="watch-panel-title" title={result.title}>{result.title}</span>
                      <span className="watch-panel-meta">
                        {result.live && <b className="watch-search-live">Live</b>}
                        {tab === 'all' && <span className="watch-search-source">{SOURCE_NAME[result.source]}</span>}
                        {result.channel}
                      </span>
                      <span className="watch-search-cta">{busy === `play:${key}` ? 'Starting…' : hasMedia ? (open ? 'Choose below' : 'Click to add') : 'Click to play'}</span>
                    </span>
                  </button>
                  {open && (
                    <span className="watch-search-actions" role="group" aria-label={`Add ${result.title}`}>
                      <button type="button" className="omni-button omni-button-primary omni-button-sm" disabled={busy !== null} onClick={() => void act(`next:${key}`, () => onQueue(result, 'next'), 'Plays next.')}>Play next</button>
                      <button type="button" className="omni-button omni-button-ghost omni-button-sm" disabled={busy !== null} onClick={() => void act(`last:${key}`, () => onQueue(result, 'last'), 'Added to the end of the queue.')}>Add to queue</button>
                      <button type="button" className="omni-button omni-button-ghost omni-button-sm" disabled={busy !== null} onClick={() => void act(`play:${key}`, () => onPlay(result), 'Playing now.')}>Play now</button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
