'use client';

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import dynamic from 'next/dynamic';
import { getActiveTemporaryMedia, logCastHistory, logTemporaryMedia, getSignedStorageUrl } from '@/actions/media';
import type { RoomSyncValue } from '@/hooks/useRoomSync';
import { uploadFileWithProgress } from '@/lib/storage';
import { createClient } from '@/utils/supabase/client';

const Player = dynamic(() => import('react-player').then((module) => module.default), { ssr: false });

interface MediaStageProps {
  roomId: string;
  currentUserRole: string | null;
  sync: RoomSyncValue;
}

interface AudioTrackLike {
  language?: string;
  label?: string;
  enabled: boolean;
}

interface AudioTrackListLike {
  length: number;
  [index: number]: AudioTrackLike;
}

interface HTMLVideoElementWithAudioTracks extends HTMLVideoElement {
  audioTracks?: AudioTrackListLike;
}

interface TemporaryMedia {
  id: string;
  file_name: string;
  file_url: string;
  media_type: string;
  expires_at: string;
  created_at: string;
}

interface LocalUploadState {
  fileName: string;
  total: number;
  loaded: number;
  percent: number;
  phase: 'uploading' | 'saving';
}

function formatBytes(bytes: number) {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(bytes >= 10 * 1_024 * 1_024 ? 0 : 1)} MB`;
}

function formatHoursUntil(expiresAt: string) {
  const hours = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 3_600_000));
  return `${hours}h left`;
}

function normalizeCastUrl(value: string) {
  const trimmed = value.trim();
  const youtubeMatch = trimmed.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|live\/|shorts\/))([\w-]{11})/i);
  if (youtubeMatch?.[1]) {
    return {
      url: `https://www.youtube.com/watch?v=${youtubeMatch[1]}`,
      title: 'YouTube video',
    };
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(withProtocol);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Please enter an HTTP or HTTPS media URL.');
  return {
    url: parsed.toString(),
    title: parsed.hostname.replace(/^www\./i, '') || 'Web stream',
  };
}

