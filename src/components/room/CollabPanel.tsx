'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useRoomRealtime } from '@/components/room/RoomRealtimeProvider';
import { useAnnounce, useHintedLoad, useMemberNames, useRoomCapabilities } from '@/lib/collab-hooks';
import { countdownRemaining, localDateTimeInput, pollPercentages } from '@/lib/collab-model';
import {
  cancelCountdown, cancelEvent, closePoll, createCountdown, createEvent, createPoll, deletePoll,
  listCountdowns, listEvents, listPolls, pollResults, searchRoom, votePoll,
  type Countdown, type Poll, type PollResult, type RoomEventRow, type SearchHit,
} from '@/lib/collab-data';
import { formatDuration } from '@/lib/collab-hooks';

type Tab = 'polls' | 'countdowns' | 'events' | 'search';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'polls', label: 'Polls' },
  { id: 'countdowns', label: 'Countdowns' },
  { id: 'events', label: 'Events' },
  { id: 'search', label: 'Search' },
];

// Collaborate side tool (Action 12): polls, shared countdowns, room events and
// searchable room history. Everything is re-read through RLS/RPC; Broadcast
// only carries "something changed" hints.
export default function CollabPanel({ roomId }: { roomId: string }) {
  const [tab, setTab] = useState<Tab>('polls');
  return (
    <section className="collab-panel" aria-label="Collaborate">
      <div className="collab-tabs" role="tablist" aria-label="Collaboration tools">
        {TABS.map((item) => (
          <button key={item.id} type="button" role="tab" id={`collab-tab-${item.id}`} aria-selected={tab === item.id} aria-controls={`collab-panel-${item.id}`} className={`collab-tab ${tab === item.id ? 'is-active' : ''}`} onClick={() => setTab(item.id)}>
            {item.label}
          </button>
        ))}
      </div>
      <div className="collab-body" role="tabpanel" id={`collab-panel-${tab}`} aria-labelledby={`collab-tab-${tab}`}>
        {tab === 'polls' && <PollsSection roomId={roomId} />}
        {tab === 'countdowns' && <CountdownsSection roomId={roomId} />}
        {tab === 'events' && <EventsSection roomId={roomId} />}
        {tab === 'search' && <SearchSection roomId={roomId} />}
      </div>
    </section>
  );
}

function Status({ error, onRetry }: { error: string | null; onRetry?: () => void }) {
  if (!error) return null;
  return <p role="alert" className="collab-error">{error}{onRetry && <> <button type="button" className="collab-link" onClick={onRetry}>Retry</button></>}</p>;
}

