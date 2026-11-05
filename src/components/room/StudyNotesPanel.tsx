'use client';

import { unwrapAction } from '@/lib/action-result';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createStudyNote, deleteStudyNote, listStudyNotes, updateStudyNote, type StudyNote } from '@/actions/study-collaboration';

const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Unable to update the study workspace.';

export default function StudyNotesPanel({ roomId }: { roomId: string }) {
  const [notes, setNotes] = useState<StudyNote[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saved' | 'conflict' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  // Bumped on every local edit. A save only clears the dirty flag when no edit
  // arrived while it was in flight; otherwise the autosave runs again.
  const revisionRef = useRef(0);

  const select = useCallback((note: StudyNote | null) => {
    setSelectedId(note?.id ?? null); setTitle(note?.title ?? ''); setContent(note?.content ?? '');
    dirtyRef.current = false; setStatus('idle'); setError(null);
  }, []);

  const load = useCallback(async (preferredId?: string) => {
    setLoading(true);
    try {
      const next = await listStudyNotes(roomId).then(unwrapAction);
      setNotes(next);
      const nextSelected = next.find((note) => note.id === (preferredId ?? selectedId)) ?? next[0] ?? null;
      select(nextSelected);
    } catch (loadError) { setError(errorMessage(loadError)); setStatus('error'); }
    finally { setLoading(false); }
  }, [roomId, select, selectedId]);

  useEffect(() => { const timeout = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timeout); }, [load]);

  const save = useCallback(async () => {
    const current = notes.find((note) => note.id === selectedId);
    if (!current || !dirtyRef.current || saving) return;
    const revision = revisionRef.current;
    setSaving(true); setError(null);
    try {
      const updated = await updateStudyNote(current.id, current.version, title.trim() || 'Untitled note', content).then(unwrapAction);
      setNotes((items) => items.map((note) => note.id === updated.id ? updated : note));
      if (revisionRef.current === revision) { dirtyRef.current = false; setStatus('saved'); }
    } catch (saveError) {
      const value = errorMessage(saveError);
      setStatus(value.includes('expected version') ? 'conflict' : 'error'); setError(value);
    } finally { setSaving(false); }
  }, [content, notes, saving, selectedId, title]);

  useEffect(() => {
    if (!selectedId || !dirtyRef.current) return;
    const timeout = window.setTimeout(() => { void save(); }, 900);
    return () => window.clearTimeout(timeout);
  }, [content, save, selectedId, title]);

  const create = async (scope: StudyNote['scope']) => {
    try { const note = await createStudyNote(roomId, scope).then(unwrapAction); setNotes((items) => [note, ...items]); select(note); }
    catch (createError) { setStatus('error'); setError(errorMessage(createError)); }
  };
  const remove = async () => {
    if (!selectedId) return;
    try { await deleteStudyNote(selectedId).then(unwrapAction); const next = notes.filter((note) => note.id !== selectedId); setNotes(next); select(next[0] ?? null); }
    catch (deleteError) { setStatus('error'); setError(errorMessage(deleteError)); }
  };
  const change = (setter: (value: string) => void, value: string) => { setter(value); dirtyRef.current = true; revisionRef.current += 1; setStatus('idle'); };
  // Conflict: another member saved first. Keep the local text and save it on
  // top of their version, or discard it and load theirs.
  const keepMine = async () => {
    try {
      const latest = await listStudyNotes(roomId).then(unwrapAction);
      if (!latest.some((note) => note.id === selectedId)) { setStatus('error'); setError('Another member deleted this note.'); return; }
      setNotes(latest);
      dirtyRef.current = true; revisionRef.current += 1; setStatus('idle'); setError(null);
    } catch (keepError) { setStatus('error'); setError(errorMessage(keepError)); }
  };

  return <section className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[13rem_minmax(0,1fr)]" aria-label="Persistent study notes">
    <aside className="flex min-h-0 flex-col rounded-xl border border-neutral-800 bg-[#121212] p-3">
      <div className="flex flex-wrap gap-2"><button type="button" onClick={() => void create('room')} className="rounded-lg bg-indigo-600 px-3 py-2 text-[10px] font-bold text-white hover:bg-indigo-500">New room note</button><button type="button" onClick={() => void create('personal')} className="rounded-lg border border-neutral-700 px-3 py-2 text-[10px] font-bold text-neutral-200 hover:border-neutral-500">New personal note</button></div>
      <div className="mt-3 min-h-0 flex-1 space-y-1 overflow-y-auto">{loading ? <p className="p-2 text-xs text-neutral-500">Loading notes…</p> : notes.length === 0 ? <p className="p-2 text-xs text-neutral-500">No notes yet.</p> : notes.map((note) => <button key={note.id} type="button" onClick={() => select(note)} className={`w-full rounded-lg px-3 py-2 text-left text-xs ${note.id === selectedId ? 'bg-indigo-600/20 text-white' : 'text-neutral-400 hover:bg-white/5 hover:text-white'}`}><span className="block truncate font-bold">{note.title}</span><span className="mt-1 block text-[9px] uppercase tracking-wider text-neutral-500">{note.scope}</span></button>)}</div>
    </aside>
    <div className="flex min-h-0 flex-col rounded-xl border border-neutral-800 bg-[#121212] p-4">
      {!selectedId ? <div className="flex flex-1 items-center justify-center text-sm text-neutral-500">Create a room or personal note to begin.</div> : <><div className="flex items-center gap-3"><label className="sr-only" htmlFor="study-note-title">Note title</label><input id="study-note-title" value={title} onChange={(event) => change(setTitle, event.target.value)} maxLength={160} className="min-w-0 flex-1 border-b border-neutral-700 bg-transparent pb-2 text-sm font-bold text-white outline-none focus:border-indigo-500" placeholder="Note title" /><button type="button" onClick={() => void save()} disabled={saving} className="rounded-lg bg-emerald-600 px-3 py-2 text-[10px] font-bold text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save changes'}</button><button type="button" onClick={() => void remove()} className="rounded-lg border border-red-500/50 px-3 py-2 text-[10px] font-bold text-red-200 hover:bg-red-500/10">Delete</button></div><label className="sr-only" htmlFor="study-note-content">Note content</label><textarea id="study-note-content" value={content} onChange={(event) => change(setContent, event.target.value)} maxLength={100000} className="mt-4 min-h-0 flex-1 resize-none rounded-lg border border-neutral-800 bg-[#0d0d0d] p-3 text-sm text-white outline-none focus:border-indigo-500" placeholder="Write your study notes…" /></>}
      <p aria-live="polite" className={`mt-3 text-xs ${status === 'conflict' || status === 'error' ? 'text-amber-300' : 'text-neutral-500'}`}>{status === 'saved' ? 'Saved.' : status === 'conflict' ? 'Conflict detected: another member saved this note first. Keep your version or load theirs.' : error ?? (selectedId ? (saving ? 'Saving…' : 'Autosaves after a short pause.') : '')}</p>
      {status === 'conflict' && <div className="mt-2 flex flex-wrap gap-3"><button type="button" onClick={() => void keepMine()} className="text-xs font-bold text-emerald-300 underline">Keep my version</button><button type="button" onClick={() => void load(selectedId ?? undefined)} className="text-xs font-bold text-indigo-300 underline">Load latest (discard mine)</button></div>}
      {status === 'error' && <button type="button" onClick={() => void load(selectedId ?? undefined)} className="mt-2 self-start text-xs font-bold text-indigo-300 underline">Retry / reload latest</button>}
    </div>
  </section>;
}
