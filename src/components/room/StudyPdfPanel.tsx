'use client';

import { unwrapAction } from '@/lib/action-result';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getRoomFileDownloadUrl, type RoomFileRow } from '@/actions/room-files';
import { createPdfAnnotation, deletePdfAnnotation, listPdfAnnotations, listStudyPdfFiles, type PdfAnnotation } from '@/actions/study-collaboration';
import { useRoomRealtime } from '@/components/room/RoomRealtimeProvider';
import { useAnnounce, useHintedLoad, useMemberNames } from '@/lib/collab-hooks';

const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Unable to update the study workspace.';

// Shared PDFs (Actions 10 + 12): private viewer through each member's own
// authorized signed URL, page annotations that update live, and an optional
// "present" mode: the presenter's file id and page number (ids only) travel
// over the study topic and members who chose "Follow" jump with them. Every
// follower still opens the file with their own authorization.
export default function StudyPdfPanel({ roomId }: { roomId: string }) {
  const { currentUserId, sendRoomEvent, subscribeRoomEvents } = useRoomRealtime();
  const names = useMemberNames(roomId);
  const announce = useAnnounce();
  const [files, setFiles] = useState<RoomFileRow[]>([]);
  const [selected, setSelected] = useState<RoomFileRow | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(100);
  const [annotation, setAnnotation] = useState('');
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [presenting, setPresenting] = useState(false);
  const [following, setFollowing] = useState(false);
  const [presenter, setPresenter] = useState<{ userId: string; fileId: string; page: number; at: number } | null>(null);
  const filesRef = useRef<RoomFileRow[]>([]);
  useEffect(() => { filesRef.current = files; }, [files]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(interval);
  }, []);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    try { const next = await listStudyPdfFiles(roomId).then(unwrapAction); setFiles(next); setError(null); }
    catch (loadError) { setError(errorMessage(loadError)); }
    finally { setLoading(false); }
  }, [roomId]);

  const open = useCallback(async (file: RoomFileRow, atPage = 1) => {
    try {
      setSelected(file); setUrl(null); setPage(atPage);
      const [{ url: signedUrl }, nextAnnotations] = await Promise.all([getRoomFileDownloadUrl(file.id).then(unwrapAction), listPdfAnnotations(roomId, file.id).then(unwrapAction)]);
      setUrl(signedUrl); setAnnotations(nextAnnotations); setError(null);
    } catch (openError) { setError(errorMessage(openError)); }
  }, [roomId]);

  useEffect(() => { const timeout = window.setTimeout(() => { void loadFiles(); }, 0); return () => window.clearTimeout(timeout); }, [loadFiles]);

  const selectedId = selected?.id ?? null;
  useHintedLoad(['pdf'], () => {
    if (!selectedId) return;
    void listPdfAnnotations(roomId, selectedId).then(unwrapAction).then(setAnnotations).catch(() => undefined);
  });

  // Presenter → followers: file id + page only.
  useEffect(() => {
    if (presenting && selectedId) sendRoomEvent('pdf_follow', { fileId: selectedId, page });
  }, [page, presenting, selectedId, sendRoomEvent]);
  useEffect(() => {
    if (!presenting || !selectedId) return;
    const interval = window.setInterval(() => sendRoomEvent('pdf_follow', { fileId: selectedId, page }), 10_000);
    return () => window.clearInterval(interval);
  }, [page, presenting, selectedId, sendRoomEvent]);
  useEffect(() => subscribeRoomEvents((event) => {
    if (event.type !== 'pdf_follow' || event.senderId === currentUserId) return;
    setPresenter({ userId: event.senderId, fileId: String(event.payload.fileId), page: Number(event.payload.page), at: Date.now() });
  }), [currentUserId, subscribeRoomEvents]);
  useEffect(() => {
    if (!following || !presenter) return;
    const file = filesRef.current.find((item) => item.id === presenter.fileId);
    if (!file) return;
    const timeout = window.setTimeout(() => {
      if (selectedId !== presenter.fileId) void open(file, presenter.page);
      else setPage(presenter.page);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [following, open, presenter, selectedId]);

  const addAnnotation = async () => {
    if (!selected || !annotation.trim() || adding) return;
    setAdding(true);
    try { const item = await createPdfAnnotation(roomId, selected.id, page, annotation).then(unwrapAction); setAnnotations((items) => [...items, item]); setAnnotation(''); setError(null); announce('pdf'); }
    catch (annotationError) { setError(errorMessage(annotationError)); }
    finally { setAdding(false); }
  };
  const removeAnnotation = async (id: string) => {
    try { await deletePdfAnnotation(roomId, id).then(unwrapAction); setAnnotations((items) => items.filter((item) => item.id !== id)); announce('pdf'); }
    catch (deleteError) { setError(errorMessage(deleteError)); }
  };

  const presenterName = presenter ? names.get(presenter.userId) ?? 'A member' : null;
  const presenterFile = presenter ? files.find((file) => file.id === presenter.fileId) : null;
  const presenterLive = Boolean(presenter && now - presenter.at < 25_000);

  return <section className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-[15rem_minmax(0,1fr)_15rem]" aria-label="Private room PDF viewer">
    <aside className="rounded-xl border border-neutral-800 bg-[#121212] p-3">
      <h3 className="text-xs font-bold text-white">PDF files in this room</h3>
      <p className="mt-1 text-[10px] text-neutral-500">Uses your authorized private file access.</p>
      {loading ? <p className="mt-4 text-xs text-neutral-500">Loading PDFs…</p> : files.length === 0 ? <p className="mt-4 text-xs text-neutral-500">No permitted PDFs are available.</p> : <div className="mt-3 space-y-1">{files.map((file) => <button key={file.id} type="button" onClick={() => void open(file)} aria-current={selected?.id === file.id ? 'true' : undefined} className={`w-full rounded-lg px-3 py-2 text-left text-xs ${selected?.id === file.id ? 'bg-indigo-600/20 text-white' : 'text-neutral-400 hover:bg-white/5'}`}>{file.original_name}</button>)}</div>}
      <button type="button" onClick={() => void loadFiles()} className="mt-4 text-xs font-bold text-indigo-300 underline">Retry file list</button>
      {presenterLive && presenterFile && (
        <div className="mt-4 rounded-lg border border-indigo-500/30 bg-indigo-500/10 p-2 text-xs text-indigo-100" role="status">
          <p><strong>{presenterName}</strong> is presenting {presenterFile.original_name} · page {presenter?.page}</p>
          <label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={following} onChange={(event) => setFollowing(event.target.checked)} /> Follow their page</label>
        </div>
      )}
    </aside>
    <div className="flex min-h-0 flex-col rounded-xl border border-neutral-800 bg-[#121212] p-3">
      {selected && url ? <>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => { setFollowing(false); setPage((value) => Math.max(1, value - 1)); }} className="rounded border border-neutral-700 px-2 py-1 text-xs">Previous page</button>
          <span className="text-xs text-neutral-300" aria-live="polite">Page {page}</span>
          <button type="button" onClick={() => { setFollowing(false); setPage((value) => value + 1); }} className="rounded border border-neutral-700 px-2 py-1 text-xs">Next page</button>
          <button type="button" onClick={() => setPresenting((value) => !value)} aria-pressed={presenting} className={`rounded border px-2 py-1 text-xs ${presenting ? 'border-indigo-400 bg-indigo-600/30 text-white' : 'border-neutral-700'}`}>{presenting ? 'Stop presenting' : 'Present to room'}</button>
          <button type="button" onClick={() => setZoom((value) => Math.max(50, value - 10))} className="ml-auto rounded border border-neutral-700 px-2 py-1 text-xs" aria-label="Zoom out">−</button>
          <span className="text-xs text-neutral-300">{zoom}%</span>
          <button type="button" onClick={() => setZoom((value) => Math.min(200, value + 10))} className="rounded border border-neutral-700 px-2 py-1 text-xs" aria-label="Zoom in">+</button>
        </div>
        <iframe key={`${selected.id}:${page}:${zoom}`} src={`${url}#page=${page}&zoom=${zoom}`} title={`PDF Viewer: ${selected.original_name}`} className="min-h-0 flex-1 rounded bg-white" />
      </> : <div className="flex flex-1 items-center justify-center text-sm text-neutral-500">Choose a permitted PDF to open it.</div>}
      <p className="mt-2 text-[10px] text-neutral-500">{presenting ? 'Presenting: members who follow you see your page.' : 'Native browser PDF controls are used; search, text selection, and advanced annotation tools require a future PDF renderer.'}</p>
    </div>
    <aside className="flex min-h-0 flex-col rounded-xl border border-neutral-800 bg-[#121212] p-3">
      <h3 className="text-xs font-bold text-white">Annotations</h3>
      {selected ? <>
        <label htmlFor="pdf-annotation" className="sr-only">Annotation for current page</label>
        <textarea id="pdf-annotation" value={annotation} onChange={(event) => setAnnotation(event.target.value)} maxLength={10000} placeholder={`Note for page ${page}`} className="mt-3 min-h-20 rounded-lg border border-neutral-800 bg-[#0d0d0d] p-2 text-xs text-white outline-none focus:border-indigo-500" />
        <button type="button" onClick={() => void addAnnotation()} disabled={adding || !annotation.trim()} aria-busy={adding} className="mt-2 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-50">{adding ? 'Adding…' : 'Add annotation'}</button>
        <div className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto">{annotations.length === 0 ? <p className="text-xs text-neutral-500">No annotations yet.</p> : annotations.map((item) => <article key={item.id} className="rounded-lg border border-neutral-800 p-2 text-xs text-neutral-300"><p className="text-[10px] font-bold text-indigo-300"><button type="button" className="underline" onClick={() => setPage(item.page_number)}>Page {item.page_number}</button> · {item.owner_id === currentUserId ? 'You' : names.get(item.owner_id) ?? 'Member'}</p><p className="mt-1 whitespace-pre-wrap">{item.content}</p>{item.owner_id === currentUserId && <button type="button" onClick={() => void removeAnnotation(item.id)} className="mt-2 text-[10px] font-bold text-red-300 underline">Delete</button>}</article>)}</div>
      </> : <p className="mt-3 text-xs text-neutral-500">Open a PDF to view its annotations.</p>}
      <p role="alert" className="mt-3 text-xs text-amber-300">{error}</p>
    </aside>
  </section>;
}
