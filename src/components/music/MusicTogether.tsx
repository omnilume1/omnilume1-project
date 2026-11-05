'use client';

import { useEffect, useState } from 'react';
import { useFriendsListening } from '@/hooks/useFriendsListening';
import { useListenTogether } from '@/hooks/useListenTogether';
import { useMusicLibrary, type ShareTarget } from '@/hooks/useMusicLibrary';
import { createClient } from '@/utils/supabase/client';
import { EmptyState, PageTitle, TrackList } from './MusicParts';

export function TogetherView() {
  const { shareTargets } = useMusicLibrary();
  const together = useListenTogether();
  const [targets, setTargets] = useState<ShareTarget[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    shareTargets().then(setTargets, () => setLoadError(true));
  }, [shareTargets]);

  return (
    <>
      <PageTitle>Listen Together</PageTitle>
      <p className="mu-muted">Play songs shared to a room or group in sync with its members: everyone who joins hears the same song at the same moment.</p>
      <section className="mu-section" aria-labelledby="mu-together-places">
        <h2 id="mu-together-places" className="mu-section-title">Your rooms and groups</h2>
        {loadError ? <p className="mu-error" role="alert">Couldn’t load your rooms and groups.</p> : null}
        {targets === null && !loadError ? <p className="mu-muted" role="status">Loading…</p> : null}
        {targets?.length === 0 ? <EmptyState title="No rooms or groups yet" detail="Join a room or group to listen together with its members." /> : null}
        {targets?.length ? (
          <ul className="mu-targets">
            {targets.map((target) => {
              const selected = together.target?.kind === target.target_kind && together.target.id === target.target_id;
              return (
                <li key={`${target.target_kind}-${target.target_id}`}>
                  <span>{target.name} <span className="mu-muted">· {target.target_kind === 'room' ? 'Room' : 'Group'}</span></span>
                  <button
                    type="button" className="mu-text-button" aria-pressed={selected}
                    onClick={() => void together.select({ kind: target.target_kind, id: target.target_id, name: target.name })}
                  >
                    {selected ? 'Open' : 'Choose'}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>
      {together.target ? <SessionPanel /> : null}
    </>
  );
}

function SessionPanel() {
  const { target, session, following, canControl, userId, error, tracks, tracksById, join, leave, control, reloadTracks } = useListenTogether();
  const [hostOnly, setHostOnly] = useState(false);
  if (!target) return null;
  const live = session && !session.ended ? session : null;
  const isHost = Boolean(live && live.hostId === userId);
  const current = live?.uploadId ? tracksById.get(live.uploadId) : undefined;

  return (
    <section className="mu-section" aria-labelledby="mu-together-session">
      <h2 id="mu-together-session" className="mu-section-title">{target.name}</h2>
      {live ? (
        <>
          <p>
            {isHost ? 'You are hosting.' : `Hosted by ${live.hostName}.`}{' '}
            {live.hostOnly ? 'Only the host controls playback.' : 'Everyone here can control playback.'}
          </p>
          <p className="mu-muted" aria-live="polite">
            {current ? `${live.isPlaying ? 'Playing' : 'Paused'}: ${current.title} — ${current.artist}` : 'Nothing playing yet. Pick a song below.'}
          </p>
          <div className="mu-section-actions">
            {following
              ? <button type="button" className="mu-pill-button" onClick={leave}>Leave</button>
              : <button type="button" className="mu-pill-button is-key" onClick={() => void join(false)}>Join</button>}
            {isHost ? (
              <>
                <label className="mu-check">
                  <input type="checkbox" checked={live.hostOnly} onChange={(event) => void control('host_only', { flag: event.target.checked })} />
                  Only I can control playback
                </label>
                <button type="button" className="mu-text-button is-destructive" onClick={() => void control('end')}>End Session</button>
              </>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <p className="mu-muted">No one is listening here right now.</p>
          <label className="mu-check">
            <input type="checkbox" checked={hostOnly} onChange={(event) => setHostOnly(event.target.checked)} />
            Only I can control playback
          </label>
          <div className="mu-section-actions">
            <button type="button" className="mu-pill-button is-key" onClick={() => void join(hostOnly)}>Start Listening Together</button>
          </div>
        </>
      )}
      {error ? <p className="mu-error" role="alert">{error}</p> : null}

      {live && live.queue.length ? (
        <>
          <h3 className="mu-section-title">Up Next</h3>
          <ol className="mu-targets">
            {live.queue.map((id, index) => {
              const track = tracksById.get(id);
              return (
                <li key={`${id}-${index}`}>
                  <span>{track ? `${track.title} — ${track.artist}` : 'Song no longer available'}</span>
                  {following && canControl ? (
                    <button type="button" className="mu-text-button" aria-label={`Remove ${track?.title ?? 'song'} from Up Next`} onClick={() => void control('remove', { uploadId: id, index })}>Remove</button>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </>
      ) : null}

      <div className="mu-section-actions">
        <h3 className="mu-section-title">Songs shared here</h3>
        <button type="button" className="mu-text-button" onClick={() => void reloadTracks()}>Refresh</button>
      </div>
      {following && !canControl ? <p className="mu-muted">The host is choosing the music.</p> : null}
      {!following && tracks.length ? <p className="mu-muted">Join to play songs for everyone; until then they play only for you.</p> : null}
      {tracks.length
        ? <TrackList tracks={tracks} source={`Listen Together: ${target.name}`} showArt />
        : <EmptyState title="No songs shared here yet" detail={`Share songs to ${target.name} from your library (⋯ → Share), then play them here together.`} />}
    </section>
  );
}

/** Music Home: friends playing music now. */
export function FriendsListening() {
  const friends = useFriendsListening();
  if (!friends.length) return null;
  return (
    <section className="mu-shelf" aria-labelledby="mu-friends-listening">
      <h2 id="mu-friends-listening" className="mu-section-title">Friends Listening</h2>
      <ul className="mu-targets">
        {friends.map((friend) => (
          <li key={friend.user_id}>
            <span>
              <strong>{friend.display_name || friend.username || 'A friend'}</strong>{' '}
              <span className="mu-muted">is listening to {friend.title}{friend.artist ? ` — ${friend.artist}` : ''}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

type Presence = 'friends' | 'nobody';

/** Settings: who sees "Listening to …". */
export function PresenceSetting() {
  const [value, setValue] = useState<Presence | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    createClient().from('music_settings').select('presence').maybeSingle().then(
      ({ data, error: loadError }: { data: { presence: Presence } | null; error: { message: string } | null }) => {
        if (loadError) setError('Couldn’t load this setting.');
        else setValue(data?.presence ?? 'friends');
      },
    );
  }, []);

  const save = async (next: Presence) => {
    const previous = value;
    setValue(next);
    const { error: saveError } = await createClient().rpc('set_music_presence', { p_presence: next });
    if (saveError) {
      setValue(previous);
      setError('Couldn’t save this setting. Try again.');
    } else {
      setError(null);
    }
  };

  return (
    <fieldset className="mu-fieldset">
      <legend className="mu-section-title">Who sees what you’re listening to</legend>
      {(['friends', 'nobody'] as const).map((option) => (
        <label key={option} className="mu-check">
          <input type="radio" name="mu-presence" value={option} checked={value === option} disabled={value === null} onChange={() => void save(option)} />
          {option === 'friends' ? 'Friends' : 'Nobody'}
        </label>
      ))}
      <p className="mu-muted">
        With Friends, your friends see the title and artist of what you play (on Music Home and next to your name in rooms and groups) until a few minutes after you stop.
        Listen Together is separate: members of the room or group you join see the shared session.
      </p>
      {error ? <p className="mu-error" role="alert">{error}</p> : null}
    </fieldset>
  );
}
