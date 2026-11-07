'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent, type FormEvent } from 'react';
import dynamic from 'next/dynamic';
import { createPortal } from 'react-dom';
import { attachRoomMediaSubtitle, cleanupUnregisteredTemporaryMedia, getActiveTemporaryMedia, getRoomMediaDetails, logTemporaryMedia, resolveRoomMedia, type RoomMediaDetails } from '@/actions/media';
import { fallbackArtwork } from '@/lib/media-metadata';
import { HEARTBEAT_INTERVAL_MS, SEEK_COALESCE_MS, createCoalescer, expectedPosition, needsDriftSeek, shouldBroadcastNative } from '@/lib/watch-sync';
import { addToQueue, listQueue, removeFromQueue } from '@/lib/watch-queue-data';
import { findLink, hasYouTubeVideo, normalizeCastUrl, youtubePlaylistId } from '@/lib/cast-url';
import SiteLinks from '@/components/room/SiteLinks';
import { fetchPlaylist, importPlaylist, queueLink, registerLink, type LinkOutcome } from '@/lib/watch-links';
import WatchQueuePanel from '@/components/room/WatchQueuePanel';
import WatchSearchPanel, { type SearchTab } from '@/components/room/WatchSearchPanel';
import TabShareStage, { ShareTabButton, TabShareNotice, useTabShareLive } from '@/components/room/TabShareStage';
import { OmniIcon } from '@/components/ui/OmniIcon';
import { useRoomRealtime } from '@/components/room/RoomRealtimeProvider';
import { useRoomPanelResize } from '@/components/room/useRoomPanelResize';
import { createRoomObjectPath, assertRoomFileInput, ROOM_ATTACHMENT_BUCKET } from '@/lib/room-file-contract';
import { validateRoomMediaUpload, validateRoomSubtitleUpload, withRoomStorageMimeType } from '@/lib/room-file-validation';
import { startUploadFileWithProgress } from '@/lib/storage';
import { createClient } from '@/utils/supabase/client';

const Player = dynamic(() => import('react-player').then((module) => module.default), { ssr: false });

interface MediaStageProps {
  roomId: string;
  canControlMedia: boolean;
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

interface HTMLMediaElementWithAudioTracks extends HTMLMediaElement {
  audioTracks?: AudioTrackListLike;
}

interface TemporaryMedia {
  id: string;
  file_name: string;
  file_url: string;
  media_type: string;
  expires_at: string;
  created_at: string;
  // Cached from the file's tags (Action 10); absent for links.
  title?: string | null;
  artist?: string | null;
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

function isFlacPath(value: string | null | undefined) {
  return typeof value === 'string' && /\.flac(?:$|\?)/i.test(value);
}

function subscribeToNothing() {
  return () => undefined;
}

export default function MediaStage({ roomId, canControlMedia }: MediaStageProps) {
  const {
    mediaState,
    broadcastEvent,
    connectionState,
    recordMediaTime,
    currentUserId,
    mediaHeartbeat,
    queueVersion,
    clipsVersion,
    connectionGeneration,
  } = useRoomRealtime();

  const playerRef = useRef<HTMLMediaElementWithAudioTracks>(null);
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
  const [localVolume, setLocalVolume] = useState<number | null>(null);
  const [localMuted, setLocalMuted] = useState<boolean | null>(null);

  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'subtitles' | 'audio'>('subtitles');
  const [showSubtitles, setShowSubtitles] = useState(true);
  // Audio elements never draw subtitle cues, so audio casts show the active
  // cue as text (keyed by cast so a previous cast's line never lingers).
  const [audioCaption, setAudioCaption] = useState<{ castId: string; text: string } | null>(null);
  const [subSize, setSubSize] = useState('100%');
  const [subColor, setSubColor] = useState('#ffffff');
  const [subBg, setSubBg] = useState('rgba(0, 0, 0, 0.75)');
  const [audioTracks, setAudioTracks] = useState<Array<{ id: number; label: string }>>([]);
  const [activeAudioIndex, setActiveAudioIndex] = useState(0);

  const [mediaDetails, setMediaDetails] = useState<RoomMediaDetails | null>(null);
  const [history, setHistory] = useState<TemporaryMedia[]>([]);
  const [showQueue, setShowQueue] = useState(false);
  const [queueNotice, setQueueNotice] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchTab, setSearchTab] = useState<SearchTab>('all');
  // The YouTube and Twitch logos open search on that site inside the room.
  const openSearch = (tab: SearchTab) => { setSearchTab(tab); setShowSearch(true); setShowQueue(false); setShowHistory(false); };
  // A link pasted or dropped anywhere in the room, or shared into it (?link=).
  const [found, setFound] = useState<string | null>(null);
  // Work and messages are tied to the link they belong to, so pasting another
  // link while one is still being added never mixes the two up.
  const [foundBusy, setFoundBusy] = useState<string | null>(null);
  const [foundNote, setFoundNote] = useState<{ link: string; text: string; error: boolean } | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const supabase = createClient();
  const {
    panelRef,
    panelHeight,
    isResizing,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handleKeyDown,
  } = useRoomPanelResize(roomId, currentUserId, 'cast-height', { minHeight: 280, maxHeight: 760 });
  const canCast = canControlMedia;
  const tabShareLive = useTabShareLive();
  const activeMediaUrl = mediaState?.url ?? null;
  const activeSubtitleUrl = mediaState?.subtitleUrl ?? null;
  const mediaTitle = mediaState?.title ?? 'External Stream';
  const activeMediaId = mediaState?.mediaId;
  const activeSourceType = mediaState?.sourceType;
  const activeCastId = mediaState?.castId ?? activeMediaUrl;
  const playing = mediaState?.playing ?? false;
  const muted = mediaState?.muted ?? false;
  const volume = mediaState?.volume ?? 1;
  const displayedVolume = canCast ? volume : (localVolume ?? volume);
  const displayedMuted = canCast ? muted : (localMuted ?? muted);
  const playbackSpeed = mediaState?.speed ?? 1;
  // Each viewer's URL comes from its own resolveRoomMedia call (see
  // useRoomSync); Broadcast carries only the media id.
  const playbackUrl = activeMediaUrl;
  const playbackSubtitleUrl = activeSubtitleUrl;
  const isReady = playbackUrl !== null && readyCastId === activeCastId;
  // Now-playing details cached with the media row; never sent over Broadcast.
  const details = mediaDetails && mediaDetails.id === activeMediaId ? mediaDetails : null;
  const isFlacPlayback = isFlacPath(mediaTitle) || isFlacPath(playbackUrl);
  const isAudioCast = Boolean(playbackUrl) && (details?.mediaType === 'audio' || isFlacPlayback);
  useEffect(() => {
    if (!activeMediaId) return;
    let active = true;
    void getRoomMediaDetails(roomId, activeMediaId).then((result) => {
      if (active) setMediaDetails(result.success ? result.details : null);
    });
    return () => { active = false; };
  }, [activeMediaId, roomId]);
  const flacPlaybackSupported = useSyncExternalStore(
    subscribeToNothing,
    () => !isFlacPlayback || document.createElement('audio').canPlayType('audio/flac') !== '',
    () => true,
  );
  const playerKey = playbackUrl && activeCastId ? `${activeCastId}:${retryNonce}` : 'empty';
  const displayedPlayerError = errorUrl === playbackUrl ? playerError : null;

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

