'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { parseLyrics } from '@/lib/music-lrc';
import type { MusicAlbum, MusicPlaylist, MusicTrack } from '@/lib/music-model';
import { coverArtUrl, type TagCandidate } from '@/lib/music-metadata';
import { readMusicFile, toCover } from '@/lib/music-tags';
import {
  MUSIC_AUDIO_TYPES, MUSIC_BUCKET, MUSIC_MAX_ACTIVE_FILES, MUSIC_MAX_FILE_BYTES, MUSIC_MAX_TOTAL_BYTES,
  musicCoverPath, musicObjectPath,
} from '@/lib/music-upload-validation';
import { startUploadFileWithProgress } from '@/lib/storage';
import { createClient } from '@/utils/supabase/client';

type UploadRow = {
  id: string; title: string; artist: string; album: string; album_artist: string; year: number | null;
  duration_ms: number | null; hue: number; lyrics: string | null; cover_path: string | null; state: string;
  expires_at: string; size_bytes: number;
};
type PlaylistRow = { id: string; name: string; music_playlist_items: { upload_id: string; added_at: string }[] };
type SharedRow = {
  share_id: string; upload_id: string; target_name: string | null; owner_name: string; title: string; artist: string;
  album: string; duration_ms: number | null; hue: number; has_cover: boolean; lyrics: string | null; expires_at: string;
};
type HistoryRow = {
  id: number; upload_id: string; played_at: string; title: string; artist: string; album: string;
  duration_ms: number | null; hue: number; has_cover: boolean; owned: boolean; playable: boolean;
};

export type LibraryPlaylist = MusicPlaylist & { trackIds: string[] };
export type HistoryEntry = MusicTrack & { playedAt: string; historyId: number };
export type ShareTarget = { target_kind: 'room' | 'group'; target_id: string; name: string };
export type UploadShare = { share_id: string; target_kind: 'room' | 'group'; target_id: string; target_name: string };
export type UploadProgress = { stage: 'reading' | 'uploading' | 'saving'; percent: number };

/** Stable short id for an album derived from its tags. */
export function albumKey(artist: string, album: string) {
  let hash = 0x811c9dc5;
  for (const char of `${artist.toLowerCase()}\u0000${album.toLowerCase()}`) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return hash.toString(36);
}

const mediaUrl = (id: string, asset: 'audio' | 'cover') => `/api/music/uploads/${id}/${asset}`;

export function trackFrom(row: { id: string; title: string; artist: string; album: string; album_artist?: string; duration_ms: number | null; hue: number; lyrics?: string | null; expires_at?: string }, options: { available: boolean; hasCover: boolean; sharedFrom?: string }): MusicTrack {
  const parsed = parseLyrics(row.lyrics);
  const artist = row.artist || 'Unknown Artist';
  const album = row.album || 'Unknown Album';
  return {
    id: row.id,
    uploadId: row.id,
    title: row.title,
    artist,
    album,
    albumId: albumKey(row.album_artist || artist, album),
    durationMs: row.duration_ms ?? 0,
    hue: row.hue,
    artwork: options.available && options.hasCover ? mediaUrl(row.id, 'cover') : undefined,
    src: mediaUrl(row.id, 'audio'),
    lyrics: parsed.lines,
    lyricsSynced: parsed.synced,
    expiresAt: row.expires_at,
    available: options.available,
    sharedFrom: options.sharedFrom,
  };
}

type MusicLibrary = {
  status: 'loading' | 'ready' | 'error';
  uploads: MusicTrack[];
  songs: MusicTrack[];
  usage: { files: number; bytes: number };
  playlists: LibraryPlaylist[];
  shared: MusicTrack[];
  history: HistoryEntry[];
  albums: MusicAlbum[];
  artists: { name: string; hue: number }[];
  reload: () => Promise<void>;
  uploadFile: (file: File, lrcText: string | null, onProgress: (progress: UploadProgress) => void) => Promise<void>;
  deleteUpload: (id: string) => Promise<void>;
  createPlaylist: (name: string) => Promise<string>;
  deletePlaylist: (id: string) => Promise<void>;
  addToPlaylist: (playlistId: string, uploadId: string) => Promise<void>;
  removeFromPlaylist: (playlistId: string, uploadId: string) => Promise<void>;
  clearHistory: () => Promise<void>;
  shareTargets: () => Promise<ShareTarget[]>;
  listShares: (uploadId: string) => Promise<UploadShare[]>;
  share: (uploadId: string, target: ShareTarget) => Promise<void>;
  unshare: (shareId: string) => Promise<void>;
  shareTrack: MusicTrack | null;
  openShare: (track: MusicTrack | null) => void;
  lookupTags: (uploadId: string) => Promise<TagCandidate[]>;
  /** Resolves `artworkFailed: true` when tags were saved but the artwork could not be fetched. */
  applyTags: (track: MusicTrack, candidate: TagCandidate, withArtwork: boolean) => Promise<{ artworkFailed: boolean }>;
  fixTrack: MusicTrack | null;
  openFixTags: (track: MusicTrack | null) => void;
};

