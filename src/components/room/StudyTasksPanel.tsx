'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useRoomRealtime } from '@/components/room/RoomRealtimeProvider';
import { useAnnounce, useHintedLoad, useMemberNames, useRoomCapabilities } from '@/lib/collab-hooks';
import { createTask, deleteTask, listTasks, setTaskDone, updateTask, type RoomTask } from '@/lib/collab-data';

type Filter = 'open' | 'mine' | 'all';

function toLocalInput(iso: string | null) {
  if (!iso) return '';
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Manual tasks / action items (Action 12). Humans create and complete them;
// the assignee gets a notification. AI-suggested tasks are Action 17.
export default function StudyTasksPanel({ roomId }: { roomId: string }) {
  const { currentUserId } = useRoomRealtime();
  const capabilities = useRoomCapabilities(roomId);
  const names = useMemberNames(roomId);
  const announce = useAnnounce();
  const [tasks, setTasks] = useState<RoomTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('open');
  const [editing, setEditing] = useState<RoomTask | null>(null);
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [assignee, setAssignee] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  const load = useCallback(async () => {
    const result = await listTasks(roomId);
    setLoading(false);
    if (!result.ok) { setError(result.error); return; }
    setTasks(result.data); setError(null);
  }, [roomId]);
  useHintedLoad(['tasks'], () => { void load(); });

  const resetForm = () => { setEditing(null); setTitle(''); setDetails(''); setAssignee(''); setDue(''); };
  const startEdit = (task: RoomTask) => { setEditing(task); setTitle(task.title); setDetails(task.details); setAssignee(task.assignee_id ?? ''); setDue(toLocalInput(task.due_at)); };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const dueIso = due ? new Date(due).toISOString() : null;
    setBusy(true);
    const result = editing
      ? await updateTask(editing.id, title, details, assignee || null, dueIso)
      : await createTask(roomId, title, details, assignee || null, dueIso);
    setBusy(false);
    if (!result.ok) { setError(result.error); return; }
    resetForm(); setError(null); announce('tasks'); void load();
  };
  const run = async (action: () => Promise<{ ok: boolean; error?: string }>) => {
    const result = await action();
    if (!result.ok) { setError(result.error ?? 'Something went wrong.'); return; }
    setError(null); announce('tasks'); void load();
  };

  const visible = tasks.filter((task) => filter === 'all' || (filter === 'open' ? task.status === 'open' : task.assignee_id === currentUserId));
  const members = [...names.entries()].sort((a, b) => a[1].localeCompare(b[1]));

  return (
    <section className="study-tasks" aria-label="Tasks and action items">
      {capabilities.study && (
        <form className="collab-form study-task-form" onSubmit={(event) => void submit(event)} aria-label={editing ? 'Edit task' : 'Add a task'}>
          <label className="collab-label" htmlFor="task-title">{editing ? 'Edit task' : 'New task'}</label>
          <input id="task-title" className="omni-input" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} placeholder="Summarise chapter 4" required />
          <div className="study-task-grid">
            <label className="collab-label">Assign to
              <select className="omni-input" value={assignee} onChange={(event) => setAssignee(event.target.value)}>
                <option value="">Nobody</option>
                {members.map(([id, name]) => <option key={id} value={id}>{id === currentUserId ? `${name} (you)` : name}</option>)}
              </select>
            </label>
            <label className="collab-label">Due
              <input type="datetime-local" className="omni-input" value={due} onChange={(event) => setDue(event.target.value)} />
            </label>
          </div>
          <label className="collab-label" htmlFor="task-details">Details (optional)</label>
          <textarea id="task-details" className="omni-input collab-textarea" value={details} maxLength={2000} onChange={(event) => setDetails(event.target.value)} />
          <div className="collab-row">
            <button type="submit" className="omni-button omni-button-primary" disabled={busy || !title.trim()} aria-busy={busy}>{busy ? 'Saving…' : editing ? 'Save task' : 'Add task'}</button>
            {editing && <button type="button" className="omni-button omni-button-ghost" onClick={resetForm}>Cancel</button>}
          </div>
        </form>
      )}
      <div className="study-task-list">
        <div className="collab-tabs" role="tablist" aria-label="Task filter">
          {(['open', 'mine', 'all'] as const).map((value) => (
            <button key={value} type="button" role="tab" aria-selected={filter === value} className={`collab-tab ${filter === value ? 'is-active' : ''}`} onClick={() => setFilter(value)}>{value === 'open' ? 'Open' : value === 'mine' ? 'Assigned to me' : 'All'}</button>
          ))}
        </div>
        {error && <p role="alert" className="collab-error">{error} <button type="button" className="collab-link" onClick={() => void load()}>Retry</button></p>}
        {loading ? <div className="collab-skeleton" aria-label="Loading tasks" /> : visible.length === 0 ? <p className="collab-empty">{filter === 'mine' ? 'Nothing assigned to you.' : filter === 'open' ? 'No open tasks.' : 'No tasks yet.'}</p> : (
          <ul className="collab-list">
            {visible.map((task) => {
              const canEdit = [task.created_by, task.assignee_id].includes(currentUserId) || capabilities.manageMembers;
              const overdue = task.status === 'open' && task.due_at && new Date(task.due_at).getTime() < now;
              return (
                <li key={task.id} className={`collab-card study-task ${task.status === 'done' ? 'is-done' : ''}`}>
                  <label className="study-task-check">
                    <input type="checkbox" checked={task.status === 'done'} disabled={!canEdit} onChange={(event) => void run(() => setTaskDone(task.id, event.target.checked))} />
                    <span className="collab-card-title">{task.title}</span>
                  </label>
                  <p className="collab-meta">
                    {task.assignee_id ? `For ${task.assignee_id === currentUserId ? 'you' : names.get(task.assignee_id) ?? 'a member'}` : 'Unassigned'}
                    {task.due_at && <> · <span className={overdue ? 'study-task-overdue' : ''}>due {new Date(task.due_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}{overdue ? ' (overdue)' : ''}</span></>}
                    {task.status === 'done' && task.completed_by && ` · done by ${task.completed_by === currentUserId ? 'you' : names.get(task.completed_by) ?? 'a member'}`}
                  </p>
                  {task.details && <p className="collab-text">{task.details}</p>}
                  {canEdit && (
                    <div className="collab-row">
                      <button type="button" className="collab-link" onClick={() => startEdit(task)}>Edit</button>
                      {(task.created_by === currentUserId || capabilities.manageMembers) && <button type="button" className="collab-link is-danger" onClick={() => void run(() => deleteTask(task.id))}>Delete</button>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
