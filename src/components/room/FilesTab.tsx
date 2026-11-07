'use client';

import { unwrapAction } from '@/lib/action-result';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cleanupUnregisteredTemporaryMedia, getActiveTemporaryMedia, logTemporaryMedia, resolveRoomMedia } from '@/actions/media';
import { cleanupUnregisteredRoomFile, deleteRoomFile, getRoomFileDownloadUrl, listRoomFiles, registerRoomFile, type RoomFileRow } from '@/actions/room-files';
import { useRoomRealtime } from '@/components/room/RoomRealtimeProvider';
import { ROOM_ATTACHMENT_BUCKET, ROOM_FILE_MIME_TYPES, assertRoomFileInput, createRoomObjectPath } from '@/lib/room-file-contract';
import { validateRoomMediaUpload, withRoomStorageMimeType } from '@/lib/room-file-validation';
import { startUploadFileWithProgress, type StorageUploadTask } from '@/lib/storage';
import { createClient } from '@/utils/supabase/client';
import OmniFileUpload from '@/components/ui/OmniFileUpload';
import { useBookmarks } from '@/components/room/BookmarkButton';

interface FilesTabProps { roomId: string; currentUserRole: string | null; canControlMedia?: boolean; }
interface TemporaryMedia { id: string; file_name: string; file_url: string; media_type: string; mime_type?: string | null; file_size?: number | null; expires_at: string; }
interface UploadState { file: File; fileName: string; path: string; kind: 'file' | 'media'; total: number; loaded: number; percent: number; phase: 'uploading' | 'registering'; }
interface FailedUpload { file: File; kind: 'file' | 'media'; message: string; }