const MusicLibraryContext = createContext<MusicLibrary | null>(null);

const fail = (error: { message: string } | null, fallback: string) => {
  if (error) throw new Error(error.message || fallback);
};

export function MusicLibraryProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<MusicLibrary['status']>('loading');
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [playlistRows, setPlaylistRows] = useState<PlaylistRow[]>([]);
  const [sharedRows, setSharedRows] = useState<SharedRow[]>([]);
  const [historyRows, setHistoryRows] = useState<HistoryRow[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [shareTrack, setShareTrack] = useState<MusicTrack | null>(null);
  const [fixTrack, setFixTrack] = useState<MusicTrack | null>(null);

  const reload = useCallback(async () => {
    const supabase = createClient();
    const [uploads, playlists, shared, history] = await Promise.all([
      supabase.from('music_uploads')
        .select('id, title, artist, album, album_artist, year, duration_ms, hue, lyrics, cover_path, state, expires_at, size_bytes')
        .order('created_at', { ascending: false }).limit(500),
      supabase.from('music_playlists').select('id, name, music_playlist_items(upload_id, added_at)').order('created_at'),
      supabase.rpc('list_music_shared_with_me'),
      supabase.rpc('list_my_music_history', { p_limit: 100 }),
    ]);
    const error = uploads.error ?? playlists.error ?? shared.error ?? history.error;
    if (error) {
      setStatus('error');
      return;
    }
    setRows(uploads.data as UploadRow[]);
    setPlaylistRows(playlists.data as PlaylistRow[]);
    setSharedRows(shared.data as SharedRow[]);
    setHistoryRows(history.data as HistoryRow[]);
    setNow(Date.now());
    setStatus('ready');
  }, []);

  useEffect(() => {
    // Initial load; reload() only sets state after its requests resolve (not synchronously).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  const uploads = useMemo(
    () => rows.map((row) => trackFrom(row, {
      available: row.state === 'active' && Date.parse(row.expires_at) > now,
      hasCover: Boolean(row.cover_path),
    })),
    [rows, now],
  );
  const songs = useMemo(() => uploads.filter((track) => track.available), [uploads]);
  const byId = useMemo(() => new Map(uploads.map((track) => [track.id, track])), [uploads]);
  const usage = useMemo(() => ({
    files: rows.filter((row) => row.state === 'active' && Date.parse(row.expires_at) > now).length,
    bytes: rows.filter((row) => row.state === 'active' && Date.parse(row.expires_at) > now).reduce((sum, row) => sum + row.size_bytes, 0),
  }), [rows, now]);

  const playlists = useMemo<LibraryPlaylist[]>(() => playlistRows.map((row, i) => {
    const items = [...row.music_playlist_items].sort((a, b) => a.added_at.localeCompare(b.added_at));
    const tracks = items.map((item) => byId.get(item.upload_id)).filter((track): track is MusicTrack => Boolean(track));
    return { id: row.id, title: row.name, hue: tracks[0]?.hue ?? (200 + i * 47) % 360, tracks, trackIds: items.map((item) => item.upload_id) };
  }), [playlistRows, byId]);

  const shared = useMemo(() => {
    const seen = new Set<string>();
    return sharedRows.filter((row) => !seen.has(row.upload_id) && seen.add(row.upload_id)).map((row) => trackFrom(
      { ...row, id: row.upload_id },
      { available: true, hasCover: row.has_cover, sharedFrom: `${row.owner_name} · ${row.target_name ?? 'a room'}` },
    ));
  }, [sharedRows]);

  const history = useMemo<HistoryEntry[]>(() => historyRows.map((row) => ({
    ...trackFrom({ ...row, id: row.upload_id }, { available: row.playable, hasCover: row.has_cover, sharedFrom: row.owned ? undefined : 'Shared with you' }),
    playedAt: row.played_at,
    historyId: row.id,
  })), [historyRows]);

  const albums = useMemo<MusicAlbum[]>(() => {
    const map = new Map<string, MusicAlbum>();
    for (const track of songs) {
      const key = track.albumId!;
      const row = rows.find((candidate) => candidate.id === track.id);
      const album = map.get(key) ?? { id: key, title: track.album, artist: row?.album_artist || track.artist, year: row?.year, hue: track.hue, artwork: track.artwork, tracks: [] };
      album.tracks.push(track);
      album.artwork ??= track.artwork;
      map.set(key, album);
    }
    return [...map.values()];
  }, [songs, rows]);

  const artists = useMemo(() => {
    const map = new Map<string, number>();
    for (const track of songs) if (!map.has(track.artist)) map.set(track.artist, track.hue);
    return [...map].map(([name, hue]) => ({ name, hue })).sort((a, b) => a.name.localeCompare(b.name));
  }, [songs]);

  const uploadFile = useCallback<MusicLibrary['uploadFile']>(async (file, lrcText, onProgress) => {
    if (file.size > MUSIC_MAX_FILE_BYTES) throw new Error('Files can be up to 500 MB.');
    if (usage.files >= MUSIC_MAX_ACTIVE_FILES) throw new Error('You can keep up to 40 uploads at a time.');
    if (usage.bytes + file.size > MUSIC_MAX_TOTAL_BYTES) throw new Error('Uploads are limited to 500 MB in total.');
    onProgress({ stage: 'reading', percent: 0 });
    const info = await readMusicFile(file);
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('Your session has expired. Please sign in again.');
    const uploadId = crypto.randomUUID();

    await startUploadFileWithProgress(
      supabase, MUSIC_BUCKET, musicObjectPath(user.id, uploadId, info.ext), file,
      (progress) => onProgress({ stage: 'uploading', percent: progress.percent }), MUSIC_AUDIO_TYPES[info.ext],
    ).promise;
    if (info.cover) {
      await startUploadFileWithProgress(supabase, MUSIC_BUCKET, musicCoverPath(user.id, uploadId), info.cover, undefined, 'image/jpeg').promise;
    }
    onProgress({ stage: 'saving', percent: 100 });
    const response = await fetch('/api/music/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadId, ext: info.ext, originalName: file.name, title: info.title, artist: info.artist, album: info.album,
        albumArtist: info.albumArtist, trackNo: info.trackNo, year: info.year, genre: info.genre, durationMs: info.durationMs,
        hue: info.hue, lyrics: lrcText ?? info.lyrics, hasCover: Boolean(info.cover),
      }),
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new Error(body.error ?? 'Could not save the upload.');
  }, [usage]);

  const deleteUpload = useCallback(async (id: string) => {
    const response = await fetch(`/api/music/uploads/${id}`, { method: 'DELETE' });
    if (response.status >= 400) throw new Error('Could not delete this upload.');
    await reload();
  }, [reload]);

  const createPlaylist = useCallback(async (name: string) => {
    const { data, error } = await createClient().from('music_playlists').insert({ name: name.trim().slice(0, 100) }).select('id').single();
    fail(error, 'Could not create the playlist.');
    await reload();
    return (data as { id: string }).id;
  }, [reload]);

  const deletePlaylist = useCallback(async (id: string) => {
    const { error } = await createClient().from('music_playlists').delete().eq('id', id);
    fail(error, 'Could not delete the playlist.');
    await reload();
  }, [reload]);

  const addToPlaylist = useCallback(async (playlistId: string, uploadId: string) => {
    const { error } = await createClient().from('music_playlist_items').insert({ playlist_id: playlistId, upload_id: uploadId });
    if (error && error.code !== '23505') fail(error, 'Could not add the song.');
    await reload();
  }, [reload]);

  const removeFromPlaylist = useCallback(async (playlistId: string, uploadId: string) => {
    const { error } = await createClient().from('music_playlist_items').delete().eq('playlist_id', playlistId).eq('upload_id', uploadId);
    fail(error, 'Could not remove the song.');
    await reload();
  }, [reload]);

  const clearHistory = useCallback(async () => {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { error } = await supabase.from('music_listening_history').delete().eq('user_id', user.id);
    fail(error, 'Could not clear your history.');
    await reload();
  }, [reload]);

  const shareTargets = useCallback(async () => {
    const { data, error } = await createClient().rpc('list_music_share_targets');
    fail(error, 'Could not load your rooms and groups.');
    return (data ?? []) as ShareTarget[];
  }, []);

  const listShares = useCallback(async (uploadId: string) => {
    const { data, error } = await createClient().rpc('list_music_shares', { p_upload_id: uploadId });
    fail(error, 'Could not load the shares.');
    return (data ?? []) as UploadShare[];
  }, []);

  const share = useCallback(async (uploadId: string, target: ShareTarget) => {
    // The dialog only calls this after the "I have the right to share" box is ticked.
    const { error } = await createClient().rpc('share_music_upload', {
      p_upload_id: uploadId, p_target_kind: target.target_kind, p_target_id: target.target_id, p_attest: true,
    });
    fail(error, 'Could not share the song.');
  }, []);

  const unshare = useCallback(async (shareId: string) => {
    const { error } = await createClient().rpc('unshare_music_upload', { p_share_id: shareId });
    fail(error, 'Could not stop sharing.');
  }, []);

  const lookupTags = useCallback(async (uploadId: string) => {
    const response = await fetch(`/api/music/metadata?upload=${uploadId}`);
    const body = (await response.json().catch(() => ({}))) as { candidates?: TagCandidate[]; error?: string };
    if (!response.ok) throw new Error(body.error ?? 'Could not look up tags.');
    return body.candidates ?? [];
  }, []);

  const applyTags = useCallback<MusicLibrary['applyTags']>(async (track, candidate, withArtwork) => {
    const supabase = createClient();
    let addCover = false;
    let artworkFailed = false;
    const art = withArtwork && !track.artwork && candidate.releaseId ? coverArtUrl(candidate.releaseId, 500) : null;
    if (art) {
      try {
        // Browser fetch from the fixed Cover Art Archive host, re-encoded like embedded art (≤ 1200 px JPEG, no EXIF).
        const response = await fetch(art, { credentials: 'omit', referrerPolicy: 'no-referrer' });
        if (!response.ok) throw new Error('artwork');
        const cover = await toCover(await response.blob(), track.hue);
        const { data: { user } } = await supabase.auth.getUser();
        if (!cover?.blob || !user) throw new Error('artwork');
        await startUploadFileWithProgress(supabase, MUSIC_BUCKET, musicCoverPath(user.id, track.id), cover.blob, undefined, 'image/jpeg').promise
          .catch((error: unknown) => {
            // A cover left by an earlier attempt is reused; anything else is a real failure.
            if (!/exist|duplicate/i.test(error instanceof Error ? error.message : '')) throw error;
          });
        addCover = true;
      } catch {
        artworkFailed = true;
      }
    }
    const { error } = await supabase.rpc('update_music_upload_tags', {
      p_upload_id: track.id, p_title: candidate.title, p_artist: candidate.artist || null, p_album: candidate.album || null,
      p_album_artist: null, p_track_no: candidate.trackNo, p_year: candidate.year, p_add_cover: addCover,
    });
    fail(error, 'Could not save the tags.');
    await reload();
    return { artworkFailed };
  }, [reload]);

  const value = useMemo<MusicLibrary>(() => ({
    status, uploads, songs, usage, playlists, shared, history, albums, artists, reload, uploadFile, deleteUpload,
    createPlaylist, deletePlaylist, addToPlaylist, removeFromPlaylist, clearHistory, shareTargets, listShares, share,
    unshare, shareTrack, openShare: setShareTrack, lookupTags, applyTags, fixTrack, openFixTags: setFixTrack,
  }), [status, uploads, songs, usage, playlists, shared, history, albums, artists, reload, uploadFile, deleteUpload,
    createPlaylist, deletePlaylist, addToPlaylist, removeFromPlaylist, clearHistory, shareTargets, listShares, share, unshare, shareTrack,
    lookupTags, applyTags, fixTrack]);

  return <MusicLibraryContext.Provider value={value}>{children}</MusicLibraryContext.Provider>;
}

export function useMusicLibrary() {
  const library = useContext(MusicLibraryContext);
  if (!library) throw new Error('useMusicLibrary must be used inside MusicLibraryProvider');
  return library;
}
