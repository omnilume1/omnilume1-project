'use client';

import { useCallback, useEffect, useState } from 'react';
import { OmniIcon } from '@/components/ui/OmniIcon';
import { SURFACES } from '@/lib/surface-flags';
import SiteLinks from '@/components/room/SiteLinks';
import { hasYouTubeVideo, normalizeCastUrl, youtubePlaylistId } from '@/lib/cast-url';
import { fetchPlaylist, importPlaylist, queueLink as queueLinkInRoom } from '@/lib/watch-links';
import { formatPlaybackTime } from '@/lib/watch-sync';
import {
  createClip,
  deleteClip,
  listClips,
  listQueue,
  loadMemberNames,
  moveInQueue,
  removeFromQueue,
  type MediaClip,
  type QueueEntry,
} from '@/lib/watch-queue-data';

interface WatchQueuePanelProps {
  roomId: string;
  currentUserId: string | null;
  canControl: boolean;
  currentMediaId: string | null;
  queueVersion: number;
  clipsVersion: number;
  connectionGeneration: number;
  getCurrentTime: () => number;
  onPlayMedia: (mediaId: string) => Promise<boolean>;
  onSeek: (seconds: number) => void;
  onChanged: (kind: 'queue' | 'clips') => void;
  onClose: () => void;
  // Opens the room's search on that site (the YouTube and Twitch logos).
  onOpenSearch?: (source: 'youtube' | 'twitch') => void;
}

const CLIP_LENGTHS = [
  { value: '0', label: 'Just this moment' },
  { value: '15', label: 'Next 15 seconds' },
  { value: '30', label: 'Next 30 seconds' },
  { value: '60', label: 'Next minute' },
];