function formatBytes(bytes: number) {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(bytes >= 10 * 1_024 * 1_024 ? 0 : 1)} MB`;
}

function hoursUntil(expiresAt: string) { return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 3_600_000)); }

export default function FilesTab({ roomId, currentUserRole, canControlMedia = false }: FilesTabProps) {
  const { broadcastEvent } = useRoomRealtime();
  const [mediaList, setMediaList] = useState<TemporaryMedia[]>([]);
  const bookmarks = useBookmarks('file', roomId);
  const [files, setFiles] = useState<RoomFileRow[]>([]);
  const [upload, setUpload] = useState<UploadState | null>(null);
  const [failedUpload, setFailedUpload] = useState<FailedUpload | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const activeTask = useRef<StorageUploadTask | null>(null);
  const supabase = createClient();
  const canManageFiles = canControlMedia || currentUserRole === 'owner' || currentUserRole === 'admin';

  const loadMedia = useCallback(async () => {
    const result = await getActiveTemporaryMedia(roomId);
    if (result.success && result.media) { setMediaList((result.media as TemporaryMedia[]).filter((item) => item.media_type !== 'url')); setError(null); }
    else if (result.error) setError(result.error);
  }, [roomId]);

  // Only the first load shows the loading state; background refreshes keep
  // the current list on screen instead of flashing "Loading files…".
  const loadFiles = useCallback(async () => {
    try { setFiles(await listRoomFiles(roomId).then(unwrapAction)); }
    catch (loadError) { setError(loadError instanceof Error ? loadError.message : 'Unable to load room files.'); }
    finally { setLoadingFiles(false); }
  }, [roomId]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => { void loadMedia(); void loadFiles(); }, 0);
    const interval = window.setInterval(() => { void loadMedia(); void loadFiles(); }, 60_000);
    return () => { window.clearTimeout(initialLoad); window.clearInterval(interval); };
  }, [loadFiles, loadMedia]);

  const uploadSelectedFile = async (file: File, kind: 'file' | 'media') => {
    if (!canManageFiles || upload) return;
    let checked: ReturnType<typeof assertRoomFileInput>;
    try {
      // Media is re-typed to its storage contract type (browsers report
      // inconsistent audio/video types); files keep the browser type.
      checked = assertRoomFileInput(kind === 'media' ? withRoomStorageMimeType(file, 'media') : file, kind);
    } catch (validationError) {
      setError(validationError instanceof Error ? validationError.message : 'Unsupported file.');
      return;
    }
    const filePath = createRoomObjectPath(roomId, kind, crypto.randomUUID(), checked.fileName);
    setError(null); setFailedUpload(null);
    setUpload({ file, fileName: checked.fileName, path: filePath, kind, total: checked.size, loaded: 0, percent: 0, phase: 'uploading' });
    try {
      const task = startUploadFileWithProgress(supabase, ROOM_ATTACHMENT_BUCKET, filePath, file, (progress) => {
        setUpload((current) => current ? { ...current, loaded: progress.loaded, percent: progress.percent } : current);
      }, checked.mimeType);
      activeTask.current = task;
      await task.promise;
      setUpload((current) => current ? { ...current, loaded: current.total, percent: 100, phase: 'registering' } : current);
      if (kind === 'file') {
        await registerRoomFile({ roomId, objectPath: filePath, fileName: checked.fileName, mimeType: checked.mimeType, size: checked.size }).then(unwrapAction);
        await loadFiles();
      } else {
        const mediaType = checked.mimeType.startsWith('audio/') ? 'audio' : 'video';
        const result = await logTemporaryMedia(roomId, checked.fileName, filePath, mediaType, checked.mimeType, checked.size);
        if (!result.success) throw new Error(result.error ?? 'Unable to save uploaded media.');
        await loadMedia();
      }
    } catch (uploadError) {
      const message = uploadError instanceof Error ? uploadError.message : 'Upload failed.';
      const cleanup = kind === 'file' ? cleanupUnregisteredRoomFile(roomId, filePath).then(unwrapAction) : cleanupUnregisteredTemporaryMedia(roomId, filePath, 'media');
      await cleanup.catch(() => undefined);
      setFailedUpload({ file, kind, message }); setError(message);
    } finally { activeTask.current = null; setUpload(null); }
  };

  const handlePermanentFiles = async (selected: File[]) => { for (const file of selected) await uploadSelectedFile(file, 'file'); };
  const handleMediaFiles = async (selected: File[]) => {
    for (const file of selected) {
      const validationError = validateRoomMediaUpload(file);
      if (validationError) { setError(validationError); continue; }
      await uploadSelectedFile(file, 'media');
    }
  };
  const handleCast = async (media: TemporaryMedia) => {
    if (!canManageFiles) return;
    // The caster resolves its own URL; Broadcast carries only the media id.
    const resolved = await resolveRoomMedia(roomId, media.id);
    if (!resolved.success || !resolved.media) { setError(resolved.error ?? 'Unable to load this media.'); return; }
    broadcastEvent('cast', { url: resolved.media.url, title: resolved.media.title, subtitleUrl: resolved.media.subtitleUrl, sourceType: resolved.media.sourceType, mediaId: media.id, speed: 1, playing: true });
  };
  const downloadFile = async (file: RoomFileRow) => {
    try { const { url } = await getRoomFileDownloadUrl(file.id).then(unwrapAction); window.open(url, '_blank', 'noopener,noreferrer'); }
    catch (downloadError) { setError(downloadError instanceof Error ? downloadError.message : 'Unable to download this file.'); }
  };
  const removeFile = async (file: RoomFileRow) => {
    try { await deleteRoomFile(file.id).then(unwrapAction); await loadFiles(); }
    catch (deleteError) { setError(deleteError instanceof Error ? deleteError.message : 'Unable to delete this file.'); }
  };

  return <div className="chat-panel flex h-full flex-col border-l border-white/10">
    <div className="chat-topbar"><h3 className="text-sm font-bold text-white">Room files</h3></div>
    <div className="chat-scroller space-y-6">
      {error && <p role="alert" className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[10px] leading-relaxed text-amber-300">{error}</p>}
      <section aria-labelledby="permanent-files-heading"><div className="mb-3"><h4 id="permanent-files-heading" className="text-xs font-bold text-white">Permanent library</h4><p className="text-[10px] text-neutral-500">Private to this room. 500 MB maximum.</p></div>
        {loadingFiles ? <p className="py-4 text-center text-xs text-neutral-500">Loading files…</p> : files.length === 0 ? <p className="rounded-xl border border-dashed border-neutral-800 px-3 py-5 text-center text-xs text-neutral-500">No permanent files yet.</p> : <div className="space-y-2">{files.map((file) => <div key={file.id} className="rounded-xl border border-neutral-800 bg-[#121212] p-3"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="truncate text-xs font-bold text-white" title={file.original_name}>{file.original_name}</p><p className="mt-1 text-[10px] text-neutral-500">{file.mime_type} · {formatBytes(file.size_bytes)}</p></div><div className="flex shrink-0 gap-2"><button type="button" onClick={() => void downloadFile(file)} className="rounded bg-indigo-600/20 px-2 py-1 text-[10px] font-bold text-indigo-300 hover:bg-indigo-600/30">Download</button><button type="button" aria-pressed={bookmarks.saved.has(file.id)} disabled={bookmarks.busy === file.id} aria-label={bookmarks.saved.has(file.id) ? `Remove ${file.original_name} from saved` : `Save ${file.original_name}`} onClick={() => void bookmarks.toggle(roomId, file.id)} className="rounded bg-white/10 px-2 py-1 text-[10px] font-bold text-neutral-200 hover:bg-white/20">{bookmarks.saved.has(file.id) ? 'Saved' : 'Save'}</button>{canManageFiles && <button type="button" onClick={() => void removeFile(file)} className="rounded bg-red-500/10 px-2 py-1 text-[10px] font-bold text-red-300 hover:bg-red-500/20">Delete</button>}</div></div>{file.retention_state === 'delete_pending' && <p className="mt-2 text-[10px] text-amber-300">Deletion is awaiting a retry.</p>}</div>)}</div>}
      </section>
      <section aria-labelledby="temporary-media-heading"><div className="mb-3"><h4 id="temporary-media-heading" className="text-xs font-bold text-white">Temporary cast media</h4><p className="text-[10px] text-neutral-500">Expires from the server-authoritative room deadline.</p></div>
        {mediaList.length === 0 ? <p className="rounded-xl border border-dashed border-neutral-800 px-3 py-5 text-center text-xs text-neutral-500">No temporary media uploaded yet.</p> : <div className="space-y-2">{mediaList.map((media) => <div key={media.id} className="rounded-xl border border-neutral-800 bg-[#121212] p-3"><div className="flex items-start justify-between gap-2"><span className="truncate pr-2 text-xs font-bold text-white" title={media.file_name}>{media.file_name}</span><span className="text-[9px] font-bold uppercase tracking-wider text-neutral-500">{media.media_type}</span></div><p className="mt-1 text-[10px] text-neutral-500">{media.mime_type ?? 'Legacy media'}{typeof media.file_size === 'number' ? ` · ${formatBytes(media.file_size)}` : ''}</p><div className="mt-2 flex items-center justify-between gap-2"><span className="text-[10px] text-neutral-500">{hoursUntil(media.expires_at)}h left</span>{canManageFiles && <button type="button" onClick={() => void handleCast(media)} className="rounded bg-indigo-600/20 px-3 py-1.5 text-[10px] font-bold text-indigo-400 hover:bg-indigo-600/30">Cast to room</button>}</div></div>)}</div>}
      </section>
    </div>
    <div className="message-composer space-y-3">
      {upload ? <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3" aria-live="polite"><div className="flex items-center justify-between gap-2 text-xs font-bold text-white"><span className="truncate" title={upload.fileName}>{upload.fileName}</span><span className="shrink-0 text-emerald-400">{upload.percent}%</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-neutral-800"><div className="h-full rounded-full bg-emerald-500 transition-[width] duration-150" style={{ width: `${upload.percent}%` }} /></div><div className="mt-2 flex items-center justify-between gap-3 text-[10px] text-neutral-500"><span>{upload.phase === 'registering' ? 'Verifying private upload…' : `${formatBytes(upload.loaded)} of ${formatBytes(upload.total)}`}</span><button type="button" onClick={() => activeTask.current?.cancel()} disabled={upload.phase !== 'uploading'} className="font-bold text-amber-300 disabled:opacity-50">Cancel</button></div></div> : <><OmniFileUpload onFilesSelected={(selected) => void handlePermanentFiles(selected)} disabled={!canManageFiles} accept={[...ROOM_FILE_MIME_TYPES, '.flac'].join(',')} label={canManageFiles ? 'Add permanent room files' : 'Owner/admin upload only'} helper="Private PDF, text, image, audio including FLAC, or video · 500 MB max" /><OmniFileUpload onFilesSelected={(selected) => void handleMediaFiles(selected)} disabled={!canManageFiles} accept="audio/flac,.flac,audio/*,video/*" label={canManageFiles ? 'Upload temporary cast media' : 'Owner/admin upload only'} helper="Private audio/video including FLAC · 500 MB max · expires with this room" /></>}
      {failedUpload && !upload && <div className="flex items-center justify-between gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[10px] text-red-200"><span className="min-w-0 truncate">{failedUpload.message}</span><button type="button" onClick={() => void uploadSelectedFile(failedUpload.file, failedUpload.kind)} className="shrink-0 font-bold text-red-100 underline">Retry</button></div>}
    </div>
  </div>;
}
