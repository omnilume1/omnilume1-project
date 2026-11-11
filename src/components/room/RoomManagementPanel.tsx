'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { exportRoom } from '@/actions/room-management';
import { unwrapAction } from '@/lib/action-result';
import {
  applyRoomTemplate, deleteRoomTemplate, getRoomTrustLevels, listRoomTemplates, saveRoomTemplate,
  type RoomTemplate, type TrustRow,
} from '@/lib/management-data';
import { TRUST_HINTS, TRUST_LABELS } from '@/lib/room-management-model';
import { SURFACES } from '@/lib/surface-flags';

// Templates, backup/export and the caller's own trust level (Action 13).
// Visible to owners/admins; every action is checked again in the database.
export default function RoomManagementPanel({ roomId, role, currentUserId }: { roomId: string; role: string | null; currentUserId: string | null }) {
  const [templates, setTemplates] = useState<RoomTemplate[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [exportInfo, setExportInfo] = useState<{ sha256: string; fileName: string } | null>(null);
  const [mine, setMine] = useState<TrustRow | null>(null);
  const isOwner = role === 'owner';

  const load = useCallback(async () => {
    const result = await listRoomTemplates();
    if (!result.ok) { setStatus('error'); return; }
    setTemplates(result.data); setStatus('ready');
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (!currentUserId || !SURFACES.trustBadges) return;
    let active = true;
    void getRoomTrustLevels(roomId).then((result) => { if (active && result.ok) setMine(result.data.find((row) => row.user_id === currentUserId) ?? null); });
    return () => { active = false; };
  }, [roomId, currentUserId]);

  const run = async (key: string, work: () => Promise<string>) => {
    setBusy(key); setMessage(null);
    try { setMessage({ kind: 'ok', text: await work() }); }
    catch (error) { setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Something went wrong.' }); }
    finally { setBusy(null); }
  };
  const unwrap = <T,>(result: { ok: true; data: T } | { ok: false; error: string }) => { if (!result.ok) throw new Error(result.error); return result.data; };

  const save = (event: FormEvent) => {
    event.preventDefault();
    void run('save', async () => { unwrap(await saveRoomTemplate(roomId, name)); setName(''); await load(); return 'Template saved.'; });
  };

  const download = () => void run('export', async () => {
    const result = await exportRoom(roomId).then(unwrapAction);
    const url = URL.createObjectURL(new Blob([result.json], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = result.fileName; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setExportInfo({ sha256: result.sha256, fileName: result.fileName });
    return 'Export downloaded and recorded.';
  });

  return (
    <div className="space-y-6">
      <section aria-labelledby="mgmt-templates">
        <h3 id="mgmt-templates" className="text-sm font-bold text-white">Room templates</h3>
        <p className="mt-1 text-xs text-neutral-500">Reuse a room&apos;s features, layout, theme, rules and welcome message. Privacy and lifespan are chosen when a room is created.</p>
        <form onSubmit={save} className="mt-3 flex flex-wrap gap-2">
          <label className="sr-only" htmlFor="template-name">Template name</label>
          <input id="template-name" className="omni-input min-w-0 flex-1" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} placeholder="Name this room as a template" required />
          <button type="submit" className="omni-button omni-button-primary" disabled={busy === 'save' || !name.trim()}>{busy === 'save' ? 'Saving…' : 'Save as template'}</button>
        </form>
        {status === 'loading' ? <p className="mt-3 text-xs text-neutral-500">Loading templates…</p> : status === 'error' ? (
          <p className="mt-3 text-xs text-red-300" role="alert">Templates could not be loaded. <button type="button" className="underline" onClick={() => { setStatus('loading'); void load(); }}>Retry</button></p>
        ) : (
          <ul className="mt-3 grid gap-2">
            {templates.map((template) => (
              <li key={template.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-3">
                <span className="min-w-0"><strong className="block truncate text-sm text-white">{template.name}</strong><small className="text-xs text-neutral-500">{template.builtin_key ? 'Built-in' : 'Yours'}{template.description ? ` · ${template.description}` : ''}</small></span>
                <span className="flex gap-2">
                  <button type="button" className="omni-button omni-button-ghost" disabled={!isOwner || busy === `apply:${template.id}`} title={isOwner ? undefined : 'Only the room owner can apply a template'}
                    onClick={() => void run(`apply:${template.id}`, async () => { unwrap(await applyRoomTemplate(roomId, template.id)); return `Applied “${template.name}”.`; })}>Apply</button>
                  {!template.builtin_key && <button type="button" className="omni-button omni-button-ghost" disabled={busy === `delete:${template.id}`}
                    onClick={() => void run(`delete:${template.id}`, async () => { unwrap(await deleteRoomTemplate(template.id)); await load(); return 'Template deleted.'; })}>Delete</button>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {SURFACES.roomExport && <section aria-labelledby="mgmt-export">
        <h3 id="mgmt-export" className="text-sm font-bold text-white">Backup / export</h3>
        <p className="mt-1 text-xs text-neutral-500">Downloads room details, members, announcements, plaintext chat, shared notes, tasks, polls, events and a file list. Encrypted messages, keys, storage paths and links are never included. Limited to 3 exports an hour and recorded.</p>
        <button type="button" className="omni-button omni-button-primary mt-3" onClick={download} disabled={busy === 'export'}>{busy === 'export' ? 'Preparing export…' : 'Download room export'}</button>
        {exportInfo && <p className="mt-3 break-all text-xs text-neutral-400" role="status">Saved {exportInfo.fileName}. SHA-256: <code>{exportInfo.sha256}</code></p>}
      </section>}

      {SURFACES.trustBadges && <section aria-labelledby="mgmt-trust">
        <h3 id="mgmt-trust" className="text-sm font-bold text-white">Your trust level</h3>
        {mine ? <p className="mt-1 text-xs text-neutral-400"><strong className="text-white">{TRUST_LABELS[mine.level]}</strong> · {TRUST_HINTS[mine.level]} It is calculated from tenure and contributions and grants no permissions.</p>
          : <p className="mt-1 text-xs text-neutral-500">Not available yet.</p>}
      </section>}

      {message && <p role={message.kind === 'error' ? 'alert' : 'status'} className={message.kind === 'error' ? 'text-xs text-red-300' : 'text-xs text-emerald-300'}>{message.text}</p>}
    </div>
  );
}
