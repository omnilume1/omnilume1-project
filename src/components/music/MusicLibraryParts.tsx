'use client';

import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useMusicLibrary, type ShareTarget, type UploadShare } from '@/hooks/useMusicLibrary';
import { audioExtension, MUSIC_MAX_ACTIVE_FILES, MUSIC_MAX_TOTAL_BYTES } from '@/lib/music-upload-validation';
import { MusicIcon } from './MusicIcon';

type Job = { name: string; state: string; percent: number; error?: string };
const baseName = (name: string) => name.replace(/\.[^.]+$/, '').toLowerCase();
const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

export function UploadPanel() {
  const library = useMusicLibrary();
  const input = useRef<HTMLInputElement>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const start = async (picked: File[]) => {
    if (busy || picked.length === 0) return;
    const lrc = new Map<string, File>(picked.filter((file) => /\.lrc$/i.test(file.name)).map((file) => [baseName(file.name), file]));
    const audio = picked.filter((file) => !/\.lrc$/i.test(file.name));
    if (audio.length === 0) {
      setJobs([{ name: picked[0].name, state: 'Skipped', percent: 0, error: 'Pick an audio file to go with the .lrc.' }]);
      return;
    }
    setBusy(true);
    setJobs(audio.map((file) => ({ name: file.name, state: 'Waiting', percent: 0 })));
    const update = (i: number, patch: Partial<Job>) => setJobs((current) => current.map((job, at) => (at === i ? { ...job, ...patch } : job)));
    for (const [i, file] of audio.entries()) {
      try {
        if (!audioExtension(file.name)) throw new Error('Unsupported format. Use MP3, FLAC, OGG, Opus, WAV, M4A, AAC or WebM.');
        const sidecar = lrc.get(baseName(file.name));
        const lrcText = sidecar ? (await sidecar.text()).slice(0, 20_000) : null;
        await library.uploadFile(file, lrcText, ({ stage, percent }) => update(i, {
          state: stage === 'reading' ? 'Reading tags' : stage === 'uploading' ? `Uploading ${percent}%` : 'Saving',
          percent,
        }));
        update(i, { state: 'Added', percent: 100 });
      } catch (error) {
        update(i, { state: 'Not added', error: error instanceof Error ? error.message : 'Upload failed.' });
      }
    }
    await library.reload();
    setBusy(false);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    void start([...event.dataTransfer.files]);
  };

  return (
    <section className="mu-upload" aria-labelledby="mu-upload-title">
      <div
        className={`mu-dropzone ${dragging ? 'is-dragging' : ''}`}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <MusicIcon name="note" size={28} />
        <h2 id="mu-upload-title">Add your music</h2>
        <p>Drop audio files here (MP3, FLAC, OGG, Opus, WAV, M4A, AAC, WebM, up to 50 MB each). Add a matching <code>.lrc</code> file for synced lyrics.</p>
        <button type="button" className="mu-pill-button is-key" onClick={() => input.current?.click()} disabled={busy}>Choose Files</button>
        <input ref={input} type="file" multiple hidden accept=".mp3,.flac,.ogg,.oga,.opus,.wav,.m4a,.aac,.webm,.lrc,audio/*" onChange={(event) => { void start([...(event.target.files ?? [])]); event.target.value = ''; }} />
        <p className="mu-fine">
          Private to you. Each upload is deleted 7 days after you add it. {library.usage.files} of {MUSIC_MAX_ACTIVE_FILES} files · {mb(library.usage.bytes)} of {mb(MUSIC_MAX_TOTAL_BYTES)}
        </p>
      </div>
      {jobs.length ? (
        <ul className="mu-jobs" aria-live="polite">
          {jobs.map((job) => (
            <li key={job.name} className={job.error ? 'is-error' : ''}>
              <span className="mu-job-name">{job.name}</span>
              <span className="mu-job-state">{job.error ?? job.state}</span>
              {!job.error && job.percent > 0 && job.percent < 100 ? <progress max={100} value={job.percent} aria-label={`${job.name} upload`} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function ShareDialog() {
  const library = useMusicLibrary();
  const { shareTrack: track, shareTargets, listShares, openShare } = library;
  const dialog = useRef<HTMLDialogElement>(null);
  const [targets, setTargets] = useState<ShareTarget[] | null>(null);
  const [shares, setShares] = useState<UploadShare[]>([]);
  const [attest, setAttest] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element || !track?.uploadId) return;
    if (!element.open) element.showModal();
    let alive = true;
    Promise.all([shareTargets(), listShares(track.uploadId)])
      .then(([nextTargets, nextShares]) => {
        if (!alive) return;
        setTargets(nextTargets);
        setShares(nextShares);
      })
      .catch((loadError: unknown) => alive && setError(loadError instanceof Error ? loadError.message : 'Could not load.'));
    return () => { alive = false; };
  }, [track, shareTargets, listShares]);

  const reset = useCallback(() => {
    openShare(null);
    setTargets(null);
    setShares([]);
    setAttest(false);
    setError(null);
  }, [openShare]);

  // Esc closes the dialog natively; the close button also resets directly, so the
  // state never depends on the async "close" event alone.
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.addEventListener('close', reset);
    return () => element.removeEventListener('close', reset);
  }, [track, reset]);

  if (!track?.uploadId) return null;
  const uploadId = track.uploadId;
  const toggle = async (target: ShareTarget) => {
    const existing = shares.find((item) => item.target_kind === target.target_kind && item.target_id === target.target_id);
    setPending(target.target_id);
    setError(null);
    try {
      if (existing) await library.unshare(existing.share_id);
      else await library.share(uploadId, target);
      setShares(await library.listShares(uploadId));
    } catch (shareError) {
      setError(shareError instanceof Error ? shareError.message : 'Could not update sharing.');
    } finally {
      setPending(null);
    }
  };

  return (
    <dialog ref={dialog} className="mu-modal" aria-labelledby="mu-share-title">
      <header className="mu-modal-header">
        <h2 id="mu-share-title">Share “{track.title}”</h2>
        <button type="button" className="mu-icon-button" aria-label="Close" onClick={() => { dialog.current?.close(); reset(); }}><MusicIcon name="close" size={16} /></button>
      </header>
      <p className="mu-muted">Only members of the rooms and groups you pick can play it, until it expires or you stop sharing. It is never public.</p>
      <label className="mu-check">
        <input type="checkbox" checked={attest} onChange={(event) => setAttest(event.target.checked)} />
        <span>I have the right to share this file.</span>
      </label>
      {error ? <p className="mu-error" role="alert">{error}</p> : null}
      {targets === null ? <p className="mu-muted">Loading your rooms and groups…</p> : targets.length === 0 ? (
        <p className="mu-muted">You aren’t in any rooms or groups you can share to.</p>
      ) : (
        <ul className="mu-targets">
          {targets.map((target) => {
            const on = shares.some((item) => item.target_kind === target.target_kind && item.target_id === target.target_id);
            return (
              <li key={`${target.target_kind}-${target.target_id}`}>
                <span><strong>{target.name}</strong> <span className="mu-badge">{target.target_kind === 'room' ? 'Room' : 'Group'}</span></span>
                <button
                  type="button"
                  className={`mu-text-button ${on ? 'is-destructive' : ''}`}
                  disabled={pending !== null || (!on && !attest)}
                  onClick={() => void toggle(target)}
                >
                  {pending === target.target_id ? '…' : on ? 'Stop Sharing' : 'Share'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </dialog>
  );
}

export function NewPlaylistForm() {
  const library = useMusicLibrary();
  const router = useRouter();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    try {
      const id = await library.createPlaylist(name);
      setName('');
      router.push(`/music/playlist/${id}`);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Could not create the playlist.');
    }
  };
  return (
    <form className="mu-inline-form" onSubmit={submit}>
      <input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} placeholder="New playlist name" aria-label="New playlist name" />
      <button type="submit" className="mu-pill-button is-key" disabled={!name.trim()}>Create</button>
      {error ? <p className="mu-error" role="alert">{error}</p> : null}
    </form>
  );
}
