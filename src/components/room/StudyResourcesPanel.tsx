'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import dynamic from 'next/dynamic';
import { getActiveTemporaryMedia, logCastHistory, resolveRoomMedia } from '@/actions/media';
import { useRoomRealtime } from '@/components/room/RoomRealtimeProvider';
import { useAnnounce, useHintedLoad, useMemberNames, useRoomCapabilities, formatDuration } from '@/lib/collab-hooks';
import { youTubeId } from '@/lib/collab-model';
import {
  addResource, addResourceNote, deleteResource, deleteResourceNote, listProgress, listResourceNotes, listResources, saveProgress,
  type ResourceNote, type ResourceProgress, type StudyResource,
} from '@/lib/collab-data';

const Player = dynamic(() => import('react-player').then((module) => module.default), { ssr: false });
type MediaOption = { id: string; label: string };
const PROGRESS_SAVE_MS = 10_000;

// Study resources (Action 12): YouTube lectures, uploaded lecture media and
// links. Each member watches at their own pace (personal "continue watching"
// progress), adds timestamped notes, or casts the resource to the room's
// Watch stage to watch together (watch_control required, server-checked).
export default function StudyResourcesPanel({ roomId, onOpenWatch }: { roomId: string; onOpenWatch?: () => void }) {
  const { currentUserId, canControlMedia, broadcastEvent } = useRoomRealtime();
  const capabilities = useRoomCapabilities(roomId);
  const names = useMemberNames(roomId);
  const announce = useAnnounce();
  const [resources, setResources] = useState<StudyResource[]>([]);
  const [progress, setProgress] = useState<Map<string, ResourceProgress>>(() => new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<StudyResource | null>(null);
  const [kind, setKind] = useState<StudyResource['kind']>('youtube');
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [mediaId, setMediaId] = useState('');
  const [mediaOptions, setMediaOptions] = useState<MediaOption[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [list, mine] = await Promise.all([listResources(roomId), listProgress(roomId)]);
    setLoading(false);
    if (!list.ok) { setError(list.error); return; }
    setResources(list.data);
    if (mine.ok) setProgress(new Map(mine.data.map((row) => [row.resource_id, row])));
    setSelected((current) => (current ? list.data.find((item) => item.id === current.id) ?? null : current));
    setError(null);
  }, [roomId]);
  useHintedLoad(['resources'], () => { void load(); });

  useEffect(() => {
    if (kind !== 'media') return;
    let active = true;
    void getActiveTemporaryMedia(roomId).then((result) => {
      if (!active || !result.success || !result.media) return;
      setMediaOptions((result.media as Array<{ id: string; media_type: string; file_name: string; title: string | null }>).filter((item) => item.media_type !== 'url').map((item) => ({ id: item.id, label: item.title || item.file_name })));
    });
    return () => { active = false; };
  }, [kind, roomId]);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (kind === 'youtube' && !youTubeId(url)) { setError('Paste a YouTube video link (youtube.com/watch?v=… or youtu.be/…).'); return; }
    setBusy(true);
    const result = await addResource(roomId, kind, title || (kind === 'media' ? mediaOptions.find((option) => option.id === mediaId)?.label ?? '' : ''), kind === 'media' ? null : url, kind === 'media' ? mediaId : null);
    setBusy(false);
    if (!result.ok) { setError(result.error); return; }
    setTitle(''); setUrl(''); setMediaId(''); setError(null); announce('resources'); void load();
  };

  return (
    <section className="study-resources" aria-label="Study resources">
      <aside className="study-resources-list">
        {capabilities.study && (
          <form className="collab-form" onSubmit={(event) => void add(event)} aria-label="Add a study resource">
            <label className="collab-label">Type
              <select className="omni-input" value={kind} onChange={(event) => setKind(event.target.value as StudyResource['kind'])}>
                <option value="youtube">YouTube lecture</option>
                <option value="media">Lecture media in this room</option>
                <option value="link">Link</option>
              </select>
            </label>
            {kind === 'media' ? (
              <label className="collab-label">Media
                <select className="omni-input" value={mediaId} onChange={(event) => setMediaId(event.target.value)} required>
                  <option value="">Choose uploaded media…</option>
                  {mediaOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
              </label>
            ) : (
              <label className="collab-label">Link
                <input className="omni-input" type="url" inputMode="url" value={url} maxLength={2000} onChange={(event) => setUrl(event.target.value)} placeholder={kind === 'youtube' ? 'https://www.youtube.com/watch?v=…' : 'https://…'} required />
              </label>
            )}
            <label className="collab-label">Title
              <input className="omni-input" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} placeholder="Lecture 3: Thermodynamics" required={kind !== 'media'} />
            </label>
            <button type="submit" className="omni-button omni-button-primary" disabled={busy} aria-busy={busy}>{busy ? 'Adding…' : 'Add resource'}</button>
          </form>
        )}
        {error && <p role="alert" className="collab-error">{error} <button type="button" className="collab-link" onClick={() => void load()}>Retry</button></p>}
        {loading ? <div className="collab-skeleton" aria-label="Loading resources" /> : resources.length === 0 ? <p className="collab-empty">No resources yet.</p> : (
          <ul className="collab-list">
            {resources.map((resource) => {
              const mine = progress.get(resource.id);
              return (
                <li key={resource.id}>
                  <button type="button" className={`study-resource ${selected?.id === resource.id ? 'is-active' : ''}`} aria-current={selected?.id === resource.id ? 'true' : undefined} onClick={() => setSelected(resource)}>
                    <span className="collab-badge">{resource.kind === 'youtube' ? 'YouTube' : resource.kind === 'media' ? 'Lecture' : 'Link'}</span>
                    <span className="collab-card-title">{resource.title}</span>
                    <span className="collab-meta">{names.get(resource.added_by) ?? 'Member'}{mine && mine.position_seconds > 5 ? ` · continue at ${formatDuration(mine.position_seconds)}` : ''}</span>
                    {mine?.duration_seconds ? <span className="study-resource-progress" aria-hidden="true"><span style={{ width: `${Math.min(100, (mine.position_seconds / mine.duration_seconds) * 100)}%` }} /></span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </aside>
      <div className="study-resources-viewer">
        {selected ? (
          <ResourceViewer
            key={selected.id}
            roomId={roomId}
            resource={selected}
            startAt={progress.get(selected.id)?.position_seconds ?? 0}
            canRemove={selected.added_by === currentUserId || capabilities.manageMembers}
            canManageNotes={capabilities.manageMembers}
            canCast={canControlMedia}
            names={names}
            onRemoved={() => { setSelected(null); announce('resources'); void load(); }}
            onProgress={(row) => setProgress((current) => new Map(current).set(row.resource_id, row))}
            onCast={async (position) => {
              let castMediaId = selected.media_id;
              if (!castMediaId && selected.url) {
                const logged = await logCastHistory(roomId, selected.title, selected.url);
                if (!logged.success || !logged.mediaId) return logged.error ?? 'Unable to cast this resource.';
                castMediaId = logged.mediaId;
              }
              if (!castMediaId) return 'Unable to cast this resource.';
              const resolved = await resolveRoomMedia(roomId, castMediaId);
              if (!resolved.success || !resolved.media) return resolved.error ?? 'Unable to cast this resource.';
              broadcastEvent('cast', { url: resolved.media.url, title: resolved.media.title, subtitleUrl: resolved.media.subtitleUrl, sourceType: resolved.media.sourceType, mediaId: castMediaId, speed: 1, playing: true, time: position });
              onOpenWatch?.();
              return null;
            }}
          />
        ) : <div className="collab-empty study-resources-empty">Choose a resource to watch, continue where you left off, or add timestamped notes.</div>}
      </div>
    </section>
  );
}

type ViewerProps = {
  roomId: string;
  resource: StudyResource;
  startAt: number;
  canRemove: boolean;
  canManageNotes: boolean;
  canCast: boolean;
  names: Map<string, string>;
  onRemoved: () => void;
  onProgress: (row: ResourceProgress) => void;
  onCast: (position: number) => Promise<string | null>;
};

function ResourceViewer({ roomId, resource, startAt, canRemove, canManageNotes, canCast, names, onRemoved, onProgress, onCast }: ViewerProps) {
  const { currentUserId } = useRoomRealtime();
  const announce = useAnnounce();
  const playerRef = useRef<HTMLVideoElement | null>(null);
  const [src, setSrc] = useState<string | null>(resource.kind === 'youtube' ? resource.url : null);
  const [notes, setNotes] = useState<ResourceNote[]>([]);
  const [body, setBody] = useState('');
  const [scope, setScope] = useState<ResourceNote['scope']>('room');
  const [position, setPosition] = useState(startAt);
  const [status, setStatus] = useState<string | null>(null);
  const lastSavedRef = useRef(0);
  const restoredRef = useRef(false);

  const loadNotes = useCallback(async () => {
    const result = await listResourceNotes(resource.id);
    if (result.ok) setNotes(result.data); else setStatus(result.error);
  }, [resource.id]);
  useHintedLoad(['resources'], () => { void loadNotes(); });

  useEffect(() => {
    if (resource.kind !== 'media' || !resource.media_id) return;
    let active = true;
    void resolveRoomMedia(roomId, resource.media_id).then((result) => {
      if (!active) return;
      if (result.success && result.media) setSrc(result.media.url); else setStatus(result.error ?? 'This lecture media is no longer available.');
    });
    return () => { active = false; };
  }, [resource.kind, resource.media_id, roomId]);

  const persist = useCallback((time: number, force = false) => {
    const now = Date.now();
    if (!force && now - lastSavedRef.current < PROGRESS_SAVE_MS) return;
    lastSavedRef.current = now;
    const duration = playerRef.current?.duration;
    const total = duration && Number.isFinite(duration) ? duration : null;
    void saveProgress(resource.id, time, total).then((result) => {
      if (result.ok) onProgress({ resource_id: resource.id, position_seconds: time, duration_seconds: total, updated_at: new Date().toISOString() });
    });
  }, [onProgress, resource.id]);

  const seek = (time: number) => {
    if (playerRef.current) playerRef.current.currentTime = time;
    setPosition(time);
  };

  const addNote = async (event: FormEvent) => {
    event.preventDefault();
    const at = playerRef.current?.currentTime ?? position;
    const result = await addResourceNote(resource.id, at, body, scope);
    if (!result.ok) { setStatus(result.error); return; }
    setBody(''); setStatus(null);
    if (scope === 'room') announce('resources');
    void loadNotes();
  };

  return (
    <div className="study-resource-viewer">
      <div className="study-resource-head">
        <h3 className="collab-card-title">{resource.title}</h3>
        <div className="collab-row">
          {canCast && resource.kind !== 'link' && <button type="button" className="omni-button omni-button-primary" onClick={() => void onCast(playerRef.current?.currentTime ?? position).then((message) => setStatus(message))}>Watch together</button>}
          {canRemove && <button type="button" className="collab-link is-danger" onClick={() => void deleteResource(resource.id).then((result) => { if (result.ok) onRemoved(); else setStatus(result.error); })}>Remove</button>}
        </div>
      </div>
      {resource.kind === 'link' ? (
        <p className="collab-text"><a href={resource.url ?? '#'} target="_blank" rel="noopener noreferrer nofollow" className="collab-link">Open link in a new tab</a> — timestamped notes below use 0:00.</p>
      ) : src ? (
        <div className="study-resource-player">
          <Player
            ref={(node) => { playerRef.current = node as HTMLVideoElement | null; }}
            src={src}
            controls
            width="100%"
            height="100%"
            onLoadedMetadata={() => {
              if (!restoredRef.current && startAt > 5 && playerRef.current) { playerRef.current.currentTime = startAt; restoredRef.current = true; }
            }}
            onTimeUpdate={() => { const time = playerRef.current?.currentTime ?? 0; setPosition(time); persist(time); }}
            onPause={() => persist(playerRef.current?.currentTime ?? 0, true)}
            onError={() => setStatus('This resource could not be played here. Try opening it directly.')}
          />
        </div>
      ) : <div className="collab-skeleton" aria-label="Loading player" />}
      {startAt > 5 && <p className="collab-meta">Your progress is saved: continue at {formatDuration(startAt)}. <button type="button" className="collab-link" onClick={() => seek(startAt)}>Jump there</button></p>}
      {status && <p role="status" className="collab-meta">{status}</p>}

      <form className="collab-form" onSubmit={(event) => void addNote(event)} aria-label="Add a timestamped note">
        <label className="collab-label" htmlFor={`resource-note-${resource.id}`}>Note at {formatDuration(position)}</label>
        <textarea id={`resource-note-${resource.id}`} className="omni-input collab-textarea" value={body} maxLength={2000} onChange={(event) => setBody(event.target.value)} placeholder="Key formula explained here…" required />
        <div className="collab-row">
          <select className="omni-input collab-number" value={scope} onChange={(event) => setScope(event.target.value as ResourceNote['scope'])} aria-label="Who can see this note">
            <option value="room">Room</option>
            <option value="personal">Only me</option>
          </select>
          <button type="submit" className="omni-button omni-button-primary" disabled={!body.trim()}>Add note</button>
        </div>
      </form>
      {notes.length === 0 ? <p className="collab-empty">No timestamped notes yet.</p> : (
        <ul className="collab-list" aria-label="Timestamped notes">
          {notes.map((note) => (
            <li key={note.id} className="collab-card">
              <button type="button" className="collab-link study-note-time" onClick={() => seek(Number(note.at_seconds))} aria-label={`Jump to ${formatDuration(Number(note.at_seconds))}`}>{formatDuration(Number(note.at_seconds))}</button>
              <span className="collab-meta">{note.user_id === currentUserId ? 'You' : names.get(note.user_id) ?? 'Member'}{note.scope === 'personal' ? ' · only you' : ''}</span>
              <p className="collab-text">{note.body}</p>
              {(note.user_id === currentUserId || (note.scope === 'room' && canManageNotes)) && (
                <button type="button" className="collab-link is-danger" onClick={() => void deleteResourceNote(note.id).then((result) => { if (!result.ok) setStatus(result.error); else { if (note.scope === 'room') announce('resources'); void loadNotes(); } })}>Delete</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
