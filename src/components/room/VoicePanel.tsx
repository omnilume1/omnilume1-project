'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRoomRealtime } from '@/components/room/RoomRealtimeProvider';
import { MAX_MEMBER_VOLUME, useVoiceRoom, VideoStream } from '@/components/room/VoiceRoom';
import { useAnnounce, useMemberNames, useRoomCapabilities, formatDuration } from '@/lib/collab-hooks';
import {
  cancelRecording, deleteRecording, getTranscript, lowerHand, raiseHand, recordingUrl, requestRecording,
  respondRecording, saveTranscript, setVoiceModeration, type Recording,
} from '@/lib/collab-data';

// Voice side tool (Action 12): P2P voice with owner/manager mute, screen
// sharing, raise hand, and consented recordings with manual transcripts.
export default function VoicePanel() {
  const voice = useVoiceRoom();
  const { currentUserId } = useRoomRealtime();
  const capabilities = useRoomCapabilities(voice.roomId);
  const names = useMemberNames(voice.roomId);
  const announce = useAnnounce();
  const name = (id: string) => (id === currentUserId ? 'You' : names.get(id) ?? 'Member');

  const moderate = async (userId: string, audioMuted: boolean, screenBlocked: boolean) => {
    const result = await setVoiceModeration(voice.roomId, userId, audioMuted, screenBlocked);
    if (!result.ok) { voice.setError(result.error); return; }
    voice.setError(null); announce('voice'); voice.reload();
  };

  const myHand = voice.hands.some((hand) => hand.user_id === currentUserId);
  const toggleHand = async () => {
    const result = myHand ? await lowerHand(voice.roomId) : await raiseHand(voice.roomId);
    if (!result.ok) { voice.setError(result.error); return; }
    announce('hands'); voice.reload();
  };

  const sharers = voice.peers.filter((peer) => peer.screen && peer.sharingScreen && !voice.moderation.get(peer.id)?.screen_blocked);

  return (
    <section className="voice-panel" aria-label="Voice">
      <div className="voice-controls">
        {!voice.joined ? (
          <button type="button" className="omni-button omni-button-primary" onClick={() => void voice.join()} disabled={voice.joining || !capabilities.chat} aria-busy={voice.joining}>
            {voice.joining ? 'Joining…' : 'Join voice'}
          </button>
        ) : (
          <>
            {voice.hasMic
              ? <button type="button" className={`voice-button ${voice.micEnabled ? '' : 'is-off'}`} onClick={voice.toggleMic} aria-pressed={!voice.micEnabled}>{voice.micEnabled ? 'Mute' : 'Unmute'}</button>
              : <button type="button" className="voice-button" onClick={() => void voice.enableMic()} disabled={voice.joining}>Turn on mic</button>}
            {voice.sharingScreen
              ? <button type="button" className="voice-button is-live" onClick={voice.stopScreen}>Stop sharing</button>
              : <button type="button" className="voice-button" onClick={() => void voice.startScreen()}>Share screen</button>}
            <button type="button" className="voice-button is-danger" onClick={voice.leave}>Leave voice</button>
          </>
        )}
        <button type="button" className={`voice-button ${myHand ? 'is-live' : ''}`} onClick={() => void toggleHand()} aria-pressed={myHand} disabled={!capabilities.chat}>{myHand ? 'Lower hand' : 'Raise hand'}</button>
      </div>
      {voice.error && <p role="alert" className="collab-error">{voice.error}</p>}
      {!voice.joined && <p className="collab-meta">Voice is peer-to-peer between members in this room. Your browser asks for microphone access when you join.</p>}

      {voice.sharingScreen && voice.screenStream && (
        <div className="voice-screen is-self"><p className="voice-screen-label"><span className="voice-live-dot" aria-hidden="true" /> You are sharing your screen</p><VideoStream stream={voice.screenStream} label="Your shared screen" /></div>
      )}
      {sharers.map((peer) => (
        <div key={peer.id} className="voice-screen"><p className="voice-screen-label"><span className="voice-live-dot" aria-hidden="true" /> {name(peer.id)} is sharing their screen</p>{peer.screen && <VideoStream stream={peer.screen} label={`${name(peer.id)}'s shared screen`} />}</div>
      ))}

      <h3 className="voice-heading">In voice ({voice.joined ? voice.peers.length + 1 : voice.peers.length})</h3>
      <ul className="voice-list">
        {voice.joined && currentUserId && (
          <li className="voice-person"><span className={`voice-dot ${voice.micEnabled && voice.hasMic ? 'is-on' : ''}`} aria-hidden="true" /><span className="voice-name">You</span><span className="voice-state">{voice.moderation.get(currentUserId)?.audio_muted ? 'Muted by a manager' : !voice.hasMic ? 'Watching · mic off' : voice.micEnabled ? 'Mic on' : 'Muted'}</span></li>
        )}
        {voice.peers.map((peer) => {
          const mod = voice.moderation.get(peer.id);
          const volume = voice.memberVolumes[peer.id] ?? 1;
          return (
            <li key={peer.id} className="voice-person">
              <span className={`voice-dot ${peer.state === 'connected' && !mod?.audio_muted ? 'is-on' : ''}`} aria-hidden="true" />
              <span className="voice-name">{name(peer.id)}</span>
              <span className="voice-state">{mod?.audio_muted ? 'Muted by a manager' : !peer.hasMic && !peer.sharingScreen ? 'Watching · mic off' : peer.state === 'connected' ? 'Connected' : 'Connecting…'}{peer.sharingScreen ? ' · Sharing' : ''}</span>
              {capabilities.manageMembers && (
                <span className="voice-actions">
                  <button type="button" className="collab-link" onClick={() => void moderate(peer.id, !mod?.audio_muted, Boolean(mod?.screen_blocked))}>{mod?.audio_muted ? 'Unmute' : 'Mute'}</button>
                  <button type="button" className="collab-link" onClick={() => void moderate(peer.id, Boolean(mod?.audio_muted), !mod?.screen_blocked)}>{mod?.screen_blocked ? 'Allow share' : 'Stop share'}</button>
                </span>
              )}
              {voice.joined && peer.hasMic && (
                <div className="voice-volume" title="Only you hear this change">
                  <input type="range" min={0} max={MAX_MEMBER_VOLUME} step={0.05} value={volume} aria-label={`${name(peer.id)}'s volume for you`} aria-valuetext={`${Math.round(volume * 100)}%`}
                    onChange={(event) => voice.setMemberVolume(peer.id, Number(event.target.value))} onDoubleClick={() => voice.setMemberVolume(peer.id, 1)} />
                  <span className="voice-volume-value mono" aria-hidden="true">{Math.round(volume * 100)}%</span>
                  {volume !== 1 && <button type="button" className="collab-link" onClick={() => voice.setMemberVolume(peer.id, 1)}>Reset</button>}
                </div>
              )}
            </li>
          );
        })}
        {!voice.joined && voice.peers.length === 0 && <li className="collab-empty">Nobody is in voice. Join to start.</li>}
      </ul>
      {capabilities.manageMembers && [...voice.moderation.values()].some((row) => (row.audio_muted || row.screen_blocked) && !voice.peers.some((peer) => peer.id === row.user_id)) && (
        <div className="voice-muted-list">
          <p className="collab-meta">Moderated members not in voice right now:</p>
          {[...voice.moderation.values()].filter((row) => (row.audio_muted || row.screen_blocked) && !voice.peers.some((peer) => peer.id === row.user_id)).map((row) => (
            <p key={row.user_id} className="collab-meta">{name(row.user_id)} · {row.audio_muted ? 'muted' : ''}{row.audio_muted && row.screen_blocked ? ', ' : ''}{row.screen_blocked ? 'share stopped' : ''} <button type="button" className="collab-link" onClick={() => void moderate(row.user_id, false, false)}>Clear</button></p>
          ))}
        </div>
      )}

      <h3 className="voice-heading">Raised hands ({voice.hands.length})</h3>
      {voice.hands.length === 0 ? <p className="collab-empty">No hands raised.</p> : (
        <ol className="voice-list">
          {voice.hands.map((hand) => (
            <li key={hand.user_id} className="voice-person">
              <span aria-hidden="true">✋</span><span className="voice-name">{name(hand.user_id)}</span>
              <span className="voice-state">{new Date(hand.raised_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              {capabilities.manageMembers && hand.user_id !== currentUserId && (
                <button type="button" className="collab-link" onClick={() => void lowerHand(voice.roomId, hand.user_id).then((result) => { if (!result.ok) voice.setError(result.error); else { announce('hands'); voice.reload(); } })}>Lower</button>
              )}
            </li>
          ))}
        </ol>
      )}

      <RecordingsSection names={name} canManage={capabilities.manageMembers} />
    </section>
  );
}

// Always visible while in voice, while the room is recording, or when this
// member is asked for consent, so nobody is recorded without seeing it.
export function VoiceDock({ onOpen, panelOpen }: { onOpen: () => void; panelOpen: boolean }) {
  const voice = useVoiceRoom();
  const { currentUserId } = useRoomRealtime();
  const recording = voice.recordings.find((item) => item.status === 'recording');
  const askingMe = voice.recordings.find((item) => item.status === 'consent' && currentUserId && item.participants.includes(currentUserId)
    && !voice.consents.some((consent) => consent.recording_id === item.id && consent.user_id === currentUserId));
  const listed = Boolean(recording && currentUserId && recording.participants.includes(currentUserId));
  if (!voice.joined && !listed && !askingMe) return null;
  if (panelOpen && !recording) return null;
  return (
    <div className="voice-dock" role="region" aria-label="Voice status">
      {recording && <span className="voice-dock-rec"><span className="voice-live-dot" aria-hidden="true" /> Recording</span>}
      {askingMe && !panelOpen && <button type="button" className="voice-dock-button is-live" onClick={onOpen}>Recording request · answer</button>}
      {voice.joined && (
        <>
          <span className="voice-dock-label">In voice · {voice.peers.length + 1}</span>
          {voice.hasMic
            ? <button type="button" className={`voice-dock-button ${voice.micEnabled ? '' : 'is-off'}`} onClick={voice.toggleMic} aria-pressed={!voice.micEnabled}>{voice.micEnabled ? 'Mute' : 'Unmute'}</button>
            : <button type="button" className="voice-dock-button" onClick={() => void voice.enableMic()} disabled={voice.joining}>Turn on mic</button>}
          {!panelOpen && <button type="button" className="voice-dock-button" onClick={onOpen}>Open</button>}
          <button type="button" className="voice-dock-button is-danger" onClick={voice.leave}>Leave</button>
        </>
      )}
    </div>
  );
}

function RecordingsSection({ names, canManage }: { names: (id: string) => string; canManage: boolean }) {
  const voice = useVoiceRoom();
  const { currentUserId } = useRoomRealtime();
  const announce = useAnnounce();
  const [busy, setBusy] = useState(false);
  const pending = voice.recordings.find((recording) => recording.status === 'consent' || recording.status === 'recording') ?? null;
  const finished = voice.recordings.filter((recording) => recording.status === 'stopped');

  const request = async () => {
    const participants = voice.peers.map((peer) => peer.id);
    if (participants.length === 0) { voice.setError('Everyone being recorded must be in voice first.'); return; }
    setBusy(true);
    const result = await requestRecording(voice.roomId, participants);
    setBusy(false);
    if (!result.ok) { voice.setError(result.error); return; }
    voice.setError(null); announce('recordings'); voice.reload();
  };
  const answer = async (recording: Recording, granted: boolean) => {
    const result = await respondRecording(recording.id, granted);
    if (!result.ok) { voice.setError(result.error); return; }
    announce('recordings'); voice.reload();
  };
  const cancel = async (recording: Recording) => {
    const result = await cancelRecording(recording.id);
    if (!result.ok) { voice.setError(result.error); return; }
    announce('recordings'); voice.reload();
  };

  return (
    <div className="voice-recordings">
      <h3 className="voice-heading">Recording</h3>
      {pending ? (
        <div className={`collab-card ${pending.status === 'recording' ? 'is-live' : ''}`} role="status">
          {pending.status === 'recording'
            ? <p className="collab-card-title"><span className="voice-live-dot" aria-hidden="true" /> Recording · everyone listed agreed</p>
            : <p className="collab-card-title">Waiting for everyone to agree</p>}
          <ul className="voice-consents">
            {pending.participants.map((participant) => {
              const decision = voice.consents.find((consent) => consent.recording_id === pending.id && consent.user_id === participant)?.decision;
              return <li key={participant}>{names(participant)}: {decision === 'granted' ? 'agreed' : decision === 'declined' ? 'declined' : 'waiting'}</li>;
            })}
          </ul>
          {pending.status === 'consent' && currentUserId && pending.participants.includes(currentUserId) && !voice.consents.some((consent) => consent.recording_id === pending.id && consent.user_id === currentUserId) && (
            <div className="collab-row">
              <button type="button" className="omni-button omni-button-primary" onClick={() => void answer(pending, true)}>I agree to be recorded</button>
              <button type="button" className="omni-button omni-button-ghost" onClick={() => void answer(pending, false)}>Decline</button>
            </div>
          )}
          {pending.status === 'recording' && pending.requested_by === currentUserId && (
            voice.joined
              ? <button type="button" className="omni-button omni-button-primary" disabled={voice.savingRecording || !voice.recorderRunning} onClick={() => void voice.stopRecording()}>{voice.savingRecording ? 'Saving…' : 'Stop and save'}</button>
              : <p className="collab-meta">Join voice to start recording.</p>
          )}
          {(pending.requested_by === currentUserId || canManage) && <button type="button" className="collab-link is-danger" onClick={() => void cancel(pending)}>Cancel without saving</button>}
        </div>
      ) : canManage ? (
        <div>
          <button type="button" className="omni-button omni-button-ghost" disabled={busy || !voice.joined} onClick={() => void request()}>{busy ? 'Asking…' : 'Ask everyone in voice to record'}</button>
          <p className="collab-meta">Recording starts only after every participant agrees. Files are private to participants and deleted after 7 days.</p>
        </div>
      ) : <p className="collab-meta">Room managers can ask to record; you will be asked for consent.</p>}
      {voice.savingRecording && <p className="collab-meta" role="status">Saving the recording…</p>}
      {finished.length > 0 && (
        <ul className="collab-list">
          {finished.map((recording) => <FinishedRecording key={recording.id} recording={recording} canDelete={recording.requested_by === currentUserId || canManage} />)}
        </ul>
      )}
    </div>
  );
}

function FinishedRecording({ recording, canDelete }: { recording: Recording; canDelete: boolean }) {
  const voice = useVoiceRoom();
  const announce = useAnnounce();
  const [url, setUrl] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const loadTranscript = useCallback(async () => {
    const result = await getTranscript(recording.id);
    if (result.ok) { setBody(result.data?.body ?? ''); setVersion(result.data?.version ?? 0); }
  }, [recording.id]);
  useEffect(() => {
    if (!open) return;
    const timeout = window.setTimeout(() => { void loadTranscript(); }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadTranscript, open]);

  const play = async () => {
    if (!recording.storage_path) return;
    const result = await recordingUrl(recording.id);
    if (!result.ok) { setStatus(result.error); return; }
    setUrl(result.data);
  };
  const save = async () => {
    const result = await saveTranscript(recording.id, version, body);
    if (!result.ok) { setStatus(result.error.includes('expected version') ? 'Someone else saved first. Reload to see their version.' : result.error); return; }
    setVersion(result.data); setStatus('Transcript saved.');
  };
  const remove = async () => {
    const result = await deleteRecording(recording.id);
    if (!result.ok) { setStatus(result.error); return; }
    announce('recordings'); voice.reload();
  };

  return (
    <li className="collab-card">
      <p className="collab-card-title">Recording · {new Date(recording.started_at ?? recording.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</p>
      <p className="collab-meta">{formatDuration(recording.duration_seconds ?? 0)} · deleted {recording.retention_until ? new Date(recording.retention_until).toLocaleDateString() : 'after 7 days'}</p>
      {url ? <audio controls src={url} className="voice-recording-audio" /> : <button type="button" className="collab-link" onClick={() => void play()}>Play</button>}
      <button type="button" className="collab-link" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? 'Hide transcript' : 'Transcript'}</button>
      {open && (
        <div className="collab-form">
          <label className="collab-label" htmlFor={`transcript-${recording.id}`}>Manual transcript</label>
          <textarea id={`transcript-${recording.id}`} className="omni-input collab-textarea" rows={6} value={body} maxLength={200000} onChange={(event) => setBody(event.target.value)} />
          <p className="collab-meta">Typed by participants. Automatic transcription arrives with Lume AI (Action 17).</p>
          <button type="button" className="omni-button omni-button-primary" onClick={() => void save()}>Save transcript</button>
        </div>
      )}
      {canDelete && <button type="button" className="collab-link is-danger" onClick={() => void remove()}>Delete recording</button>}
      {status && <p className="collab-meta" role="status">{status}</p>}
    </li>
  );
}
