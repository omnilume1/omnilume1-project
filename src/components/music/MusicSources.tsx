'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useMusicSources, type SourceSearch } from '@/hooks/useMusicSources';
import { MUSIC_MAX_SOURCES } from '@/lib/music-sources';
import { TrackList } from './MusicParts';

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Settings → Custom sources: add by manifest URL, enable/disable, health check, remove. */
export function SourcesSetting() {
  const { sources, loadError, add, check, remove, setEnabled } = useMusicSources();
  const [url, setUrl] = useState('');
  const [attest, setAttest] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run('add', async () => {
      await add(url);
      setUrl('');
      setAttest(false);
    });
  };
  const full = (sources?.length ?? 0) >= MUSIC_MAX_SOURCES;

  return (
    <section aria-labelledby="mu-sources-title">
      <h2 id="mu-sources-title" className="mu-section-title">Custom sources</h2>
      <p className="mu-muted">
        Add a source by the address of its OmniLume manifest (a JSON file with <code>&quot;omnilume&quot;: 1</code>, a <code>name</code>, a <code>search</code> URL
        containing <code>{'{query}'}</code> and an optional <code>health</code> URL). Your browser calls the source directly, so it must allow cross-origin requests.
        Songs from a source play only for you: they can’t be shared, played together, added to playlists or shown to friends. OmniLume doesn’t provide any sources.
      </p>
      <form className="mu-source-form" onSubmit={submit}>
        <input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/omnilume.json" aria-label="Source manifest address" maxLength={500} disabled={full} />
        <label className="mu-check">
          <input type="checkbox" checked={attest} onChange={(event) => setAttest(event.target.checked)} disabled={full} />
          <span>I’m responsible for what I play from this source and have the right to use it.</span>
        </label>
        <button type="submit" className="mu-pill-button is-key" disabled={!attest || !url.trim() || busy !== null || full}>{busy === 'add' ? 'Checking…' : 'Add Source'}</button>
        {full ? <p className="mu-fine">You can add up to {MUSIC_MAX_SOURCES} sources.</p> : null}
      </form>
      {error || loadError ? <p className="mu-error" role="alert">{error ?? loadError}</p> : null}
      {sources?.length ? (
        <ul className="mu-targets mu-sources" aria-label="Your sources">
          {sources.map((source) => (
            <li key={source.id}>
              <span className="mu-source-main">
                <strong>{source.name}</strong> <span className="mu-fine">{host(source.manifest_url)}</span>
                <span className={`mu-fine ${source.last_status === 'error' ? 'is-destructive' : ''}`}>
                  {source.last_status === 'error' ? `Not working: ${source.last_message ?? 'unknown error'}` : source.last_status === 'ok' ? 'Working' : 'Not checked'}
                  {source.last_checked_at ? ` · checked ${new Date(source.last_checked_at).toLocaleString()}` : ''}
                </span>
              </span>
              <span className="mu-source-actions">
                <label className="mu-check is-inline">
                  <input type="checkbox" checked={source.enabled} onChange={(event) => void run(source.id, () => setEnabled(source.id, event.target.checked))} disabled={busy !== null} />
                  <span>On</span>
                </label>
                <button type="button" className="mu-text-button" disabled={busy !== null} onClick={() => void run(source.id, () => check(source))}>{busy === source.id ? '…' : 'Check'}</button>
                <button type="button" className="mu-text-button is-destructive" disabled={busy !== null} onClick={() => { if (window.confirm(`Remove “${source.name}”?`)) void run(source.id, () => remove(source.id)); }}>Remove</button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** Search results from the user's enabled sources (render with key={query}). */
export function SourceResults({ query }: { query: string }) {
  const { sources, search } = useMusicSources();
  const [results, setResults] = useState<SourceSearch[] | null>(null);
  const enabled = sources?.filter((source) => source.enabled).length ?? 0;

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void search(query).then((next) => alive && setResults(next));
    return () => { alive = false; };
  }, [enabled, query, search]);

  if (!enabled) return null;
  const tracks = results?.flatMap((result) => result.tracks) ?? [];
  const failures = results?.filter((result) => result.error) ?? [];
  return (
    <section className="mu-section" aria-labelledby="mu-source-results">
      <h2 id="mu-source-results" className="mu-section-title">From your sources</h2>
      {results === null ? <p className="mu-muted" role="status">Searching your sources…</p> : null}
      {results && tracks.length === 0 && failures.length === 0 ? <p className="mu-muted">No matches in your sources.</p> : null}
      {tracks.length ? <TrackList tracks={tracks} source={`Your sources: ${query}`} showArt detail={(track) => track.sourceName} /> : null}
      {failures.map((failure) => <p key={failure.source.id} className="mu-error" role="alert">{failure.source.name}: {failure.error}</p>)}
    </section>
  );
}
