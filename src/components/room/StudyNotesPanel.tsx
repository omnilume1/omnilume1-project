'use client';

import { unwrapAction } from '@/lib/action-result';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createStudyNote, deleteStudyNote, listStudyNotes, updateStudyNote, type StudyNote } from '@/actions/study-collaboration';
import { createClient } from '@/utils/supabase/client';
import { useRoomRealtime } from '@/components/room/RoomRealtimeProvider';
import { useAnnounce, useHintedLoad, useMemberNames, useRoomCapabilities } from '@/lib/collab-hooks';
import { listNoteVersions, restoreNoteVersion, setNoteLocked, type NoteVersion } from '@/lib/collab-data';

const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Unable to update the study workspace.';
const EDITING_TTL_MS = 6_000;

// Live shared notes (Actions 10 + 12): version-checked autosave, live updates
// from other members (re-read through the protected RPC on a hint), "who is
// editing" presence, version history with restore, and read-only room notes.
export default function StudyNotesPanel({ roomId }: { roomId: string }) {
  const { currentUserId, sendRoomEvent, subscribeRoomEvents } = useRoomRealtime();
  const capabilities = useRoomCapabilities(roomId);
  const names = useMemberNames(roomId);
  const announce = useAnnounce();
  const [notes, setNotes] = useState<StudyNote[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saved' | 'conflict' | 'error' | 'live'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [editors, setEditors] = useState<Map<string, { noteId: string; at: number }>>(() => new Map());
  const [now, setNow] = useState(() => Date.now());
  const [history, setHistory] = useState<NoteVersion[] | null>(null);
  const [preview, setPreview] = useState<NoteVersion | null>(null);
  const dirtyRef = useRef(false);
  // Bumped on every local edit. A save only clears the dirty flag when no edit
  // arrived while it was in flight; otherwise the autosave runs again.
  const revisionRef = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  const lastEditingSentRef = useRef(0);

  const select = useCallback((note: StudyNote | null) => {
    setSelectedId(note?.id ?? null); setTitle(note?.title ?? ''); setContent(note?.content ?? '');
    dirtyRef.current = false; setStatus('idle'); setError(null); setHistory(null); setPreview(null);
  }, []);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);
  const notesRef = useRef<StudyNote[]>([]);
  useEffect(() => { notesRef.current = notes; }, [notes]);

  // Reads the selection through a ref so this callback (and the initial-load
  // effect below) does not re-run on every selection: a reload that resolved
  // after a new note was opened used to overwrite what had just been typed.
  const load = useCallback(async (preferredId?: string) => {
    setLoading(true);
    try {
      const fetched = await listStudyNotes(roomId).then(unwrapAction);
      // With unsaved edits, keep the open note's known version so the next
      // save still detects a conflict instead of overwriting newer work.
      const keepLocal = preferredId === undefined && dirtyRef.current ? notesRef.current.find((note) => note.id === selectedIdRef.current) : undefined;
      const next = keepLocal ? fetched.map((note) => (note.id === keepLocal.id ? keepLocal : note)) : fetched;
      setNotes(next);
      const wanted = preferredId ?? selectedIdRef.current;
      const nextSelected = next.find((note) => note.id === wanted) ?? next[0] ?? null;
      // Unsaved edits on the open note are kept (explicit "load latest" passes preferredId).
      if (!(preferredId === undefined && nextSelected && nextSelected.id === selectedIdRef.current && dirtyRef.current)) select(nextSelected);
    } catch (loadError) { setError(errorMessage(loadError)); setStatus('error'); }
    finally { setLoading(false); }
  }, [roomId, select]);

  useEffect(() => { const timeout = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timeout); }, [load]);

  // Another member saved: re-read the list and, when this member has no
  // unsaved edits on the open note, show their version straight away.
  const refresh = useCallback(async () => {
    const { data, error: refreshError } = await createClient().rpc('list_study_notes', { p_room_id: roomId });
    if (refreshError || !Array.isArray(data)) return;
    const next = data as StudyNote[];
    const open = next.find((note) => note.id === selectedIdRef.current);
    const local = notesRef.current.find((note) => note.id === selectedIdRef.current);
    if (open && local && open.version > local.version && !dirtyRef.current) {
      setTitle(open.title); setContent(open.content); setStatus('live');
    }
    // Unsaved edits keep their base version, so saving reports the conflict.
    setNotes(dirtyRef.current && local ? next.map((note) => (note.id === local.id ? local : note)) : next);
  }, [roomId]);
  useHintedLoad(['notes'], () => { void refresh(); });

  useEffect(() => subscribeRoomEvents((event) => {
    if (event.type !== 'note_editing') return;
    const noteId = String(event.payload.noteId);
    setEditors((current) => {
      const next = new Map(current);
      if (event.payload.editing === true) next.set(event.senderId, { noteId, at: Date.now() }); else next.delete(event.senderId);
      return next;
    });
  }), [subscribeRoomEvents]);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 2_000);
    return () => window.clearInterval(interval);
  }, []);

  const current = notes.find((note) => note.id === selectedId) ?? null;
  const canUnlockEdit = Boolean(current && (current.owner_id === currentUserId || capabilities.manageMembers));
  const readOnly = Boolean(current?.locked && !canUnlockEdit);

  const save = useCallback(async () => {
    const note = notes.find((item) => item.id === selectedId);
    if (!note || !dirtyRef.current || saving || readOnly) return;
    const revision = revisionRef.current;
    setSaving(true); setError(null);
    try {
      const updated = await updateStudyNote(note.id, note.version, title.trim() || 'Untitled note', content).then(unwrapAction);
      setNotes((items) => items.map((item) => item.id === updated.id ? updated : item));
      if (revisionRef.current === revision) { dirtyRef.current = false; setStatus('saved'); }
      if (updated.scope === 'room') announce('notes');
    } catch (saveError) {
      const value = errorMessage(saveError);
      setStatus(value.includes('expected version') ? 'conflict' : 'error'); setError(value);
    } finally { setSaving(false); }
  }, [announce, content, notes, readOnly, saving, selectedId, title]);

  useEffect(() => {
    if (!selectedId || !dirtyRef.current) return;
    const timeout = window.setTimeout(() => { void save(); }, 900);
    return () => window.clearTimeout(timeout);
  }, [content, save, selectedId, title]);

  // "Editing" presence: at most every 2 s while typing, and a stop after a
  // pause. Ephemeral Broadcast with the note id only, never the text.
  useEffect(() => {
    if (!selectedId || !dirtyRef.current) return;
    const timeout = window.setTimeout(() => { sendRoomEvent('note_editing', { noteId: selectedId, editing: false }); lastEditingSentRef.current = 0; }, 4_000);
    return () => window.clearTimeout(timeout);
  }, [content, selectedId, sendRoomEvent, title]);

  const create = async (scope: StudyNote['scope']) => {
    try {
      const note = await createStudyNote(roomId, scope).then(unwrapAction);
      setNotes((items) => [note, ...items]); select(note);
      if (scope === 'room') announce('notes');
    } catch (createError) { setStatus('error'); setError(errorMessage(createError)); }
  };
  const remove = async () => {
    if (!selectedId) return;
    try {
      const wasRoom = current?.scope === 'room';
      await deleteStudyNote(selectedId).then(unwrapAction);
      const next = notes.filter((note) => note.id !== selectedId); setNotes(next); select(next[0] ?? null);
      if (wasRoom) announce('notes');
    } catch (deleteError) { setStatus('error'); setError(errorMessage(deleteError)); }
  };
  const change = (setter: (value: string) => void, value: string) => {
    if (readOnly) return;
    setter(value); dirtyRef.current = true; revisionRef.current += 1; setStatus('idle');
    const sentAt = Date.now();
    if (selectedId && current?.scope === 'room' && sentAt - lastEditingSentRef.current > 2_000) {
      lastEditingSentRef.current = sentAt;
      sendRoomEvent('note_editing', { noteId: selectedId, editing: true });
    }
  };
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

  const toggleLock = async () => {
    if (!current) return;
    const result = await setNoteLocked(current.id, !current.locked);
    if (!result.ok) { setStatus('error'); setError(result.error); return; }
    setNotes((items) => items.map((item) => item.id === current.id ? { ...item, ...(result.data as Partial<StudyNote>) } : item));
    announce('notes');
  };
  const openHistory = async () => {
    if (!current) return;
    if (history) { setHistory(null); setPreview(null); return; }
    const result = await listNoteVersions(current.id);
    if (!result.ok) { setStatus('error'); setError(result.error); return; }
    setHistory(result.data);
  };
  const restore = async (version: NoteVersion) => {
    if (!current) return;
    const result = await restoreNoteVersion(current.id, version.version, current.version);
    if (!result.ok) { setStatus(result.error.includes('expected version') ? 'conflict' : 'error'); setError(result.error); return; }
    const updated = result.data as unknown as StudyNote;
    setNotes((items) => items.map((item) => item.id === updated.id ? updated : item));
    setTitle(updated.title); setContent(updated.content); dirtyRef.current = false;
    setHistory(null); setPreview(null); setStatus('saved');
    announce('notes');
  };

  const activeEditors = [...editors.entries()].filter(([userId, value]) => value.noteId === selectedId && userId !== currentUserId && now - value.at < EDITING_TTL_MS).map(([userId]) => names.get(userId) ?? 'A member');
  const lastEditor = current?.last_edited_by ? (current.last_edited_by === currentUserId ? 'you' : names.get(current.last_edited_by) ?? 'a member') : null;

  return <section className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[13rem_minmax(0,1fr)]" aria-label="Persistent study notes">
    <aside className="flex min-h-0 flex-col rounded-xl border border-neutral-800 bg-[#121212] p-3">
      <div className="flex flex-wrap gap-2"><button type="button" onClick={() => void create('room')} className="rounded-lg bg-indigo-600 px-3 py-2 text-[10px] font-bold text-white hover:bg-indigo-500">New room note</button><button type="button" onClick={() => void create('personal')} className="rounded-lg border border-neutral-700 px-3 py-2 text-[10px] font-bold text-neutral-200 hover:border-neutral-500">New personal note</button></div>
      <div className="mt-3 min-h-0 flex-1 space-y-1 overflow-y-auto">{loading ? <p className="p-2 text-xs text-neutral-500">Loading notes…</p> : notes.length === 0 ? <p className="p-2 text-xs text-neutral-500">No notes yet.</p> : notes.map((note) => <button key={note.id} type="button" onClick={() => select(note)} aria-current={note.id === selectedId ? 'true' : undefined} className={`w-full rounded-lg px-3 py-2 text-left text-xs ${note.id === selectedId ? 'bg-indigo-600/20 text-white' : 'text-neutral-400 hover:bg-white/5 hover:text-white'}`}><span className="block truncate font-bold">{note.title}</span><span className="mt-1 block text-[9px] uppercase tracking-wider text-neutral-500">{note.scope}{note.locked ? ' · read-only' : ''}</span></button>)}</div>
    </aside>
    <div className="flex min-h-0 flex-col rounded-xl border border-neutral-800 bg-[#121212] p-4">
      {!selectedId ? <div className="flex flex-1 items-center justify-center text-sm text-neutral-500">Create a room or personal note to begin.</div> : <>
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="study-note-title">Note title</label>
          <input id="study-note-title" value={title} onChange={(event) => change(setTitle, event.target.value)} readOnly={readOnly} maxLength={160} className="min-w-0 flex-1 border-b border-neutral-700 bg-transparent pb-2 text-sm font-bold text-white outline-none focus:border-indigo-500" placeholder="Note title" />
          <button type="button" onClick={() => void save()} disabled={saving || readOnly} className="rounded-lg bg-emerald-600 px-3 py-2 text-[10px] font-bold text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save changes'}</button>
          <button type="button" onClick={() => void openHistory()} aria-expanded={Boolean(history)} className="rounded-lg border border-neutral-700 px-3 py-2 text-[10px] font-bold text-neutral-200 hover:border-neutral-500">History</button>
          {current?.scope === 'room' && canUnlockEdit && <button type="button" onClick={() => void toggleLock()} aria-pressed={Boolean(current.locked)} className="rounded-lg border border-neutral-700 px-3 py-2 text-[10px] font-bold text-neutral-200 hover:border-neutral-500">{current.locked ? 'Allow editing' : 'Make read-only'}</button>}
          <button type="button" onClick={() => void remove()} className="rounded-lg border border-red-500/50 px-3 py-2 text-[10px] font-bold text-red-200 hover:bg-red-500/10">Delete</button>
        </div>
        <p className="mt-2 text-[10px] text-neutral-500" aria-live="polite">
          {current?.locked && <span className="mr-2 rounded bg-amber-500/15 px-1.5 py-0.5 font-bold text-amber-200">Read-only{readOnly ? '' : ' for others'}</span>}
          {activeEditors.length > 0 ? `${activeEditors.join(', ')} ${activeEditors.length === 1 ? 'is' : 'are'} editing…` : lastEditor ? `Last edited by ${lastEditor}` : ''}
        </p>
        {history && (
          <div className="mt-3 max-h-56 overflow-y-auto rounded-lg border border-neutral-800 bg-[#0d0d0d] p-2" aria-label="Note history">
            {history.length === 0 ? <p className="p-2 text-xs text-neutral-500">No earlier versions yet.</p> : history.map((version) => (
              <div key={version.version} className="flex flex-wrap items-center gap-2 border-b border-neutral-800 px-2 py-2 text-xs last:border-0">
                <span className="font-bold text-white">v{version.version}</span>
                <span className="text-neutral-500">{new Date(version.saved_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}{version.edited_by ? ` · ${version.edited_by === currentUserId ? 'you' : names.get(version.edited_by) ?? 'member'}` : ''}</span>
                <span className="ml-auto flex gap-3">
                  <button type="button" className="font-bold text-indigo-300 underline" onClick={() => setPreview(preview?.version === version.version ? null : version)}>{preview?.version === version.version ? 'Hide' : 'Preview'}</button>
                  {!readOnly && <button type="button" className="font-bold text-emerald-300 underline" onClick={() => void restore(version)}>Restore</button>}
                </span>
                {preview?.version === version.version && <pre className="mt-1 w-full whitespace-pre-wrap rounded bg-black/40 p-2 text-[11px] text-neutral-300">{version.content || '(empty)'}</pre>}
              </div>
            ))}
          </div>
        )}
        <label className="sr-only" htmlFor="study-note-content">Note content</label>
        <textarea id="study-note-content" value={content} onChange={(event) => change(setContent, event.target.value)} readOnly={readOnly} aria-readonly={readOnly} maxLength={100000} className="mt-3 min-h-0 flex-1 resize-none rounded-lg border border-neutral-800 bg-[#0d0d0d] p-3 text-sm text-white outline-none focus:border-indigo-500" placeholder="Write your study notes…" />
      </>}
      <p aria-live="polite" className={`mt-3 text-xs ${status === 'conflict' || status === 'error' ? 'text-amber-300' : 'text-neutral-500'}`}>{status === 'saved' ? 'Saved.' : status === 'live' ? 'Updated with the latest version from the room.' : status === 'conflict' ? 'Conflict detected: another member saved this note first. Keep your version or load theirs.' : error ?? (selectedId ? (readOnly ? 'This note is read-only.' : saving ? 'Saving…' : 'Autosaves after a short pause.') : '')}</p>
      {status === 'conflict' && <div className="mt-2 flex flex-wrap gap-3"><button type="button" onClick={() => void keepMine()} className="text-xs font-bold text-emerald-300 underline">Keep my version</button><button type="button" onClick={() => void load(selectedId ?? undefined)} className="text-xs font-bold text-indigo-300 underline">Load latest (discard mine)</button></div>}
      {status === 'error' && <button type="button" onClick={() => void load(selectedId ?? undefined)} className="mt-2 self-start text-xs font-bold text-indigo-300 underline">Retry / reload latest</button>}
    </div>
  </section>;
}