function PollsSection({ roomId }: { roomId: string }) {
  const { currentUserId } = useRoomRealtime();
  const capabilities = useRoomCapabilities(roomId);
  const names = useMemberNames(roomId);
  const announce = useAnnounce();
  const [polls, setPolls] = useState<Poll[]>([]);
  const [results, setResults] = useState<Map<string, PollResult>>(() => new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [pollList, resultList] = await Promise.all([listPolls(roomId), pollResults(roomId)]);
    setLoading(false);
    if (!pollList.ok) { setError(pollList.error); return; }
    setPolls(pollList.data);
    setResults(new Map((resultList.ok ? resultList.data : []).map((row) => [row.poll_id, row])));
    setError(resultList.ok ? null : resultList.error);
  }, [roomId]);
  useHintedLoad(['polls'], () => { void load(); });

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const result = await createPoll(roomId, question, options.map((option) => option.trim()).filter(Boolean));
    setBusy(false);
    if (!result.ok) { setError(result.error); return; }
    setQuestion(''); setOptions(['', '']); setError(null);
    announce('polls'); void load();
  };
  const act = async (action: () => Promise<{ ok: boolean; error?: string }>) => {
    const result = await action();
    if (!result.ok) { setError(result.error ?? 'Something went wrong.'); return; }
    setError(null); announce('polls'); void load();
  };

  return (
    <div className="collab-section">
      {capabilities.chat && (
        <form className="collab-form" onSubmit={(event) => void create(event)} aria-label="Create a poll">
          <label className="collab-label" htmlFor="poll-question">Question</label>
          <input id="poll-question" className="omni-input" value={question} maxLength={300} onChange={(event) => setQuestion(event.target.value)} placeholder="What should we study next?" required />
          {options.map((option, index) => (
            <div key={index} className="collab-row">
              <label className="sr-only" htmlFor={`poll-option-${index}`}>Option {index + 1}</label>
              <input id={`poll-option-${index}`} className="omni-input" value={option} maxLength={120} onChange={(event) => setOptions((current) => current.map((value, i) => (i === index ? event.target.value : value)))} placeholder={`Option ${index + 1}`} required={index < 2} />
              {options.length > 2 && <button type="button" className="collab-icon-button" aria-label={`Remove option ${index + 1}`} onClick={() => setOptions((current) => current.filter((_, i) => i !== index))}>×</button>}
            </div>
          ))}
          <div className="collab-row">
            {options.length < 10 && <button type="button" className="collab-link" onClick={() => setOptions((current) => [...current, ''])}>+ Add option</button>}
            <button type="submit" className="omni-button omni-button-primary collab-submit" disabled={busy || !question.trim()} aria-busy={busy}>{busy ? 'Creating…' : 'Create poll'}</button>
          </div>
        </form>
      )}
      <Status error={error} onRetry={() => void load()} />
      {loading ? <div className="collab-skeleton" aria-label="Loading polls" /> : polls.length === 0 ? <p className="collab-empty">No polls yet.</p> : (
        <ul className="collab-list">
          {polls.map((poll) => {
            const result = results.get(poll.id);
            const counts = result?.counts ?? poll.options.map(() => 0);
            const percentages = pollPercentages(counts);
            const voted = result?.my_vote !== null && result?.my_vote !== undefined;
            const closed = Boolean(poll.closed_at);
            const canModerate = poll.created_by === currentUserId || capabilities.manageMembers;
            return (
              <li key={poll.id} className="collab-card">
                <p className="collab-card-title">{poll.question}</p>
                <p className="collab-meta">{names.get(poll.created_by) ?? 'Member'} · {result?.total ?? 0} vote{result?.total === 1 ? '' : 's'}{closed ? ' · Closed' : ''}</p>
                <div className="collab-options" role="group" aria-label={`Options for ${poll.question}`}>
                  {poll.options.map((option, index) => {
                    const mine = result?.my_vote === index;
                    const showResults = voted || closed;
                    return (
                      <button key={index} type="button" className={`collab-option ${mine ? 'is-mine' : ''}`} disabled={voted || closed || !capabilities.chat} aria-pressed={mine} onClick={() => void act(() => votePoll(poll.id, index))}>
                        {showResults && <span className="collab-option-bar" style={{ width: `${percentages[index]}%` }} aria-hidden="true" />}
                        <span className="collab-option-text">{option}</span>
                        {showResults && <span className="collab-option-value">{percentages[index]}% · {counts[index]}</span>}
                      </button>
                    );
                  })}
                </div>
                {voted && !closed && <p className="collab-meta">You voted. Votes are anonymous; only totals are shown.</p>}
                {canModerate && (
                  <div className="collab-row">
                    {!closed && <button type="button" className="collab-link" onClick={() => void act(() => closePoll(poll.id))}>Close poll</button>}
                    <button type="button" className="collab-link is-danger" onClick={() => void act(() => deletePoll(poll.id))}>Delete</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function CountdownsSection({ roomId }: { roomId: string }) {
  const { currentUserId } = useRoomRealtime();
  const capabilities = useRoomCapabilities(roomId);
  const names = useMemberNames(roomId);
  const announce = useAnnounce();
  const [items, setItems] = useState<Countdown[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [minutes, setMinutes] = useState(10);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const result = await listCountdowns(roomId);
    setLoading(false);
    if (!result.ok) { setError(result.error); return; }
    setItems(result.data); setError(null);
  }, [roomId]);
  useHintedLoad(['countdowns'], () => { void load(); });
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const result = await createCountdown(roomId, label, new Date(Date.now() + minutes * 60_000));
    setBusy(false);
    if (!result.ok) { setError(result.error); return; }
    setLabel(''); setError(null); announce('countdowns'); void load();
  };

  return (
    <div className="collab-section">
      {capabilities.chat && (
        <form className="collab-form" onSubmit={(event) => void create(event)} aria-label="Start a shared countdown">
          <label className="collab-label" htmlFor="countdown-label">Label</label>
          <input id="countdown-label" className="omni-input" value={label} maxLength={120} onChange={(event) => setLabel(event.target.value)} placeholder="Break ends" required />
          <div className="collab-row">
            <label className="collab-label" htmlFor="countdown-minutes">Minutes</label>
            <input id="countdown-minutes" type="number" min={1} max={43200} className="omni-input collab-number" value={minutes} onChange={(event) => setMinutes(Math.max(1, Math.min(43_200, Number(event.target.value) || 1)))} />
            <button type="submit" className="omni-button omni-button-primary collab-submit" disabled={busy || !label.trim()} aria-busy={busy}>{busy ? 'Starting…' : 'Start for everyone'}</button>
          </div>
        </form>
      )}
      <Status error={error} onRetry={() => void load()} />
      {loading ? <div className="collab-skeleton" aria-label="Loading countdowns" /> : items.length === 0 ? <p className="collab-empty">No countdowns running.</p> : (
        <ul className="collab-list">
          {items.map((item) => {
            const remaining = countdownRemaining(item.ends_at, now);
            return (
              <li key={item.id} className={`collab-card ${remaining === 0 ? 'is-done' : ''}`}>
                <p className="collab-card-title">{item.label}</p>
                <p className="collab-countdown" role="timer" aria-live={remaining === 0 ? 'assertive' : 'off'}>{remaining === 0 ? 'Time is up' : formatDuration(remaining)}</p>
                <p className="collab-meta">Started by {names.get(item.created_by) ?? 'Member'} · ends {new Date(item.ends_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                {(item.created_by === currentUserId || capabilities.manageMembers) && remaining > 0 && (
                  <button type="button" className="collab-link is-danger" onClick={() => void cancelCountdown(item.id).then((result) => { if (!result.ok) setError(result.error); else { announce('countdowns'); void load(); } })}>Cancel</button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function EventsSection({ roomId }: { roomId: string }) {
  const { currentUserId } = useRoomRealtime();
  const capabilities = useRoomCapabilities(roomId);
  const names = useMemberNames(roomId);
  const announce = useAnnounce();
  const [items, setItems] = useState<RoomEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [startsAt, setStartsAt] = useState(() => localDateTimeInput(60));
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await listEvents(roomId);
    setLoading(false);
    if (!result.ok) { setError(result.error); return; }
    setItems(result.data); setError(null);
  }, [roomId]);
  useHintedLoad(['events'], () => { void load(); });

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const start = new Date(startsAt);
    if (Number.isNaN(start.getTime())) { setError('Choose a start date and time.'); return; }
    setBusy(true);
    const result = await createEvent(roomId, title, details, start.toISOString(), null);
    setBusy(false);
    if (!result.ok) { setError(result.error); return; }
    setTitle(''); setDetails(''); setError(null); announce('events'); void load();
  };

  return (
    <div className="collab-section">
      {capabilities.manageAnnouncements ? (
        <form className="collab-form" onSubmit={(event) => void create(event)} aria-label="Schedule a room event">
          <label className="collab-label" htmlFor="event-title">Event</label>
          <input id="event-title" className="omni-input" value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} placeholder="Exam review session" required />
          <label className="collab-label" htmlFor="event-start">Starts</label>
          <input id="event-start" type="datetime-local" className="omni-input" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} required />
          <label className="collab-label" htmlFor="event-details">Details (optional)</label>
          <textarea id="event-details" className="omni-input collab-textarea" value={details} maxLength={2000} onChange={(event) => setDetails(event.target.value)} />
          <button type="submit" className="omni-button omni-button-primary collab-submit" disabled={busy || !title.trim()} aria-busy={busy}>{busy ? 'Scheduling…' : 'Schedule and notify members'}</button>
        </form>
      ) : capabilities.loaded && <p className="collab-meta">Members who manage announcements can schedule events.</p>}
      <Status error={error} onRetry={() => void load()} />
      {loading ? <div className="collab-skeleton" aria-label="Loading events" /> : items.length === 0 ? <p className="collab-empty">No upcoming events.</p> : (
        <ul className="collab-list">
          {items.map((item) => (
            <li key={item.id} className={`collab-card ${item.cancelled_at ? 'is-done' : ''}`}>
              <p className="collab-card-title">{item.title}{item.cancelled_at && <span className="collab-badge">Cancelled</span>}</p>
              <p className="collab-meta"><time dateTime={item.starts_at}>{new Date(item.starts_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</time> · {names.get(item.created_by) ?? 'Member'}</p>
              {item.details && <p className="collab-text">{item.details}</p>}
              {!item.cancelled_at && (item.created_by === currentUserId || capabilities.manageAnnouncements) && (
                <button type="button" className="collab-link is-danger" onClick={() => void cancelEvent(item.id).then((result) => { if (!result.ok) setError(result.error); else { announce('events'); void load(); } })}>Cancel event</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const KIND_LABELS: Record<string, string> = {
  message: 'Chat', note: 'Note', task: 'Task', poll: 'Poll', event: 'Event', clip: 'Clip',
  resource: 'Resource', resource_note: 'Timestamped note', transcript: 'Transcript',
};

function SearchSection({ roomId }: { roomId: string }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const search = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || query.trim().length < 2) return;
    setBusy(true);
    const result = await searchRoom(roomId, query.trim());
    setBusy(false);
    if (!result.ok) { setError(result.error); setHits(null); return; }
    setError(null); setHits(result.data);
  };
  return (
    <div className="collab-section">
      <form className="collab-form" role="search" onSubmit={(event) => void search(event)}>
        <label className="collab-label" htmlFor="room-search">Search this room</label>
        <div className="collab-row">
          <input id="room-search" type="search" className="omni-input" value={query} maxLength={100} onChange={(event) => setQuery(event.target.value)} placeholder="Messages, notes, tasks, polls…" />
          <button type="submit" className="omni-button omni-button-primary collab-submit" disabled={busy || query.trim().length < 2} aria-busy={busy}>{busy ? 'Searching…' : 'Search'}</button>
        </div>
        <p className="collab-meta">Results only include what your room role can see.</p>
      </form>
      <Status error={error} />
      {hits && (hits.length === 0 ? <p className="collab-empty">No matches.</p> : (
        <ul className="collab-list" aria-label={`${hits.length} search results`}>
          {hits.map((hit) => (
            <li key={`${hit.kind}:${hit.item_id}`} className="collab-card">
              <p className="collab-card-title"><span className="collab-badge">{KIND_LABELS[hit.kind] ?? hit.kind}</span> {hit.title}</p>
              {hit.snippet && <p className="collab-text">{hit.snippet}</p>}
              <p className="collab-meta"><time dateTime={hit.created_at}>{new Date(hit.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</time></p>
            </li>
          ))}
        </ul>
      ))}
    </div>
  );
}