// Shared queue and clips (Action 11). Everyone who can watch sees both;
// adding and saving clips needs watch; reordering, playing and removing
// others' items needs watch_control. The server enforces all of it.
export default function WatchQueuePanel({
  roomId, currentUserId, canControl, currentMediaId, queueVersion, clipsVersion, connectionGeneration,
  getCurrentTime, onPlayMedia, onSeek, onChanged, onClose, onOpenSearch,
}: WatchQueuePanelProps) {
  const [tab, setTab] = useState<'queue' | 'clips'>('queue');
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [clips, setClips] = useState<MediaClip[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [clipLabel, setClipLabel] = useState('');
  const [clipLength, setClipLength] = useState('0');
  const [link, setLink] = useState('');
  const [progress, setProgress] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    void (async () => {
      const [queueResult, clipsResult, memberNames] = await Promise.all([
        listQueue(roomId),
        currentMediaId ? listClips(currentMediaId) : Promise.resolve({ ok: true as const, data: [] as MediaClip[] }),
        loadMemberNames(roomId),
      ]);
      if (!active) return;
      setNames(memberNames);
      if (!queueResult.ok || !clipsResult.ok) {
        setError(!queueResult.ok ? queueResult.error : !clipsResult.ok ? clipsResult.error : null);
        setStatus('error');
        return;
      }
      setQueue(queueResult.data);
      setClips(clipsResult.data);
      setStatus('ready');
    })();
    return () => { active = false; };
  }, [clipsVersion, connectionGeneration, currentMediaId, queueVersion, reload, roomId]);

  const nameOf = useCallback((userId: string) => (userId === currentUserId ? 'You' : names.get(userId) ?? 'Member'), [currentUserId, names]);

  const run = async (key: string, work: () => Promise<{ ok: boolean; error?: string }>, changed: 'queue' | 'clips') => {
    setBusy(key);
    setError(null);
    const result = await work();
    setBusy(null);
    if (!result.ok) {
      setError(result.error ?? 'That did not work. Try again.');
      return;
    }
    onChanged(changed);
  };

  const playNow = async (entry: QueueEntry) => {
    if (!entry.media) return;
    setBusy(`play:${entry.id}`);
    setError(null);
    const played = await onPlayMedia(entry.media.id);
    if (played) {
      const removed = await removeFromQueue(entry.id);
      if (removed.ok) onChanged('queue');
    }
    setBusy(null);
  };

  // A pasted link is registered like a cast (same server checks), then queued.
  // A YouTube playlist link (no single video in it) brings the whole playlist.
  const queueLink = async () => {
    if (!link.trim() || busy) return;
    setProgress(null);
    const playlistId = youtubePlaylistId(link);
    if (playlistId && !hasYouTubeVideo(link)) {
      await addPlaylist(playlistId);
      return;
    }
    let cast;
    try {
      cast = normalizeCastUrl(link);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That link cannot be played.');
      return;
    }
    await run('link', async () => {
      const queued = await queueLinkInRoom(roomId, cast.title, cast.url);
      if (queued.ok) setLink('');
      return queued;
    }, 'queue');
  };

  const addPlaylist = async (playlistId: string) => {
    setBusy('link');
    setError(null);
    setProgress('Loading the playlist…');
    const playlist = await fetchPlaylist(playlistId);
    if (!playlist.ok) {
      setBusy(null);
      setProgress(null);
      setError(playlist.error);
      return;
    }
    const room = Math.max(0, 50 - queue.length);
    const items = playlist.items.slice(0, room);
    const result = await importPlaylist(roomId, items, (done, total) => setProgress(`Adding ${Math.min(done + 1, total)} of ${total}…`));
    setBusy(null);
    setProgress(result.added ? `Added ${result.added} video${result.added === 1 ? '' : 's'} to the queue.${playlist.items.length > items.length ? ' The queue holds 50.' : ''}` : null);
    if (result.error) setError(result.error);
    if (result.added) {
      setLink('');
      onChanged('queue');
    }
  };

  const saveClip = async () => {
    if (!currentMediaId) return;
    const label = clipLabel.trim();
    if (!label) {
      setError('Give the clip a short label.');
      return;
    }
    const start = Math.max(0, Math.round(getCurrentTime() * 100) / 100);
    const length = Number(clipLength);
    await run('clip', () => createClip(roomId, currentMediaId, start, length > 0 ? start + length : null, label), 'clips');
    setClipLabel('');
  };

  return (
    <section className="watch-panel" aria-label="Queue and clips">
      <header className="watch-panel-header">
        <div role="tablist" aria-label="Watch lists" className="watch-panel-tabs">
          <button type="button" role="tab" aria-selected={tab === 'queue'} onClick={() => setTab('queue')}>Queue{queue.length ? ` · ${queue.length}` : ''}</button>
          {SURFACES.clips && <button type="button" role="tab" aria-selected={tab === 'clips'} onClick={() => setTab('clips')}>Clips{clips.length ? ` · ${clips.length}` : ''}</button>}
        </div>
        <button type="button" onClick={onClose} className="watch-panel-close" aria-label="Close queue and clips"><OmniIcon name="close" size={13} /></button>
      </header>

      {error && <p role="alert" className="watch-panel-error">{error}</p>}
      {progress && <p role="status" className="watch-panel-progress">{progress}</p>}

      <div className="watch-panel-body">
        {status === 'loading' ? (
          <div className="watch-panel-skeleton" aria-busy="true" aria-label="Loading" />
        ) : status === 'error' ? (
          <div className="watch-panel-empty">
            <p>The list could not be loaded.</p>
            <button type="button" className="omni-button omni-button-ghost" onClick={() => { setStatus('loading'); setReload((value) => value + 1); }}>Retry</button>
          </div>
        ) : tab === 'queue' ? (
          <>
          {canControl && (
            <form className="watch-panel-link-form" onSubmit={(event) => { event.preventDefault(); void queueLink(); }}>
              <label className="sr-only" htmlFor="watch-queue-link">Video or stream link</label>
              <input id="watch-queue-link" className="omni-input" type="text" inputMode="url" value={link} onChange={(event) => setLink(event.target.value)} placeholder="Paste a video, stream or playlist link" title="YouTube videos and playlists, Twitch, a Kick .m3u8 stream or a direct video link" />
              <button type="submit" className="omni-button omni-button-primary omni-button-sm" disabled={busy !== null || !link.trim()}>{busy === 'link' ? 'Adding…' : 'Add'}</button>
            </form>
          )}
          {canControl && <SiteLinks className="mb-2" onSearch={onOpenSearch} />}
          {queue.length === 0 ? (
            <div className="watch-panel-empty"><p>The queue is empty.</p><p className="watch-panel-hint">Add items from Cast history with “Queue”.</p></div>
          ) : (
            <ol className="watch-panel-list">
              {queue.map((entry, index) => {
                const title = entry.media?.title || entry.media?.file_name || 'Unavailable media';
                const canRemove = canControl || entry.added_by === currentUserId;
                return (
                  <li key={entry.id} className="watch-panel-row">
                    <span className="watch-panel-index" aria-hidden="true">{index + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="watch-panel-title">{title}</span>
                      <span className="watch-panel-meta">{[entry.media?.artist, `Added by ${nameOf(entry.added_by)}`].filter(Boolean).join(' · ')}</span>
                    </span>
                    {canControl && (
                      <>
                        <button type="button" className="watch-panel-icon" aria-label={`Play ${title} now`} title="Play now" disabled={busy !== null} onClick={() => void playNow(entry)}><OmniIcon name="play" size={13} /></button>
                        <button type="button" className="watch-panel-icon" aria-label={`Move ${title} up`} title="Move up" disabled={busy !== null || index === 0} onClick={() => void run(`move:${entry.id}`, () => moveInQueue(entry.id, index - 1), 'queue')}>↑</button>
                        <button type="button" className="watch-panel-icon" aria-label={`Move ${title} down`} title="Move down" disabled={busy !== null || index === queue.length - 1} onClick={() => void run(`move:${entry.id}`, () => moveInQueue(entry.id, index + 1), 'queue')}>↓</button>
                      </>
                    )}
                    {canRemove && <button type="button" className="watch-panel-icon" aria-label={`Remove ${title} from the queue`} title="Remove" disabled={busy !== null} onClick={() => void run(`remove:${entry.id}`, () => removeFromQueue(entry.id), 'queue')}><OmniIcon name="trash" size={13} /></button>}
                  </li>
                );
              })}
            </ol>
          )}
          </>
        ) : !currentMediaId ? (
          <div className="watch-panel-empty"><p>Clips belong to the media playing now.</p><p className="watch-panel-hint">Cast something to save its best moments.</p></div>
        ) : (
          <>
            <form className="watch-panel-clip-form" onSubmit={(event) => { event.preventDefault(); void saveClip(); }}>
              <label className="sr-only" htmlFor="watch-clip-label">Clip label</label>
              <input id="watch-clip-label" className="omni-input" value={clipLabel} maxLength={120} onChange={(event) => setClipLabel(event.target.value)} placeholder={`Save ${formatPlaybackTime(getCurrentTime())} as…`} />
              <label className="sr-only" htmlFor="watch-clip-length">Clip length</label>
              <select id="watch-clip-length" className="omni-input" value={clipLength} onChange={(event) => setClipLength(event.target.value)}>
                {CLIP_LENGTHS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <button type="submit" className="omni-button omni-button-primary" disabled={busy === 'clip'}>{busy === 'clip' ? 'Saving…' : 'Save clip'}</button>
            </form>
            {clips.length === 0 ? (
              <div className="watch-panel-empty"><p>No clips yet for this media.</p></div>
            ) : (
              <ul className="watch-panel-list">
                {clips.map((clip) => (
                  <li key={clip.id} className="watch-panel-row">
                    <button
                      type="button"
                      className="watch-panel-time"
                      disabled={!canControl}
                      title={canControl ? 'Move the room to this moment' : 'Only Watch controllers can move the room'}
                      aria-label={`Jump to ${clip.label} at ${formatPlaybackTime(clip.start_seconds)}`}
                      onClick={() => onSeek(clip.start_seconds)}
                    >
                      {formatPlaybackTime(clip.start_seconds)}{clip.end_seconds !== null ? `–${formatPlaybackTime(clip.end_seconds)}` : ''}
                    </button>
                    <span className="min-w-0 flex-1">
                      <span className="watch-panel-title">{clip.label}</span>
                      <span className="watch-panel-meta">{nameOf(clip.created_by)}</span>
                    </span>
                    {(canControl || clip.created_by === currentUserId) && (
                      <button type="button" className="watch-panel-icon" aria-label={`Delete clip ${clip.label}`} title="Delete" disabled={busy !== null} onClick={() => void run(`clip:${clip.id}`, () => deleteClip(clip.id), 'clips')}><OmniIcon name="trash" size={13} /></button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </section>
  );
}