export default function MediaStage({ roomId, currentUserRole, sync }: MediaStageProps) {
  const {
    mediaState,
    broadcastEvent,
    connectionState,
    recordMediaTime,
  } = sync;

  const playerRef = useRef<HTMLVideoElementWithAudioTracks>(null);
  const subtitleFileRef = useRef<HTMLInputElement>(null);
  const localFileRef = useRef<HTMLInputElement>(null);
  const isSyncing = useRef(false);
  const previousCastIdRef = useRef<string | null>(null);
  const readyCastIdRef = useRef<string | null>(null);
  const lastRecordedTimeRef = useRef(0);

  const [castInput, setCastInput] = useState('');
  const [isCastingUrl, setIsCastingUrl] = useState(false);
  const [isUploadingSub, setIsUploadingSub] = useState(false);
  const [readyCastId, setReadyCastId] = useState<string | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [errorUrl, setErrorUrl] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [localUpload, setLocalUpload] = useState<LocalUploadState | null>(null);

  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'subtitles' | 'audio'>('subtitles');
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [subSize, setSubSize] = useState('100%');
  const [subColor, setSubColor] = useState('#ffffff');
  const [subBg, setSubBg] = useState('rgba(0, 0, 0, 0.75)');
  const [audioTracks, setAudioTracks] = useState<Array<{ id: number; label: string }>>([]);
  const [activeAudioIndex, setActiveAudioIndex] = useState(0);

  const [history, setHistory] = useState<TemporaryMedia[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const supabase = createClient();
  const canCast = currentUserRole === 'owner' || currentUserRole === 'admin';
  const activeMediaUrl = mediaState?.url ?? null;
  const activeSubtitleUrl = mediaState?.subtitleUrl ?? null;
  const mediaTitle = mediaState?.title ?? 'External Stream';
  const activeMediaId = mediaState?.mediaId;
  const activeSourceType = mediaState?.sourceType;
  const activeCastId = mediaState?.castId ?? activeMediaUrl;
  const playing = mediaState?.playing ?? false;
  const playbackSpeed = mediaState?.speed ?? 1;
  const isReady = activeMediaUrl !== null && readyCastId === activeCastId;
  const playerKey = activeMediaUrl && activeCastId ? `${activeCastId}:${retryNonce}` : 'empty';
  const displayedPlayerError = errorUrl === activeMediaUrl ? playerError : null;

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    const result = await getActiveTemporaryMedia(roomId);
    if (result.success && result.media) {
      setHistory(result.media as TemporaryMedia[]);
      setHistoryError(null);
    } else {
      setHistoryError(result.error ?? 'Unable to load cast history.');
    }
    setHistoryLoading(false);
  }, [roomId]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadHistory(), 0);
    const refresh = window.setInterval(() => void loadHistory(), 60_000);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(refresh);
    };
  }, [loadHistory]);

  useEffect(() => {
    if (previousCastIdRef.current === activeCastId) return;
    previousCastIdRef.current = activeCastId;
    readyCastIdRef.current = null;
    setReadyCastId(null);
    setAudioTracks([]);
    setActiveAudioIndex(0);
  }, [activeCastId]);

  const safeGetTime = () => {
    return playerRef.current?.currentTime ?? 0;
  };

  const safeSeekTo = (time: number) => {
    if (playerRef.current) playerRef.current.currentTime = time;
  };

  useEffect(() => {
    if (!mediaState || !isReady) return;
    isSyncing.current = true;
    const targetTime = mediaState.time || 0;
    if (Math.abs(safeGetTime() - targetTime) > 2) safeSeekTo(targetTime);

    const timeout = window.setTimeout(() => { isSyncing.current = false; }, 1_000);
    return () => window.clearTimeout(timeout);
  }, [isReady, mediaState]);

  useEffect(() => {
    if (!canCast) broadcastEvent('request_sync');
  }, [broadcastEvent, canCast]);

  const forceSyncToRoom = useCallback(() => {
    if (!canCast || !activeMediaUrl) return;
    broadcastEvent('force_sync', {
      url: activeMediaUrl,
      subtitleUrl: activeSubtitleUrl,
      title: mediaTitle,
      time: safeGetTime(),
      speed: playbackSpeed,
      playing,
      sourceType: activeSourceType,
      castId: activeCastId,
      mediaId: activeMediaId,
    });
  }, [activeCastId, activeMediaId, activeMediaUrl, activeSourceType, activeSubtitleUrl, broadcastEvent, canCast, mediaTitle, playbackSpeed, playing]);

  const broadcastPlayback = (eventType: 'play' | 'pause' | 'seek', time = safeGetTime(), nextPlaying = playing, nextSpeed = playbackSpeed) => {
    if (!canCast) return;
    broadcastEvent(eventType, {
      url: activeMediaUrl,
      title: mediaTitle,
      time,
      speed: nextSpeed,
      playing: nextPlaying,
      sourceType: activeSourceType,
      castId: activeCastId,
      mediaId: activeMediaId,
    });
  };

  const handlePlay = () => {
    if (!isSyncing.current) broadcastPlayback('play', safeGetTime(), true);
  };

  const handlePause = () => {
    if (!isSyncing.current) broadcastPlayback('pause', safeGetTime(), false);
  };

  const handleReady = () => {
    if (!activeCastId || readyCastIdRef.current === activeCastId) return;
    readyCastIdRef.current = activeCastId;
    setReadyCastId(activeCastId);
    if (mediaState?.time !== undefined) safeSeekTo(mediaState.time);

    const tracks = playerRef.current?.audioTracks;
    if (!tracks) return;
    const foundTracks: Array<{ id: number; label: string }> = [];
    for (let index = 0; index < tracks.length; index += 1) {
      const track = tracks[index];
      foundTracks.push({ id: index, label: track.label || track.language || `Audio track ${index + 1}` });
    }
    setAudioTracks(foundTracks);
  };

  const handleTimeUpdate = () => {
    const now = Date.now();
    if (now - lastRecordedTimeRef.current < 500) return;
    lastRecordedTimeRef.current = now;
    recordMediaTime(safeGetTime());
  };

  const changeAudioTrack = (index: number) => {
    const tracks = playerRef.current?.audioTracks;
    if (!tracks) return;
    // audioTracks is a browser-owned media API; changing enabled is how the
    // active native track is selected.
    for (let trackIndex = 0; trackIndex < tracks.length; trackIndex += 1) {
      // eslint-disable-next-line react-hooks/immutability
      tracks[trackIndex].enabled = trackIndex === index;
    }
    setActiveAudioIndex(index);
  };

  const changePlaybackSpeed = (speed: number) => {
    if (!canCast) return;
    broadcastPlayback('play', safeGetTime(), playing, speed);
  };

  const startUrlCasting = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!castInput.trim() || !canCast || isCastingUrl) return;

    let cast;
    try {
      cast = normalizeCastUrl(castInput);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : 'Invalid media URL.');
      return;
    }

    setPlayerError(null);
    setErrorUrl(null);
    readyCastIdRef.current = null;
    setReadyCastId(null);
    setCastInput('');
    broadcastEvent('cast', { url: cast.url, title: cast.title, speed: 1, playing: true, sourceType: 'url' });

    // Casting remains immediate even if history persistence is slow or the
    // history table is temporarily unavailable.
    setIsCastingUrl(true);
    try {
      const result = await logCastHistory(roomId, cast.title, cast.url);
      if (!result.success) setHistoryError(result.error ?? 'The cast started, but history could not be saved.');
      else await loadHistory();
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : 'The cast started, but history could not be saved.');
    } finally {
      setIsCastingUrl(false);
    }
  };

  const castHistoryItem = async (item: TemporaryMedia) => {
    if (!canCast) return;
    setPlayerError(null);
    setErrorUrl(null);
    readyCastIdRef.current = null;
    setReadyCastId(null);

    // Check if this is a URL cast (external URL) or file path (needs signed URL)
    let castUrl = item.file_url;
    if (!item.file_url.startsWith('http')) {
      // This is a file path, generate signed URL
      const result = await getSignedStorageUrl(item.file_url, roomId);
      if (!result.success || !result.url) {
        setPlayerError(result.error ?? 'Unable to generate playback URL.');
        return;
      }
      castUrl = result.url;
    }

    broadcastEvent('cast', {
      url: castUrl,
      title: item.file_name,
      sourceType: item.media_type === 'url' ? 'url' : 'upload',
      mediaId: item.id,
      speed: 1,
      playing: true,
    });
    setShowHistory(false);
  };

  const startSubtitleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !canCast) return;

    setIsUploadingSub(true);
    try {
      const extension = file.name.split('.').pop() || 'vtt';
      const filePath = `${roomId}/sub-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`;
      const { error } = await supabase.storage.from('room_attachments').upload(filePath, file, { cacheControl: '3600' });
      if (error) throw error;
      // Generate signed URL for subtitle (private storage)
      const result = await getSignedStorageUrl(filePath, roomId);
      if (!result.success || !result.url) throw new Error(result.error ?? 'Unable to generate subtitle URL.');
      broadcastEvent('subtitle_upload', { subtitleUrl: result.url });
    } catch (error) {
      alert(`Subtitle upload failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsUploadingSub(false);
      if (subtitleFileRef.current) subtitleFileRef.current.value = '';
    }
  };

  const handleLocalFileUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !canCast || localUpload) return;

    if (file.size > 50 * 1024 * 1024) {
      setHistoryError('Files are capped at 50MB.');
      if (localFileRef.current) localFileRef.current.value = '';
      return;
    }

    setHistoryError(null);
    setLocalUpload({ fileName: file.name, total: file.size, loaded: 0, percent: 0, phase: 'uploading' });

    try {
      const extension = file.name.split('.').pop()?.replace(/[^a-z0-9]/gi, '') || 'bin';
      const filePath = `${roomId}/temp-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`;
      await uploadFileWithProgress(supabase, 'room_attachments', filePath, file, (progress) => {
        setLocalUpload((current) => current ? { ...current, loaded: progress.loaded, percent: progress.percent } : current);
      });

      setLocalUpload((current) => current ? { ...current, loaded: current.total, percent: 100, phase: 'saving' } : current);
      const mediaType = file.type.startsWith('audio/') ? 'audio' : 'video';
      // Store file path (not public URL) for private storage compatibility
      const result = await logTemporaryMedia(roomId, file.name, filePath, mediaType);
      if (!result.success) throw new Error(result.error ?? 'Unable to save the uploaded media.');

      // Generate signed URL for immediate casting
      const signedUrlResult = await getSignedStorageUrl(filePath, roomId);
      if (!signedUrlResult.success || !signedUrlResult.url) {
        throw new Error(signedUrlResult.error ?? 'Unable to generate playback URL.');
      }

      // The file is immediately available to the room and is also added to
      // the same 24-hour history used by the Files tab.
      broadcastEvent('cast', {
        url: signedUrlResult.url,
        title: file.name,
        sourceType: 'upload',
        speed: 1,
        playing: true,
      });
      await loadHistory();
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : 'Upload failed.');
    } finally {
      setLocalUpload(null);
      if (localFileRef.current) localFileRef.current.value = '';
    }
  };

  const stopCasting = () => {
    if (!canCast) return;
    readyCastIdRef.current = null;
    setReadyCastId(null);
    broadcastEvent('stop_cast');
  };

  const urlHistory = history.filter((item) => item.media_type === 'url');
  const uploadedHistory = history.filter((item) => item.media_type !== 'url');

  return (
    <section className="relative flex min-h-0 flex-1 flex-col p-3 sm:p-4">
      <style dangerouslySetInnerHTML={{ __html: `
        video::cue {
          font-size: ${subSize} !important;
          color: ${subColor} !important;
          background-color: ${subBg} !important;
          font-family: sans-serif;
          font-weight: bold;
          text-shadow: 1px 1px 2px black;
        }
      ` }} />

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-3xl border border-white/10 bg-[#0b0b0b] shadow-2xl">
        <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between bg-gradient-to-b from-black/90 to-transparent p-4 pointer-events-auto">
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-bold text-white drop-shadow-md">{activeMediaUrl ? mediaTitle : 'Watch Party Stage'}</span>
            {activeMediaUrl && <span className="text-[10px] font-bold uppercase tracking-widest text-indigo-400">{playbackSpeed}x speed</span>}
          </div>

          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            {activeMediaUrl && canCast && (
              <div className="hidden overflow-hidden rounded border border-neutral-700 bg-neutral-900/80 backdrop-blur-md md:flex">
                {[0.5, 1, 1.5, 2].map((speed) => (
                  <button key={speed} type="button" onClick={() => changePlaybackSpeed(speed)} className={`cursor-pointer px-2 py-1 text-[10px] font-bold transition ${playbackSpeed === speed ? 'bg-indigo-600 text-white' : 'text-neutral-400 hover:bg-neutral-800'}`}>
                    {speed}x
                  </button>
                ))}
              </div>
            )}

            <button type="button" onClick={() => { setShowHistory((visible) => !visible); if (!showHistory) void loadHistory(); }} className="rounded-md border border-neutral-700 bg-neutral-800/80 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-neutral-200 transition hover:bg-neutral-700" aria-label="Open cast history">
              History
            </button>

            {activeMediaUrl && (
              <div className="relative">
                <button type="button" onClick={() => setShowSettings((visible) => !visible)} className="rounded-md border border-neutral-600 bg-neutral-800/80 p-1.5 text-white transition hover:bg-neutral-700" aria-label="Player settings">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1.51 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06A2 2 0 1 1 7.04 4.3l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10.6 3.09V3a2 2 0 0 1 4 0v.09A1.65 1.65 0 0 0 16.1 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82A1.65 1.65 0 0 0 20.31 11H21a2 2 0 0 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15Z" /></svg>
                </button>
                {showSettings && (
                  <div className="absolute right-0 top-full z-50 mt-2 w-64 overflow-hidden rounded-xl border border-neutral-700 bg-[#121212] shadow-2xl">
                    <div className="flex border-b border-neutral-800">
                      <button type="button" onClick={() => setSettingsTab('subtitles')} className={`flex-1 cursor-pointer py-2 text-xs font-bold uppercase ${settingsTab === 'subtitles' ? 'bg-indigo-600/20 text-indigo-400' : 'text-neutral-500 hover:text-white'}`}>Subtitles</button>
                      <button type="button" onClick={() => setSettingsTab('audio')} className={`flex-1 cursor-pointer py-2 text-xs font-bold uppercase ${settingsTab === 'audio' ? 'bg-indigo-600/20 text-indigo-400' : 'text-neutral-500 hover:text-white'}`}>Audio</button>
                    </div>
                    <div className="max-h-[300px] overflow-y-auto p-4">
                      {settingsTab === 'subtitles' ? (
                        <div className="flex flex-col gap-4">
                          <div className="flex items-center justify-between"><span className="text-xs font-bold text-white">Visibility</span><button type="button" onClick={() => setShowSubtitles((visible) => !visible)} className={`cursor-pointer rounded px-3 py-1 text-[10px] font-bold uppercase ${showSubtitles ? 'bg-emerald-500/20 text-emerald-400' : 'bg-neutral-800 text-neutral-400'}`}>{showSubtitles ? 'On' : 'Off'}</button></div>
                          <label className="flex flex-col gap-1.5"><span className="text-[10px] font-bold uppercase text-neutral-500">Size</span><select value={subSize} onChange={(event) => setSubSize(event.target.value)} className="w-full cursor-pointer rounded border border-neutral-800 bg-[#1a1a1a] p-1.5 text-xs text-white outline-none"><option value="75%">Small</option><option value="100%">Normal</option><option value="150%">Large</option><option value="200%">Extra large</option></select></label>
                          <label className="flex flex-col gap-1.5"><span className="text-[10px] font-bold uppercase text-neutral-500">Color</span><select value={subColor} onChange={(event) => setSubColor(event.target.value)} className="w-full cursor-pointer rounded border border-neutral-800 bg-[#1a1a1a] p-1.5 text-xs text-white outline-none"><option value="#ffffff">White</option><option value="#ffff00">Yellow</option><option value="#00ffff">Cyan</option></select></label>
                          <label className="flex flex-col gap-1.5"><span className="text-[10px] font-bold uppercase text-neutral-500">Background</span><select value={subBg} onChange={(event) => setSubBg(event.target.value)} className="w-full cursor-pointer rounded border border-neutral-800 bg-[#1a1a1a] p-1.5 text-xs text-white outline-none"><option value="transparent">None</option><option value="rgba(0, 0, 0, 0.75)">Dark</option><option value="rgba(0, 0, 0, 1)">Solid black</option></select></label>
                        </div>
                      ) : (
                        <div className="flex flex-col gap-2"><span className="mb-2 text-xs font-bold text-white">Available tracks</span>{audioTracks.length === 0 ? <p className="text-[10px] leading-relaxed text-neutral-500">Only the default audio track is available for this stream.</p> : audioTracks.map((track) => <button type="button" key={track.id} onClick={() => changeAudioTrack(track.id)} className={`w-full cursor-pointer rounded px-3 py-2 text-left text-xs font-bold ${activeAudioIndex === track.id ? 'bg-indigo-600 text-white' : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'}`}>{track.label}</button>)}</div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeMediaUrl && canCast && <button type="button" onClick={stopCasting} className="rounded border border-red-500/30 bg-red-500/20 px-3 py-1 text-xs font-bold text-red-400 transition hover:bg-red-500/30">Stop</button>}
            {activeMediaUrl && <button type="button" onClick={canCast ? forceSyncToRoom : () => broadcastEvent('request_sync')} className="hidden rounded border border-emerald-500/30 bg-emerald-500/20 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-emerald-400 transition hover:bg-emerald-500/30 sm:block">{canCast ? 'Force sync' : 'Sync to host'}</button>}
          </div>
        </div>

        {showHistory && (
          <div className="absolute right-4 top-16 z-40 flex max-h-[70%] w-[min(22rem,calc(100%-2rem))] flex-col overflow-hidden rounded-2xl border border-neutral-700 bg-[#111]/95 shadow-2xl backdrop-blur-md">
            <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3"><div><h3 className="text-sm font-bold text-white">Cast history</h3><p className="text-[10px] text-neutral-500">Uploaded files and URLs from the last 24 hours</p></div><button type="button" onClick={() => setShowHistory(false)} className="cursor-pointer text-neutral-500 hover:text-white" aria-label="Close cast history">x</button></div>
            <div className="overflow-y-auto p-3">
              {historyLoading && <p className="px-2 py-3 text-xs text-neutral-500">Loading history...</p>}
              {historyError && <p className="mb-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[10px] text-amber-300">{historyError}</p>}
              {!historyLoading && history.length === 0 && <p className="px-2 py-6 text-center text-xs text-neutral-500">No recent casts yet.</p>}
              {urlHistory.length > 0 && <p className="px-2 pb-2 pt-1 text-[10px] font-bold uppercase tracking-widest text-neutral-500">Web URLs</p>}
              <div className="flex flex-col gap-2">{urlHistory.map((item) => <HistoryRow key={item.id} item={item} canCast={canCast} onCast={castHistoryItem} />)}</div>
              {uploadedHistory.length > 0 && <p className="px-2 pb-2 pt-4 text-[10px] font-bold uppercase tracking-widest text-neutral-500">Uploaded media</p>}
              <div className="flex flex-col gap-2">{uploadedHistory.map((item) => <HistoryRow key={item.id} item={item} canCast={canCast} onCast={castHistoryItem} />)}</div>
            </div>
          </div>
        )}

        <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center bg-black p-4">
          {activeMediaUrl ? (
            <div className="relative h-full w-full overflow-hidden rounded-xl border border-neutral-800">
              <Player
                key={playerKey}
                ref={playerRef}
                src={activeMediaUrl}
                playing={playing}
                playbackRate={playbackSpeed}
                controls
                width="100%"
                height="100%"
                crossOrigin="anonymous"
                onLoadedMetadata={handleReady}
                onTimeUpdate={handleTimeUpdate}
                onPlay={handlePlay}
                onPause={handlePause}
                onError={() => {
                  setErrorUrl(activeMediaUrl);
                  setPlayerError('This stream could not be loaded. Try again or choose another history item.');
                }}
                config={{ youtube: { rel: 0, iv_load_policy: 3 } }}
              >
                {activeSubtitleUrl && showSubtitles && <track kind="subtitles" src={activeSubtitleUrl} srcLang="en" default label="English" />}
              </Player>
              {displayedPlayerError && <div className="absolute inset-x-4 bottom-4 z-20 flex items-center justify-between gap-3 rounded-xl border border-red-500/30 bg-black/85 px-4 py-3 text-xs text-red-200"><span>{displayedPlayerError}</span><button type="button" onClick={() => { setPlayerError(null); setErrorUrl(null); readyCastIdRef.current = null; setReadyCastId(null); setRetryNonce((value) => value + 1); }} className="shrink-0 cursor-pointer rounded bg-red-500/20 px-3 py-1.5 font-bold text-red-300 hover:bg-red-500/30">Retry</button></div>}
              {canCast && !activeSubtitleUrl && !activeMediaUrl.includes('youtube.com') && <div className="absolute bottom-16 right-4 z-20"><input type="file" ref={subtitleFileRef} onChange={startSubtitleUpload} className="hidden" accept=".vtt,.srt" /><button type="button" onClick={() => subtitleFileRef.current?.click()} disabled={isUploadingSub} className="cursor-pointer rounded-lg border border-indigo-500/50 bg-indigo-600/80 px-4 py-2 text-xs font-bold text-white shadow-2xl transition hover:bg-indigo-600 disabled:cursor-not-allowed disabled:opacity-50">{isUploadingSub ? 'Uploading subtitle...' : '+ Add .SRT / .VTT'}</button></div>}
            </div>
          ) : (
            <div className="flex w-full max-w-xl flex-col items-center">
              <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-full border border-white/10 bg-white/5"><svg viewBox="0 0 24 24" className="ml-0.5 h-7 w-7 text-white" fill="currentColor"><path d="M8 5.14v13.72L19.06 12 8 5.14z" /></svg></div>
              <h2 className="mb-2 text-lg font-bold text-white">Stage is empty</h2>
              {canCast ? <div className="mt-4 w-full"><p className="text-center text-xs text-neutral-400">Paste a YouTube, MP4, or media URL to cast it immediately, or upload local media for the room.</p><form onSubmit={startUrlCasting} className="mt-4 flex gap-2"><input type="url" value={castInput} onChange={(event) => setCastInput(event.target.value)} placeholder="Paste YouTube, MP4, or media URL..." className="min-w-0 flex-1 rounded-lg border border-neutral-800 bg-[#121212] px-3 py-2 text-sm text-white transition focus:border-indigo-500 focus:outline-none" /><button type="submit" disabled={isCastingUrl || Boolean(localUpload)} className="cursor-pointer rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-wait disabled:opacity-60">Cast</button></form><input type="file" ref={localFileRef} onChange={handleLocalFileUpload} className="hidden" accept="video/*,audio/*" />{localUpload ? <div className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-left" aria-live="polite"><div className="flex items-center justify-between gap-2 text-xs font-bold text-white"><span className="truncate" title={localUpload.fileName}>{localUpload.fileName} · {formatBytes(localUpload.total)}</span><span className="shrink-0 text-emerald-400">{localUpload.percent}%</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-neutral-800"><div className="h-full rounded-full bg-emerald-500 transition-[width] duration-150" style={{ width: `${localUpload.percent}%` }} /></div><p className="mt-2 text-[10px] text-neutral-500">{localUpload.phase === 'saving' ? 'Finishing upload...' : `${formatBytes(localUpload.loaded)} of ${formatBytes(localUpload.total)}`}</p></div> : <button type="button" onClick={() => localFileRef.current?.click()} className="mx-auto mt-4 block cursor-pointer rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-2 text-xs font-bold text-neutral-200 transition hover:border-neutral-600 hover:text-white">Upload local media (under 50MB)</button>}{historyError && <p className="mt-3 text-center text-[10px] text-amber-300">{historyError}</p>}</div> : <p className="mt-2 text-sm text-zinc-500">Waiting for a room admin to cast media...</p>}
              {connectionState === 'error' && <p className="mt-4 text-[10px] text-amber-400">Realtime connection interrupted. Reconnect or refresh to sync with the host.</p>}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function HistoryRow({ item, canCast, onCast }: { item: TemporaryMedia; canCast: boolean; onCast: (item: TemporaryMedia) => void }) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-[#171717] p-3">
      <div className="flex items-start gap-2"><span className={`mt-0.5 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${item.media_type === 'url' ? 'bg-sky-500/10 text-sky-300' : 'bg-purple-500/10 text-purple-300'}`}>{item.media_type === 'url' ? 'URL' : item.media_type}</span><span className="min-w-0 flex-1 truncate text-xs font-bold text-white" title={item.file_name}>{item.file_name}</span></div>
      <div className="mt-2 flex items-center justify-between gap-2"><span className="text-[10px] text-neutral-500">{formatHoursUntil(item.expires_at)}</span>{canCast && <button type="button" onClick={() => onCast(item)} className="cursor-pointer rounded bg-indigo-600/20 px-3 py-1.5 text-[10px] font-bold text-indigo-300 transition hover:bg-indigo-600/30">Cast again</button>}</div>
    </div>
  );
}