  useEffect(() => {
    const player = playerRef.current;
    if (!isAudioCast || !isReady || !player || !playbackSubtitleUrl || !activeCastId) return;
    const tracks = player.textTracks;
    const castId = activeCastId;
    const update = () => {
      const lines: string[] = [];
      for (let index = 0; index < tracks.length; index += 1) {
        const track = tracks[index];
        if (track.mode === 'disabled' || !track.activeCues) continue;
        for (let cue = 0; cue < track.activeCues.length; cue += 1) {
          const text = (track.activeCues[cue] as VTTCue).text ?? '';
          lines.push(text.replace(/<[^>]+>/g, ''));
        }
      }
      const text = lines.join('\n').trim();
      setAudioCaption((current) => (current?.castId === castId && current.text === text ? current : { castId, text }));
    };
    const listen = () => {
      for (let index = 0; index < tracks.length; index += 1) tracks[index].addEventListener('cuechange', update);
    };
    listen();
    tracks.addEventListener('addtrack', listen);
    // A cue can become active while the track file is still loading, before
    // any cuechange listener exists; timeupdate catches that (no-op when equal).
    player.addEventListener('timeupdate', update);
    const initial = window.setTimeout(update, 0);
    return () => {
      window.clearTimeout(initial);
      player.removeEventListener('timeupdate', update);
      tracks.removeEventListener('addtrack', listen);
      for (let index = 0; index < tracks.length; index += 1) tracks[index].removeEventListener('cuechange', update);
    };
  }, [activeCastId, isAudioCast, isReady, playbackSubtitleUrl]);

  const safeGetTime = () => {
    return playerRef.current?.currentTime ?? 0;
  };

  const safeSeekTo = (time: number) => {
    if (playerRef.current) playerRef.current.currentTime = time;
  };

  useEffect(() => {
    const player = playerRef.current;
    if (!mediaState || !isReady || !player) return;
    if (player.playbackRate !== mediaState.speed) player.playbackRate = mediaState.speed;
    // The room keeps playing while an event travels and resolves: seek to
    // where it is now, not where it was when the event was sent.
    const targetTime = expectedPosition(mediaState, Date.now());
    const willSeek = Math.abs(safeGetTime() - targetTime) > 0.25;
    const willPlay = mediaState.playing && player.paused;
    const willPause = !mediaState.playing && !player.paused;
    const willChangeVolume = player.volume !== displayedVolume || player.muted !== displayedMuted;
    // Only arm the echo guard when this effect really changes the element.
    // Arming it on every state change (including this client's own
    // broadcasts) swallowed a real play/pause pressed right after a seek.
    // (The previous run's cleanup cleared its release timer, so release here;
    // shouldBroadcastNative still filters any late echo of that run.)
    if (!willSeek && !willPlay && !willPause && !willChangeVolume) {
      isSyncing.current = false;
      return;
    }
    isSyncing.current = true;
    if (willSeek) safeSeekTo(targetTime);

    // Seeking a native media element can briefly pause it. Re-apply the
    // authoritative room playback state after the seek without rebroadcasting
    // the resulting native events.
    player.volume = displayedVolume;
    player.muted = displayedMuted;
    if (mediaState.playing && player.paused) {
      void player.play().catch(() => undefined);
    } else if (!mediaState.playing && !player.paused) {
      player.pause();
    }

    const timeout = window.setTimeout(() => { isSyncing.current = false; }, 500);
    return () => window.clearTimeout(timeout);
  }, [displayedMuted, displayedVolume, isReady, mediaState]);

  useEffect(() => {
    // Every client requests the current room snapshot. Controllers must not
    // assume their restored browser state is authoritative when rejoining.
    broadcastEvent('request_sync');
  }, [broadcastEvent, roomId]);

  // After a reconnect (the room feed is confirmed again), ask for the live
  // state: events sent while this client was offline are not replayed.
  useEffect(() => {
    if (connectionGeneration > 1) broadcastEvent('request_sync');
  }, [broadcastEvent, connectionGeneration]);

