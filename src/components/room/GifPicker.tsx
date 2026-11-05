'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { searchGifs, type GifResult } from '@/actions/gifs';

// GIPHY picker for room chat. Results come from the server action (the API
// key never reaches the browser); choosing a GIF hands its id and title back
// to the chat, which sends it as a [gif:<id>] message.

export default function GifPicker({ onSelect, onClose }: { onSelect: (gif: GifResult) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState<GifResult[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const run = useCallback(async (term: string, offset: number) => {
    const request = ++requestRef.current;
    setLoading(true);
    const result = await searchGifs(term, offset);
    if (request !== requestRef.current) return;
    setLoading(false);
    if (!result.success) { setError(result.error); return; }
    setError(null);
    setGifs((current) => (offset === 0 ? result.gifs : [...current, ...result.gifs.filter((gif) => !current.some((item) => item.id === gif.id))]));
    setNextOffset(result.nextOffset);
  }, []);

  // Debounced search; an empty query shows trending GIFs.
  useEffect(() => {
    const timeout = window.setTimeout(() => { void run(query, 0); }, query ? 350 : 0);
    return () => window.clearTimeout(timeout);
  }, [query, run]);

  useEffect(() => {
    inputRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (panelRef.current && event.target instanceof Node && !panelRef.current.contains(event.target)) onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Choose a GIF"
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}
      className="absolute bottom-full left-0 right-0 z-40 mb-2 flex max-h-[26rem] flex-col overflow-hidden rounded-2xl border border-neutral-800 bg-[#111] shadow-2xl"
    >
      <div className="flex items-center gap-2 border-b border-neutral-800 p-2">
        <input
          ref={inputRef}
          type="search"
          value={query}
          maxLength={50}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search GIPHY"
          aria-label="Search GIFs"
          className="omni-input !min-h-0 !py-2 text-sm"
        />
        <button type="button" onClick={onClose} aria-label="Close GIF picker" className="rounded-lg px-2 py-1 text-neutral-400 hover:bg-neutral-800 hover:text-white">✕</button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2" aria-busy={loading}>
        {error ? (
          <p role="alert" className="px-2 py-6 text-center text-xs text-amber-300">{error}</p>
        ) : gifs.length === 0 && !loading ? (
          <p className="px-2 py-6 text-center text-xs text-neutral-500">No GIFs found.</p>
        ) : (
          <div className="columns-2 gap-2 sm:columns-3">
            {gifs.map((gif) => (
              <button
                key={gif.id}
                type="button"
                onClick={() => onSelect(gif)}
                title={gif.title || 'GIF'}
                className="mb-2 block w-full overflow-hidden rounded-lg bg-neutral-900 ring-indigo-500 transition hover:opacity-90 focus-visible:ring-2"
                style={{ aspectRatio: `${gif.width} / ${gif.height}` }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- animated third-party GIF; next/image would re-encode it */}
                <img src={gif.previewUrl} alt={gif.title || 'GIF'} loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
              </button>
            ))}
          </div>
        )}
        {loading && <p className="py-3 text-center text-xs text-neutral-500">Loading GIFs…</p>}
        {!loading && !error && nextOffset !== null && (
          <button type="button" onClick={() => void run(query, nextOffset)} className="mx-auto mt-1 block rounded-lg border border-neutral-800 px-3 py-1.5 text-[11px] font-bold text-neutral-300 hover:border-neutral-600">Load more</button>
        )}
      </div>
      <p className="border-t border-neutral-800 px-3 py-1.5 text-right text-[10px] font-bold uppercase tracking-wider text-neutral-500">Powered by GIPHY</p>
    </div>
  );
}
