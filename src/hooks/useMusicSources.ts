'use client';

import { useCallback, useEffect, useState } from 'react';
import type { MusicTrack } from '@/lib/music-model';
import { fetchSource, fetchSourceJson, isSourceUrl, parseManifest, parseSearchResults, searchUrlFor } from '@/lib/music-sources';
import { createClient } from '@/utils/supabase/client';

export type CustomSource = {
  id: string; manifest_url: string; name: string; search_url: string; health_url: string | null; enabled: boolean;
  last_status: 'ok' | 'error' | null; last_message: string | null; last_checked_at: string | null;
};
export type SourceSearch = { source: CustomSource; tracks: MusicTrack[]; error?: string };

const COLUMNS = 'id, manifest_url, name, search_url, health_url, enabled, last_status, last_message, last_checked_at';
const message = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.').slice(0, 200);

/** Owner-only rows (RLS); every call to a source runs here in the browser. */
export function useMusicSources() {
  const [sources, setSources] = useState<CustomSource[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const { data, error } = await createClient().from('music_custom_sources').select(COLUMNS).order('created_at');
    if (error) setLoadError('Could not load your sources.');
    else setSources(data as CustomSource[]);
  }, []);

  useEffect(() => {
    // Initial load; state is set after the request resolves (not synchronously).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  const update = useCallback(async (id: string, patch: Partial<CustomSource>) => {
    const { error } = await createClient().from('music_custom_sources').update(patch).eq('id', id);
    if (error) throw new Error('Could not update the source.');
    await reload();
  }, [reload]);

  const add = useCallback(async (manifestUrl: string) => {
    const url = manifestUrl.trim();
    if (!isSourceUrl(url)) throw new Error('Use an https:// address (http://localhost only for local testing).');
    const manifest = parseManifest(await fetchSourceJson(url));
    if (typeof manifest === 'string') throw new Error(manifest);
    const { error } = await createClient().from('music_custom_sources').insert({
      manifest_url: url, name: manifest.name, search_url: manifest.searchUrl, health_url: manifest.healthUrl,
      responsibility_accepted: true, last_status: 'ok', last_checked_at: new Date().toISOString(),
    });
    if (error) throw new Error(error.code === '23505' ? 'This source is already added.' : error.code === '54000' ? error.message : 'Could not save the source.');
    await reload();
  }, [reload]);

  /** Re-reads the manifest (it stays the source of truth) and pings the optional health URL. */
  const check = useCallback(async (source: CustomSource) => {
    try {
      const manifest = parseManifest(await fetchSourceJson(source.manifest_url));
      if (typeof manifest === 'string') throw new Error(manifest);
      if (manifest.healthUrl) await fetchSource(manifest.healthUrl);
      await update(source.id, {
        name: manifest.name, search_url: manifest.searchUrl, health_url: manifest.healthUrl,
        last_status: 'ok', last_message: null, last_checked_at: new Date().toISOString(),
      });
    } catch (error) {
      await update(source.id, { last_status: 'error', last_message: message(error), last_checked_at: new Date().toISOString() });
    }
  }, [update]);

  const remove = useCallback(async (id: string) => {
    const { error } = await createClient().from('music_custom_sources').delete().eq('id', id);
    if (error) throw new Error('Could not remove the source.');
    await reload();
  }, [reload]);

  const search = useCallback(async (query: string): Promise<SourceSearch[]> => Promise.all(
    (sources ?? []).filter((source) => source.enabled).map(async (source) => {
      try {
        return { source, tracks: parseSearchResults(await fetchSourceJson(searchUrlFor(source.search_url, query)), source) };
      } catch (error) {
        return { source, tracks: [], error: message(error) };
      }
    }),
  ), [sources]);

  return { sources, loadError, add, check, remove, search, setEnabled: (id: string, enabled: boolean) => update(id, { enabled }) };
}