  const forceSyncToRoom = useCallback(() => {
    if (!canCast || !activeMediaUrl) return;
    if (mediaState?.source === 'restored' || (mediaState?.controllerId && mediaState.controllerId !== currentUserId)) {
      broadcastEvent('request_sync');
      return;
    }
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
      muted,
      volume,
    });
  }, [activeCastId, activeMediaId, activeMediaUrl, activeSourceType, activeSubtitleUrl, broadcastEvent, canCast, currentUserId, mediaState?.controllerId, mediaState?.source, mediaTitle, muted, playbackSpeed, playing, volume]);

  // Every caller is an explicit user action (native events are filtered by
  // isSyncing/shouldBroadcastNative), so a member with watch control may act
  // on a restored snapshot too: after a reload nobody else can answer
  // request_sync, and refusing here left the room with no controller.
  const broadcastPlayback = (eventType: 'play' | 'pause' | 'seek' | 'mute', time = safeGetTime(), nextPlaying = playing, nextSpeed = playbackSpeed, nextMuted = muted, nextVolume = volume) => {
    if (!canCast || !mediaState) return;
    broadcastEvent(eventType, {
      url: activeMediaUrl,
      title: mediaTitle,
      time,
      speed: nextSpeed,
      playing: nextPlaying,
      sourceType: activeSourceType,
      castId: activeCastId,
      mediaId: activeMediaId,
      muted: nextMuted,
      volume: nextVolume,
    });
  };

  // Native events become room broadcasts only when they change room state,
  // so applying a remote event can never echo back (no recursive rebroadcast).
  const handlePlay = () => {
    if (!isSyncing.current && shouldBroadcastNative('play', mediaState, safeGetTime(), Date.now())) broadcastPlayback('play', safeGetTime(), true);
  };

  const handlePause = () => {
    if (!isSyncing.current && shouldBroadcastNative('pause', mediaState, safeGetTime(), Date.now())) broadcastPlayback('pause', safeGetTime(), false);
  };

  // Dragging the scrubber fires many seeks; only the final position is sent.
  const mediaStateRef = useRef(mediaState);
  const broadcastPlaybackRef = useRef<((eventType: 'seek', time: number) => void) | null>(null);
  const seekCoalescer = useRef<{ push: (time: number) => void; cancel: () => void } | null>(null);
  useEffect(() => {
    mediaStateRef.current = mediaState;
    broadcastPlaybackRef.current = (eventType, time) => broadcastPlayback(eventType, time, mediaState?.playing ?? false);
  });
  useEffect(() => {
    const coalescer = createCoalescer<number>((time) => {
      if (shouldBroadcastNative('seek', mediaStateRef.current, time, Date.now())) broadcastPlaybackRef.current?.('seek', time);
    }, SEEK_COALESCE_MS);
    seekCoalescer.current = coalescer;
    return () => coalescer.cancel();
  }, []);

  const handleSeeked = () => {
    if (!isSyncing.current) seekCoalescer.current?.push(safeGetTime());
  };

  const handleVolumeChange = () => {
    if (isSyncing.current) return;
    const nextVolume = playerRef.current?.volume ?? displayedVolume;
    const nextMuted = Boolean(playerRef.current?.muted);
    if (!canCast) {
      setLocalVolume(nextVolume);
      setLocalMuted(nextMuted);
      return;
    }
    broadcastPlayback(
      'mute',
      safeGetTime(),
      playing,
      playbackSpeed,
      nextMuted,
      nextVolume,
    );
  };

  const handleReady = () => {
    if (!activeCastId || readyCastIdRef.current === activeCastId) return;
    readyCastIdRef.current = activeCastId;
    setReadyCastId(activeCastId);
    isSyncing.current = true;
    if (mediaState) safeSeekTo(expectedPosition(mediaState, Date.now()));
    window.setTimeout(() => { isSyncing.current = false; }, 500);

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

    setCastInput('');
    setIsCastingUrl(true);
    await castLink(cast.url, cast.title);
    setIsCastingUrl(false);
  };

  // Register first. Members receive only the resulting media id over
  // Broadcast and resolve the URL themselves under their own authorization,
  // so an unregistered cast cannot be shared with the room.
  const castLink = async (url: string, title: string): Promise<LinkOutcome> => {
    if (!canCast) return { ok: false, error: 'Only the room owner or people with Watch control can cast.' };
    setPlayerError(null);
    setErrorUrl(null);
    try {
      const result = await registerLink(roomId, title, url);
      if (!result.ok) {
        setHistoryError(result.error);
        return result;
      }
      readyCastIdRef.current = null;
      setReadyCastId(null);
      broadcastEvent('cast', { url, title, mediaId: result.mediaId, speed: 1, playing: true, sourceType: 'url' });
      window.dispatchEvent(new CustomEvent('omni:open-window', { detail: 'watch' }));
      await loadHistory();
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The cast could not be shared with the room.';
      setHistoryError(message);
      return { ok: false, error: message };
    }
  };

  const queueFromLink = async (url: string, title: string, place: 'next' | 'last'): Promise<LinkOutcome> => {
    try {
      const result = await queueLink(roomId, title, url, place);
      if (result.ok) broadcastEvent('queue_changed', { version: Date.now() });
      return result;
    } catch {
      return { ok: false, error: 'That could not be added to the queue. Try again.' };
    }
  };

  // Paste (outside text fields) or drop a link anywhere in the room.
  useEffect(() => {
    const editable = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
    const take = (text: string | undefined) => {
      const link = text ? findLink(text) : null;
      if (!link) return false;
      setFound(link);
      setFoundNote(null);
      return true;
    };
    const linkDrag = (event: DragEvent) => {
      const types = event.dataTransfer?.types;
      return Boolean(types && !types.includes('Files') && (types.includes('text/uri-list') || types.includes('text/plain')));
    };
    const onPaste = (event: ClipboardEvent) => {
      if (!editable(event.target) && take(event.clipboardData?.getData('text/plain'))) event.preventDefault();
    };
    const onDragOver = (event: DragEvent) => {
      if (editable(event.target) || !linkDrag(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (event: DragEvent) => {
      if (editable(event.target) || !linkDrag(event)) return;
      if (take(event.dataTransfer?.getData('text/uri-list') || event.dataTransfer?.getData('text/plain'))) event.preventDefault();
    };
    document.addEventListener('paste', onPaste);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('paste', onPaste);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('drop', onDrop);
    };
  }, []);

  // A link shared into the room (/room/<id>?link=…, from the share page or the
  // browser extension) opens the same prompt; the address is then cleaned up.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const shared = params.get('link');
    if (!shared) return;
    params.delete('link');
    const rest = params.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`);
    const timer = window.setTimeout(() => setFound(findLink(shared) ?? shared), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const foundAction = async (work: (note: (text: string) => void) => Promise<LinkOutcome>, done: string) => {
    const link = found;
    if (!link || foundBusy === link) return;
    setFoundBusy(link);
    setFoundNote(null);
    const result = await work((text) => setFoundNote({ link, text, error: false }));
    setFoundBusy((current) => (current === link ? null : current));
    setFoundNote(result.ok ? { link, text: done, error: false } : { link, text: result.error, error: true });
    if (result.ok) window.setTimeout(() => setFound((current) => (current === link ? null : current)), 1800);
  };

  const foundPlaylist = found ? youtubePlaylistId(found) : null;
  const foundHasVideo = Boolean(found) && (!foundPlaylist || hasYouTubeVideo(found ?? ''));
  let foundCast: { url: string; title: string } | null = null;
  let foundProblem: string | null = null;
  if (found && foundHasVideo) {
    try {
      foundCast = normalizeCastUrl(found);
    } catch (error) {
      foundProblem = error instanceof Error ? error.message : 'That link cannot be played.';
    }
  }

  const addFoundPlaylist = (playlistId: string) => foundAction(async (note) => {
    note('Loading the playlist…');
    const playlist = await fetchPlaylist(playlistId);
    if (!playlist.ok) return playlist;
    const queued = await listQueue(roomId);
    const items = playlist.items.slice(0, Math.max(0, 50 - (queued.ok ? queued.data.length : 0)));
    const result = await importPlaylist(roomId, items, (done, total) => note(`Adding ${Math.min(done + 1, total)} of ${total}…`));
    if (result.added) broadcastEvent('queue_changed', { version: Date.now() });
    if (result.error) return { ok: false, error: result.added ? `Added ${result.added}, then: ${result.error}` : result.error };
    return { ok: true };
  }, 'Playlist added to the queue.');

  const castHistoryItem = async (item: Pick<TemporaryMedia, 'id'>): Promise<boolean> => {
    if (!canCast) return false;
    setPlayerError(null);
    setErrorUrl(null);
    readyCastIdRef.current = null;
    setReadyCastId(null);

    const resolved = await resolveRoomMedia(roomId, item.id);
    if (!resolved.success || !resolved.media) {
      setPlayerError(resolved.error ?? 'Unable to load this media.');
      return false;
    }

    broadcastEvent('cast', {
      url: resolved.media.url,
      title: resolved.media.title,
      subtitleUrl: resolved.media.subtitleUrl,
      sourceType: resolved.media.sourceType,
      mediaId: item.id,
      speed: 1,
      playing: true,
    });
    setShowHistory(false);
    return true;
  };

  const isController = Boolean(canCast && mediaState && mediaState.source !== 'restored' && (!mediaState.controllerId || mediaState.controllerId === currentUserId));

  // The active controller announces its position while playing; viewers use
  // it to correct drift locally (never re-broadcast).
  useEffect(() => {
    if (!isController || !isReady || !playing || !activeMediaId) return;
    const interval = window.setInterval(() => {
      broadcastEvent('media_heartbeat', { mediaId: activeMediaId, castId: activeCastId, time: safeGetTime(), speed: playbackSpeed, playing: true });
    }, HEARTBEAT_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [activeCastId, activeMediaId, broadcastEvent, isController, isReady, playbackSpeed, playing]);

  useEffect(() => {
    if (!mediaHeartbeat || isController || !isReady || !playerRef.current) return;
    if (mediaHeartbeat.mediaId !== activeMediaId || (mediaHeartbeat.castId && mediaHeartbeat.castId !== activeCastId)) return;
    const expected = expectedPosition({ time: mediaHeartbeat.time, playing: mediaHeartbeat.playing, speed: mediaHeartbeat.speed, updatedAt: mediaHeartbeat.receivedAt, eventTimestamp: mediaHeartbeat.receivedAt, source: 'remote' }, Date.now());
    if (!needsDriftSeek(safeGetTime(), expected)) return;
    isSyncing.current = true;
    safeSeekTo(expected);
    const timeout = window.setTimeout(() => { isSyncing.current = false; }, 500);
    return () => window.clearTimeout(timeout);
  }, [activeCastId, activeMediaId, isController, isReady, mediaHeartbeat]);

  // Auto-advance: when the media ends, the controller plays the next item.
  const handleEnded = async () => {
    if (!isController) return;
    const queued = await listQueue(roomId);
    const next = queued.ok ? queued.data.find((entry) => entry.media) : undefined;
    if (!next?.media) return;
    if (await castHistoryItem({ id: next.media.id })) {
      const removed = await removeFromQueue(next.id);
      if (removed.ok) broadcastEvent('queue_changed', { version: Date.now() });
    }
  };

  const queueMedia = async (mediaId: string) => {
    setQueueNotice(null);
    const result = await addToQueue(roomId, mediaId);
    if (!result.ok) {
      setQueueNotice(result.error);
      return;
    }
    broadcastEvent('queue_changed', { version: Date.now() });
    setQueueNotice('Added to the queue.');
  };

  const startSubtitleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !canCast || !activeMediaId) {
      setPlayerError('Subtitles can be attached only to an uploaded room-media item.');
      return;
    }

    const validationError = validateRoomSubtitleUpload(file);
    if (validationError) {
      setHistoryError(validationError);
      if (subtitleFileRef.current) subtitleFileRef.current.value = '';
      return;
    }

    setIsUploadingSub(true);
    let filePath: string | null = null;
    try {
      const mediaId = activeMediaId;
      const checked = assertRoomFileInput(withRoomStorageMimeType(file, 'subtitle'), 'subtitle');
      filePath = createRoomObjectPath(roomId, 'subtitle', crypto.randomUUID(), checked.fileName);
      await startUploadFileWithProgress(supabase, ROOM_ATTACHMENT_BUCKET, filePath, file, undefined, checked.mimeType).promise;
      // Bind the subtitle to its media row. Members re-resolve the media and
      // receive their own signed subtitle URL; only the id is broadcast.
      const result = await attachRoomMediaSubtitle(roomId, mediaId, filePath);
      if (!result.success || !result.subtitleUrl) throw new Error(result.error ?? 'Unable to attach the subtitle.');
      broadcastEvent('subtitle_upload', { mediaId, subtitleUrl: result.subtitleUrl });
    } catch (error) {
      if (filePath) await cleanupUnregisteredTemporaryMedia(roomId, filePath, 'subtitle').catch(() => undefined);
      alert(`Subtitle upload failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsUploadingSub(false);
      if (subtitleFileRef.current) subtitleFileRef.current.value = '';
    }
  };

  const handleLocalFileUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !canCast || localUpload) return;

    const validationError = validateRoomMediaUpload(file);
    if (validationError) {
      setHistoryError(validationError);
      if (localFileRef.current) localFileRef.current.value = '';
      return;
    }

    setHistoryError(null);
    let filePath: string | null = null;

    try {
      const checked = assertRoomFileInput(withRoomStorageMimeType(file, 'media'), 'media');
      filePath = createRoomObjectPath(roomId, 'media', crypto.randomUUID(), checked.fileName);
      setLocalUpload({ fileName: checked.fileName, total: checked.size, loaded: 0, percent: 0, phase: 'uploading' });
      await startUploadFileWithProgress(supabase, ROOM_ATTACHMENT_BUCKET, filePath, file, (progress) => {
        setLocalUpload((current) => current ? { ...current, loaded: progress.loaded, percent: progress.percent } : current);
      }, checked.mimeType).promise;

      setLocalUpload((current) => current ? { ...current, loaded: current.total, percent: 100, phase: 'saving' } : current);
      const mediaType = checked.mimeType.startsWith('audio/') ? 'audio' : 'video';
      // The server verifies the stored object's type and size before
      // registering it, and returns the id members resolve the media by.
      const result = await logTemporaryMedia(roomId, checked.fileName, filePath, mediaType, checked.mimeType, checked.size);
      if (!result.success || !result.mediaId) throw new Error(result.error ?? 'Unable to save the uploaded media.');
      const resolved = await resolveRoomMedia(roomId, result.mediaId);
      if (!resolved.success || !resolved.media) throw new Error(resolved.error ?? 'Unable to generate playback URL.');

      // The file is immediately available to the room and is also added to
      // the room's temporary media history. Only the media id is broadcast;
      // the signed URL stays on this client.
      broadcastEvent('cast', {
        url: resolved.media.url,
        title: resolved.media.title,
        mediaId: result.mediaId,
        sourceType: 'upload',
        speed: 1,
        playing: true,
      });
      await loadHistory();
    } catch (error) {
      if (filePath) await cleanupUnregisteredTemporaryMedia(roomId, filePath, 'media').catch(() => undefined);
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

      <div
        ref={panelRef}
        data-stage-card
        data-watch-ready={isReady ? "yes" : "no"}
        data-watch-role={isController ? "controller" : "viewer"}
        data-watch-heartbeat={mediaHeartbeat ? String(mediaHeartbeat.receivedAt) : ""}
        style={panelHeight === null ? undefined : { height: `${panelHeight}px`, flex: '0 1 auto' }}
        className={`room-cast-resizable relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-3xl border border-white/10 bg-[#0b0b0b] shadow-2xl ${isResizing ? 'is-resizing' : ''}`}
      >
        <div className="absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-3 bg-gradient-to-b from-black/90 to-transparent p-4 pointer-events-auto">
          <div className="flex min-w-[6rem] flex-1 flex-col">
            <span className="truncate text-sm font-bold text-white drop-shadow-md">{playbackUrl ? (details?.title ?? mediaTitle) : 'Watch Party Stage'}</span>
            {playbackUrl && details && (details.artist || details.album) && <span className="truncate text-[11px] text-neutral-300">{[details.artist, details.album, details.year].filter(Boolean).join(' · ')}</span>}
            {playbackUrl && <span className="text-[10px] font-bold uppercase tracking-widest text-indigo-400">{playbackSpeed}x speed</span>}
            {playbackUrl && tabShareLive && <TabShareNotice />}
          </div>

          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 sm:gap-3">
            {playbackUrl && canCast && (
              <div className="hidden overflow-hidden rounded border border-neutral-700 bg-neutral-900/80 backdrop-blur-md md:flex">
                {[0.5, 1, 1.5, 2].map((speed) => (
                  <button key={speed} type="button" onClick={() => changePlaybackSpeed(speed)} className={`cursor-pointer px-2 py-1 text-[10px] font-bold transition ${playbackSpeed === speed ? 'bg-indigo-600 text-white' : 'text-neutral-400 hover:bg-neutral-800'}`}>
                    {speed}x
                  </button>
                ))}
              </div>
            )}

            {canCast && (
              <button type="button" onClick={() => { setShowSearch((visible) => !visible); setShowQueue(false); setShowHistory(false); }} aria-expanded={showSearch} className="omni-button omni-button-ghost omni-button-sm" aria-label="Search YouTube and Twitch">
                Search
              </button>
            )}

            <button type="button" onClick={() => { setShowQueue((visible) => !visible); setShowHistory(false); setShowSearch(false); }} aria-expanded={showQueue} className="omni-button omni-button-ghost omni-button-sm" aria-label="Open queue and clips">
              Queue
            </button>

            <button type="button" onClick={() => { setShowHistory((visible) => !visible); setShowQueue(false); setShowSearch(false); if (!showHistory) void loadHistory(); }} className="omni-button omni-button-ghost omni-button-sm" aria-label="Open cast history">
              History
            </button>

            {playbackUrl && (
              <div className="relative">
                <button type="button" onClick={() => setShowSettings((visible) => !visible)} className="omni-button omni-button-ghost omni-button-sm" aria-label="Player settings">
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

            {playbackUrl && canCast && <button type="button" onClick={stopCasting} className="omni-button omni-button-sm danger-button">Stop</button>}
            {playbackUrl && <button type="button" onClick={canCast ? forceSyncToRoom : () => broadcastEvent('request_sync')} className="omni-button omni-button-ghost omni-button-sm media-sync-button">{canCast ? 'Force sync' : 'Sync to host'}</button>}
          </div>
        </div>

        {showQueue && (
          <div data-media-history className="absolute right-4 top-16 z-40 flex max-h-[70%] w-[min(24rem,calc(100%-2rem))] flex-col overflow-hidden">
            <WatchQueuePanel
              roomId={roomId}
              currentUserId={currentUserId}
              canControl={canCast}
              currentMediaId={activeMediaId ?? null}
              queueVersion={queueVersion}
              clipsVersion={clipsVersion}
              connectionGeneration={connectionGeneration}
              getCurrentTime={safeGetTime}
              onPlayMedia={(mediaId) => castHistoryItem({ id: mediaId })}
              onSeek={(seconds) => { safeSeekTo(seconds); broadcastPlayback('seek', seconds, playing); }}
              onChanged={(kind) => broadcastEvent(kind === 'queue' ? 'queue_changed' : 'clips_changed', { version: Date.now() })}
              onClose={() => setShowQueue(false)}
              onOpenSearch={openSearch}
            />
          </div>
        )}

        {showSearch && canCast && (
          <div data-media-history className="absolute right-4 top-16 z-40 flex max-h-[78%] w-[min(28rem,calc(100%-2rem))] flex-col overflow-hidden">
            <WatchSearchPanel
              key={searchTab}
              initialTab={searchTab}
              hasMedia={Boolean(playbackUrl)}
              onPlay={(result) => castLink(result.url, result.title)}
              onQueue={(result, place) => queueFromLink(result.url, result.title, place)}
              onClose={() => setShowSearch(false)}
            />
          </div>
        )}

        {found && createPortal(
          <div className="link-catch glass" role="dialog" aria-label="Link found">
            <div className="link-catch-head">
              <span className="min-w-0">
                <span className="link-catch-title">{foundCast?.title ?? (foundPlaylist ? 'YouTube playlist' : 'Link found')}</span>
                <span className="link-catch-url" title={found}>{found}</span>
              </span>
              <button type="button" className="watch-panel-close" aria-label="Dismiss" onClick={() => setFound(null)}><OmniIcon name="close" size={13} /></button>
            </div>
            {!canCast ? (
              <p className="link-catch-note">Only the room owner or people with Watch control can add links here.</p>
            ) : (
              <>
                {foundProblem && <p className="link-catch-note is-error">{foundProblem}</p>}
                <div className="link-catch-actions">
                  {foundCast && (
                    <>
                      <button type="button" className="omni-button omni-button-primary omni-button-sm" disabled={foundBusy === found} onClick={() => { const cast = foundCast; if (cast) void foundAction(() => castLink(cast.url, cast.title), 'Playing now.'); }}>Play now</button>
                      <button type="button" className="omni-button omni-button-ghost omni-button-sm" disabled={foundBusy === found} onClick={() => { const cast = foundCast; if (cast) void foundAction(() => queueFromLink(cast.url, cast.title, 'next'), 'Plays next.'); }}>Play next</button>
                      <button type="button" className="omni-button omni-button-ghost omni-button-sm" disabled={foundBusy === found} onClick={() => { const cast = foundCast; if (cast) void foundAction(() => queueFromLink(cast.url, cast.title, 'last'), 'Added to the queue.'); }}>Add to queue</button>
                    </>
                  )}
                  {foundPlaylist && <button type="button" className="omni-button omni-button-ghost omni-button-sm" disabled={foundBusy === found} onClick={() => void addFoundPlaylist(foundPlaylist)}>Add the whole playlist</button>}
                </div>
              </>
            )}
            {foundBusy === found && foundNote?.link !== found && <p role="status" className="link-catch-note">Working on it{'…'}</p>}
            {foundNote && foundNote.link === found && <p role={foundNote.error ? 'alert' : 'status'} className={`link-catch-note${foundNote.error ? ' is-error' : ''}`}>{foundNote.text}</p>}
          </div>,
          document.body,
        )}

        {showHistory && (
          <div data-media-history className="absolute right-4 top-16 z-40 flex max-h-[70%] w-[min(22rem,calc(100%-2rem))] flex-col overflow-hidden rounded-2xl border border-neutral-700 bg-[#111]/95 shadow-2xl backdrop-blur-md">
            <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3"><div><h3 className="text-sm font-bold text-white">Cast history</h3><p className="text-[10px] text-neutral-500">Uploaded files and URLs from the last 24 hours</p></div><button type="button" onClick={() => setShowHistory(false)} className="cursor-pointer text-neutral-500 hover:text-white" aria-label="Close cast history">x</button></div>
            <div className="overflow-y-auto p-3">
              {historyLoading && <p className="px-2 py-3 text-xs text-neutral-500">Loading history...</p>}
              {historyError && <p className="mb-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[10px] text-amber-300">{historyError}</p>}
              {queueNotice && <p role="status" className="mb-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[10px] text-neutral-300">{queueNotice}</p>}
              {!historyLoading && history.length === 0 && <p className="px-2 py-6 text-center text-xs text-neutral-500">No recent casts yet.</p>}
              {urlHistory.length > 0 && <p className="px-2 pb-2 pt-1 text-[10px] font-bold uppercase tracking-widest text-neutral-500">Web URLs</p>}
              <div className="flex flex-col gap-2">{urlHistory.map((item) => <HistoryRow key={item.id} item={item} canCast={canCast} onCast={castHistoryItem} onQueue={queueMedia} />)}</div>
              {uploadedHistory.length > 0 && <p className="px-2 pb-2 pt-4 text-[10px] font-bold uppercase tracking-widest text-neutral-500">Uploaded media</p>}
              <div className="flex flex-col gap-2">{uploadedHistory.map((item) => <HistoryRow key={item.id} item={item} canCast={canCast} onCast={castHistoryItem} onQueue={queueMedia} />)}</div>
            </div>
          </div>
        )}

        <div data-media-area className="relative flex min-h-0 flex-1 flex-col items-center justify-center bg-black p-4">
          {tabShareLive && !playbackUrl ? <TabShareStage /> : playbackUrl ? (
            <div className={`relative h-full w-full overflow-hidden rounded-xl border border-neutral-800 ${isAudioCast ? 'flex flex-col' : ''}`}>
              {isAudioCast && details && <NowPlaying details={details} />}
              {isAudioCast && showSubtitles && playbackSubtitleUrl && audioCaption && audioCaption.castId === activeCastId && audioCaption.text && <p className="media-audio-caption" aria-live="polite">{audioCaption.text}</p>}
              {isFlacPlayback ? (
                flacPlaybackSupported ? <audio
                  key={playerKey}
                  ref={(node) => { playerRef.current = node; }}
                  src={playbackUrl}
                  muted={displayedMuted}
                  controls
                  preload="metadata"
                  crossOrigin="anonymous"
                  className={`${isAudioCast ? 'h-16 shrink-0' : 'h-full'} w-full bg-black`}
                  onLoadedMetadata={handleReady}
                  onTimeUpdate={handleTimeUpdate}
                  onPlay={handlePlay}
                  onPause={handlePause}
                  onSeeked={handleSeeked}
                  onVolumeChange={handleVolumeChange}
                  onEnded={() => void handleEnded()}
                  onError={() => {
                    setErrorUrl(playbackUrl);
                    setPlayerError('This browser could not play this FLAC file. Try another supported browser or download the private file.');
                  }}
                /> : <div role="alert" className="flex h-full items-center justify-center p-6 text-center text-sm text-amber-200">This browser cannot play FLAC audio. Download the private file or use a browser with FLAC playback support.</div>
              ) : <Player
                key={playerKey}
                ref={(node) => { playerRef.current = node; }}
                src={playbackUrl}
                playing={playing}
                muted={displayedMuted}
                volume={displayedVolume}
                playbackRate={playbackSpeed}
                controls
                width="100%"
                height={isAudioCast ? '64px' : '100%'}
                // Only subtitle tracks need CORS; hosts that send no CORS
                // headers (the Internet Archive) would fail to load with it.
                crossOrigin={playbackSubtitleUrl ? 'anonymous' : undefined}
                onLoadedMetadata={handleReady}
                onTimeUpdate={handleTimeUpdate}
                onPlay={handlePlay}
                onPause={handlePause}
                onSeeked={handleSeeked}
                onVolumeChange={handleVolumeChange}
                onEnded={() => void handleEnded()}
                onError={() => {
                  setErrorUrl(playbackUrl);
                  setPlayerError('This stream could not be loaded. Try again or choose another history item.');
                }}
                config={{ youtube: { rel: 0, iv_load_policy: 3 }, hls: { capLevelToPlayerSize: false, maxBufferLength: 30, backBufferLength: 60 } }}
              >
                {playbackSubtitleUrl && showSubtitles && <track kind="subtitles" src={playbackSubtitleUrl} srcLang="en" default label="English" />}
              </Player>}
              {displayedPlayerError && <div className="absolute inset-x-4 bottom-4 z-20 flex items-center justify-between gap-3 rounded-xl border border-red-500/30 bg-black/85 px-4 py-3 text-xs text-red-200"><span>{displayedPlayerError}</span><button type="button" onClick={() => { setPlayerError(null); setErrorUrl(null); readyCastIdRef.current = null; setReadyCastId(null); setRetryNonce((value) => value + 1); }} className="shrink-0 cursor-pointer rounded bg-red-500/20 px-3 py-1.5 font-bold text-red-300 hover:bg-red-500/30">Retry</button></div>}
              {canCast && !activeSubtitleUrl && !playbackUrl.includes('youtube.com') && <div className="absolute bottom-16 right-4 z-20"><input type="file" ref={subtitleFileRef} onChange={startSubtitleUpload} className="hidden" accept=".vtt,.srt" /><button type="button" onClick={() => subtitleFileRef.current?.click()} disabled={isUploadingSub} className="cursor-pointer rounded-lg border border-indigo-500/50 bg-indigo-600/80 px-4 py-2 text-xs font-bold text-white shadow-2xl transition hover:bg-indigo-600 disabled:cursor-not-allowed disabled:opacity-50">{isUploadingSub ? 'Uploading subtitle...' : '+ Add .SRT / .VTT'}</button></div>}
            </div>
          ) : (
            <div className="flex w-full max-w-xl flex-col items-center">
              <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-full border border-white/10 bg-white/5"><svg viewBox="0 0 24 24" className="ml-0.5 h-7 w-7 text-white" fill="currentColor"><path d="M8 5.14v13.72L19.06 12 8 5.14z" /></svg></div>
              <h2 className="mb-2 text-lg font-bold text-white">Stage is empty</h2>
              {canCast ? <div className="mt-4 w-full"><p className="text-center text-xs text-neutral-400">Paste a YouTube, Twitch, direct HTTPS media, or Kick HLS (.m3u8) URL to cast it immediately, or upload local media including FLAC for the room.</p><form onSubmit={startUrlCasting} className="mt-4 flex gap-2"><input type="url" value={castInput} onChange={(event) => setCastInput(event.target.value)} placeholder="Paste YouTube, Twitch, MP4, or media URL..." className="min-w-0 flex-1 rounded-lg border border-neutral-800 bg-[#121212] px-3 py-2 text-sm text-white transition focus:border-indigo-500 focus:outline-none" /><button type="submit" disabled={isCastingUrl || Boolean(localUpload)} className="cursor-pointer rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-wait disabled:opacity-60">Cast</button></form><SiteLinks className="mt-3 justify-center text-center" onSearch={openSearch} /><ShareTabButton /><input type="file" ref={localFileRef} onChange={handleLocalFileUpload} className="hidden" accept="audio/flac,.flac,audio/*,video/*" />{localUpload ? <div className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-left" aria-live="polite"><div className="flex items-center justify-between gap-2 text-xs font-bold text-white"><span className="truncate" title={localUpload.fileName}>{localUpload.fileName} · {formatBytes(localUpload.total)}</span><span className="shrink-0 text-emerald-400">{localUpload.percent}%</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-neutral-800"><div className="h-full rounded-full bg-emerald-500 transition-[width] duration-150" style={{ width: `${localUpload.percent}%` }} /></div><p className="mt-2 text-[10px] text-neutral-500">{localUpload.phase === 'saving' ? 'Finishing upload...' : `${formatBytes(localUpload.loaded)} of ${formatBytes(localUpload.total)}`}</p></div> : <button type="button" onClick={() => localFileRef.current?.click()} className="mx-auto mt-4 block cursor-pointer rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-2 text-xs font-bold text-neutral-200 transition hover:border-neutral-600 hover:text-white">Upload local media including FLAC (up to 500MB)</button>}{historyError && <p className="mt-3 text-center text-[10px] text-amber-300">{historyError}</p>}</div> : <p className="mt-2 text-sm text-zinc-500">Waiting for a room admin to cast media...</p>}
              {connectionState === 'error' && <p className="mt-4 text-[10px] text-amber-400">Realtime connection interrupted. Reconnect or refresh to sync with the host.</p>}
            </div>
          )}
        </div>
        <div
          role="separator"
          tabIndex={0}
          aria-label="Resize casting stage height"
          aria-orientation="horizontal"
          aria-valuemin={280}
          aria-valuemax={760}
          aria-valuenow={panelHeight ?? undefined}
          className="room-panel-resize-handle room-cast-resize-handle"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onKeyDown={handleKeyDown}
        />
      </div>
    </section>
  );
}

// Now playing (Action 10): artwork from the file's tags, or generated art,
// with where the details came from.
function NowPlaying({ details }: { details: RoomMediaDetails }) {
  const generated = fallbackArtwork(details.title);
  const subline = [details.artist, details.album, details.year].filter(Boolean).join(' · ');
  return (
    <div className="media-now-playing" aria-label="Now playing">
      {details.artworkDataUrl
        // eslint-disable-next-line @next/next/no-img-element -- data-URL artwork cached on the media row; next/image cannot optimise it
        ? <img src={details.artworkDataUrl} alt={`Artwork for ${details.title}`} className="media-now-playing-art" />
        : <div className="media-now-playing-art is-generated" style={{ background: `linear-gradient(135deg, ${generated.from}, ${generated.to})` }} role="img" aria-label="Generated artwork"><span aria-hidden="true">{generated.initials}</span></div>}
      <div className="min-w-0">
        <p className="media-now-playing-title">{details.title}</p>
        {subline && <p className="media-now-playing-sub">{subline}</p>}
        <p className="media-now-playing-source">{details.source === 'tags' ? 'Details from the file\u2019s embedded tags' : details.source === 'link' ? 'Shared link' : 'Title from the file name'}{details.artworkDataUrl ? '' : ' · generated artwork'}</p>
      </div>
    </div>
  );
}

function HistoryRow({ item, canCast, onCast, onQueue }: { item: TemporaryMedia; canCast: boolean; onCast: (item: TemporaryMedia) => void; onQueue: (mediaId: string) => void }) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-[#171717] p-3">
      <div className="flex items-start gap-2"><span className={`mt-0.5 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${item.media_type === 'url' ? 'bg-sky-500/10 text-sky-300' : 'bg-purple-500/10 text-purple-300'}`}>{item.media_type === 'url' ? 'URL' : item.media_type}</span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-bold text-white" title={item.file_name}>{item.title || item.file_name}</span>{item.artist && <span className="block truncate text-[10px] text-neutral-400">{item.artist}</span>}</span></div>
      <div className="mt-2 flex items-center justify-between gap-2"><span className="text-[10px] text-neutral-500">{formatHoursUntil(item.expires_at)}</span><span className="flex gap-1.5"><button type="button" onClick={() => onQueue(item.id)} className="cursor-pointer rounded bg-white/5 px-3 py-1.5 text-[10px] font-bold text-neutral-200 transition hover:bg-white/10" aria-label={`Add ${item.title || item.file_name} to the queue`}>Queue</button>{canCast && <button type="button" onClick={() => onCast(item)} className="cursor-pointer rounded bg-indigo-600/20 px-3 py-1.5 text-[10px] font-bold text-indigo-300 transition hover:bg-indigo-600/30">Cast again</button>}</span></div>
    </div>
  );
}
