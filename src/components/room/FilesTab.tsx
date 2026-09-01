'use client';

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { getActiveTemporaryMedia, logTemporaryMedia, getSignedStorageUrl } from '@/actions/media';
import { useRoomRealtime } from '@/components/room/RoomRealtimeProvider';
import { uploadFileWithProgress } from '@/lib/storage';
import { createClient } from '@/utils/supabase/client';

interface FilesTabProps {
  roomId: string;
  currentUserRole: string | null;
}

interface TemporaryMedia {
  id: string;
  file_name: string;
  file_url: string;
  media_type: string;
  expires_at: string;
}

interface UploadState {
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

function hoursUntil(expiresAt: string) {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 3_600_000));
}

export default function FilesTab({ roomId, currentUserRole }: FilesTabProps) {
  const { broadcastEvent } = useRoomRealtime();
  const [mediaList, setMediaList] = useState<TemporaryMedia[]>([]);
  const [upload, setUpload] = useState<UploadState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const supabase = createClient();
  const canCast = currentUserRole === 'owner' || currentUserRole === 'admin';

  const loadMedia = useCallback(async () => {
    const result = await getActiveTemporaryMedia(roomId);
    if (result.success && result.media) {
      setMediaList((result.media as TemporaryMedia[]).filter((item) => item.media_type !== 'url'));
      setError(null);
    } else if (result.error) {
      setError(result.error);
    }
  }, [roomId]);

  useEffect(() => {
    // Defer the first request to the async callback so the effect only owns
    // the polling subscription itself.
    const initialLoad = window.setTimeout(() => void loadMedia(), 0);
    const interval = window.setInterval(() => void loadMedia(), 60_000);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(interval);
    };
  }, [loadMedia]);

  const handleFileUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!canCast) {
      setError('Only an approved room owner or admin can upload media.');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setError('Files are capped at 50MB.');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setError(null);
    setUpload({ fileName: file.name, total: file.size, loaded: 0, percent: 0, phase: 'uploading' });
    try {
      const extension = file.name.split('.').pop()?.replace(/[^a-z0-9]/gi, '') || 'bin';
      const filePath = `${roomId}/temp-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`;
      await uploadFileWithProgress(supabase, 'room_attachments', filePath, file, (progress) => {
        setUpload((current) => current ? { ...current, loaded: progress.loaded, percent: progress.percent } : current);
      });

      setUpload((current) => current ? { ...current, loaded: current.total, percent: 100, phase: 'saving' } : current);
      const mediaType = file.type.startsWith('audio/') ? 'audio' : 'video';
      const result = await logTemporaryMedia(roomId, file.name, filePath, mediaType);
      if (!result.success) throw new Error(result.error ?? 'Unable to save the uploaded media.');
      await loadMedia();
    } catch (uploadError) {
      const message = uploadError instanceof Error ? uploadError.message : 'Upload failed.';
      setError(message);
      alert(`Upload failed: ${message}`);
    } finally {
      setUpload(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleCast = async (media: TemporaryMedia) => {
    if (!canCast) return;

    // Check if this is a URL cast (external URL) or file path (needs signed URL)
    let castUrl = media.file_url;
    if (!media.file_url.startsWith('http')) {
      // This is a file path, generate signed URL
      const result = await getSignedStorageUrl(media.file_url, roomId);
      if (!result.success || !result.url) {
        setError(result.error ?? 'Unable to generate playback URL.');
        return;
      }
      castUrl = result.url;
    }

    broadcastEvent('cast', {
      url: castUrl,
      title: media.file_name,
      sourceType: 'upload',
      mediaId: media.id,
      speed: 1,
      playing: true,
    });
  };

  return (
    <div className="flex h-full flex-col border-l border-neutral-800 bg-[#0a0a0a]">
      <div className="flex items-center justify-between border-b border-neutral-800 p-4">
        <h3 className="flex items-center gap-2 text-sm font-bold text-white"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4 text-indigo-400"><path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2Z" /></svg>Uploaded Media <span className="text-[10px] font-normal text-neutral-500">(24h)</span></h3>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {error && <p className="mb-3 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[10px] leading-relaxed text-amber-300">{error}</p>}
        {mediaList.length === 0 ? <p className="mt-10 text-center text-xs text-neutral-500">No temporary media uploaded yet.</p> : <div className="flex flex-col gap-3">{mediaList.map((media) => <div key={media.id} className="group flex flex-col gap-2 rounded-xl border border-neutral-800 bg-[#121212] p-3"><div className="flex items-start justify-between gap-2"><span className="truncate pr-2 text-xs font-bold text-white" title={media.file_name}>{media.file_name}</span><span className="text-[9px] font-bold uppercase tracking-wider text-neutral-500">{media.media_type}</span></div><div className="flex items-center justify-between gap-2"><span className="flex items-center gap-1 text-[10px] text-neutral-500"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3"><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>{hoursUntil(media.expires_at)}h left</span>{canCast && <button type="button" onClick={() => handleCast(media)} className="cursor-pointer rounded bg-indigo-600/20 px-3 py-1.5 text-[10px] font-bold text-indigo-400 transition hover:bg-indigo-600/30">Cast to room</button>}</div></div>)}</div>}
      </div>

      <div className="border-t border-neutral-800 bg-[#111] p-4">
        <input type="file" ref={fileInputRef} onChange={handleFileUpload} className="hidden" accept="video/*,audio/*" />
        {upload ? (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3" aria-live="polite">
            <div className="flex items-center justify-between gap-2 text-xs font-bold text-white"><span className="truncate" title={upload.fileName}>{formatBytes(upload.total)}</span><span className="shrink-0 text-emerald-400">{upload.percent}%</span></div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-neutral-800"><div className="h-full rounded-full bg-emerald-500 transition-[width] duration-150" style={{ width: `${upload.percent}%` }} /></div>
            <p className="mt-2 text-[10px] text-neutral-500">{upload.phase === 'saving' ? 'Finishing upload...' : `${formatBytes(upload.loaded)} of ${formatBytes(upload.total)}`}</p>
          </div>
        ) : <button type="button" onClick={() => fileInputRef.current?.click()} disabled={!canCast} className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-neutral-700 bg-neutral-900 py-2.5 text-xs font-bold text-white transition hover:border-neutral-600 disabled:cursor-not-allowed disabled:opacity-50"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-1m-4-8-4-4m0 0L8 8m4-4v12" /></svg>{canCast ? 'Upload media (under 50MB)' : 'Owner/admin upload only'}</button>}
      </div>
    </div>
  );
}
