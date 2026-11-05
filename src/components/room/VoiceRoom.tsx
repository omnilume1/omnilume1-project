'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRoomRealtime } from '@/components/room/RoomRealtimeProvider';
import { VoiceMesh, type RtcSignal, type VoicePeer } from '@/lib/voice-mesh';
import { useAnnounce, useHintedLoad, useRoomCapabilities } from '@/lib/collab-hooks';
import {
  finishRecording, listConsents, listHands, listRecordings, listVoiceModeration, uploadRecording,
  type HandRaise, type Recording, type RecordingConsent, type VoiceModeration,
} from '@/lib/collab-data';

type VoiceContextValue = {
  roomId: string;
  joined: boolean;
  joining: boolean;
  micEnabled: boolean;
  sharingScreen: boolean;
  peers: VoicePeer[];
  error: string | null;
  moderation: Map<string, VoiceModeration>;
  hands: HandRaise[];
  recordings: Recording[];
  consents: RecordingConsent[];
  recordingActive: boolean;
  recorderRunning: boolean;
  savingRecording: boolean;
  localStream: MediaStream | null;
  screenStream: MediaStream | null;
  join: () => Promise<void>;
  leave: () => void;
  toggleMic: () => void;
  startScreen: () => Promise<void>;
  stopScreen: () => void;
  stopRecording: () => Promise<void>;
  reload: () => void;
  setError: (message: string | null) => void;
};

const VoiceContext = createContext<VoiceContextValue | null>(null);

export function useVoiceRoom() {
  const value = useContext(VoiceContext);
  if (!value) throw new Error('useVoiceRoom must be used inside VoiceRoomProvider');
  return value;
}

function mediaErrorMessage(error: unknown, kind: 'mic' | 'screen') {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError') return kind === 'mic' ? 'Microphone permission was denied.' : 'Screen sharing was cancelled or not allowed.';
  if (name === 'NotFoundError') return kind === 'mic' ? 'No microphone was found.' : 'Nothing is available to share.';
  return kind === 'mic' ? 'Could not start your microphone.' : 'Could not start screen sharing.';
}

// Mounted once per room page (outside the side panel) so voice keeps running
// while members switch tools. Server state (moderation, hands, recordings) is
// re-read on `collab_changed` hints; WebRTC signaling arrives as `rtc_signal`.
export function VoiceRoomProvider({ roomId, children }: { roomId: string; children: ReactNode }) {
  const { currentUserId, subscribeRoomEvents, sendRoomEvent } = useRoomRealtime();
  const capabilities = useRoomCapabilities(roomId);
  const announce = useAnnounce();
  const meshRef = useRef<VoiceMesh | null>(null);
  const [joined, setJoined] = useState(false);
  const [joining, setJoining] = useState(false);
  const [micEnabled, setMicEnabled] = useState(true);
  const [sharingScreen, setSharingScreen] = useState(false);
  const [peers, setPeers] = useState<VoicePeer[]>([]);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moderation, setModeration] = useState<Map<string, VoiceModeration>>(() => new Map());
  const [hands, setHands] = useState<HandRaise[]>([]);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [consents, setConsents] = useState<RecordingConsent[]>([]);
  const [recorderRunning, setRecorderRunning] = useState(false);
  const [savingRecording, setSavingRecording] = useState(false);
  const recorderRef = useRef<{ recorder: MediaRecorder; context: AudioContext; destination: MediaStreamAudioDestinationNode; connected: Set<string>; chunks: Blob[]; recordingId: string; startedAt: number } | null>(null);

  const syncFromMesh = useCallback(() => {
    const mesh = meshRef.current;
    setPeers(mesh ? mesh.peerList() : []);
    setSharingScreen(Boolean(mesh?.isSharingScreen));
    setScreenStream(mesh?.screenStream ?? null);
    setLocalStream(mesh?.localStream ?? null);
  }, []);

  const reload = useCallback(() => {
    void (async () => {
      const [mod, handRows, recs, consentRows] = await Promise.all([listVoiceModeration(roomId), listHands(roomId), listRecordings(roomId), listConsents(roomId)]);
      if (mod.ok) setModeration(new Map(mod.data.map((row) => [row.user_id, row])));
      if (handRows.ok) setHands(handRows.data);
      if (recs.ok) setRecordings(recs.data);
      if (consentRows.ok) setConsents(consentRows.data);
    })();
  }, [roomId]);
  useHintedLoad(['voice', 'hands', 'recordings'], reload);

  // Signaling. Messages for other members are ignored inside the mesh.
  useEffect(() => subscribeRoomEvents((event) => {
    if (event.type !== 'rtc_signal') return;
    void meshRef.current?.handleSignal(event.senderId, event.payload as RtcSignal);
  }), [subscribeRoomEvents]);

  const myModeration = currentUserId ? moderation.get(currentUserId) : undefined;
  const forcedMute = Boolean(myModeration?.audio_muted);
  const screenBlocked = Boolean(myModeration?.screen_blocked);

  // The muted member's own client stops sending; listeners also silence that
  // member locally (VoiceAudio below), so a modified client cannot bypass it.
  useEffect(() => {
    if (forcedMute) meshRef.current?.setMicEnabled(false);
    else meshRef.current?.setMicEnabled(micEnabled);
  }, [forcedMute, micEnabled]);
  useEffect(() => {
    if (screenBlocked && meshRef.current?.isSharingScreen) meshRef.current.stopScreen();
  }, [screenBlocked]);

  const join = useCallback(async () => {
    if (!currentUserId || meshRef.current?.isJoined || joining) return;
    if (!capabilities.chat) { setError('Voice is not available to your room role.'); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') { setError('This browser does not support voice.'); return; }
    setJoining(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      const mesh = new VoiceMesh(currentUserId, (signal) => sendRoomEvent('rtc_signal', signal as unknown as Record<string, unknown>), syncFromMesh);
      meshRef.current = mesh;
      mesh.join(stream);
      mesh.setMicEnabled(!forcedMute && micEnabled);
      setJoined(true);
      setError(null);
    } catch (joinError) {
      setError(mediaErrorMessage(joinError, 'mic'));
    } finally {
      setJoining(false);
    }
  }, [capabilities.chat, currentUserId, forcedMute, joining, micEnabled, sendRoomEvent, syncFromMesh]);

  const stopRecorder = useCallback(async (save: boolean) => {
    const active = recorderRef.current;
    if (!active) return;
    recorderRef.current = null;
    setRecorderRunning(false);
    const done = new Promise<void>((resolve) => { active.recorder.addEventListener('stop', () => resolve(), { once: true }); });
    if (active.recorder.state !== 'inactive') active.recorder.stop();
    await done;
    void active.context.close();
    if (!save) return;
    setSavingRecording(true);
    const type = active.recorder.mimeType.split(';')[0] || 'audio/webm';
    const blob = new Blob(active.chunks, { type });
    const extension = type === 'audio/ogg' ? 'ogg' : type === 'audio/mp4' ? 'm4a' : 'webm';
    const path = `${roomId}/${active.recordingId}.${extension}`;
    const upload = await uploadRecording(path, blob);
    const finish = upload.ok ? await finishRecording(active.recordingId, path, (Date.now() - active.startedAt) / 1000) : upload;
    setSavingRecording(false);
    if (!finish.ok) setError(finish.error);
    announce('recordings');
    reload();
  }, [announce, reload, roomId]);

  const leave = useCallback(() => {
    void stopRecorder(true);
    meshRef.current?.leave();
    meshRef.current = null;
    setJoined(false);
    syncFromMesh();
  }, [stopRecorder, syncFromMesh]);

  useEffect(() => () => {
    meshRef.current?.leave();
    meshRef.current = null;
  }, [roomId]);

  const toggleMic = useCallback(() => {
    if (forcedMute) { setError('A room manager muted you. They can unmute you.'); return; }
    setMicEnabled((current) => !current);
  }, [forcedMute]);

  const startScreen = useCallback(async () => {
    const mesh = meshRef.current;
    if (!mesh) return;
    if (screenBlocked) { setError('A room manager stopped your screen sharing.'); return; }
    if (!navigator.mediaDevices?.getDisplayMedia) { setError('This browser does not support screen sharing.'); return; }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
      mesh.startScreen(stream);
      setError(null);
    } catch (screenError) {
      setError(mediaErrorMessage(screenError, 'screen'));
    }
  }, [screenBlocked]);

  const stopScreen = useCallback(() => { meshRef.current?.stopScreen(); }, []);

  // Recording: only the requester's client records, only after every listed
  // participant consented (status 'recording' is set by the database), and
  // only while that client is in voice. Audio from the mic and every peer is
  // mixed locally; nothing is sent anywhere until it is uploaded to the
  // private recordings bucket.
  const activeRecording = recordings.find((recording) => recording.status === 'recording') ?? null;
  const shouldRecord = Boolean(activeRecording && activeRecording.requested_by === currentUserId && joined);
  useEffect(() => {
    if (!shouldRecord || !activeRecording || recorderRef.current || typeof MediaRecorder === 'undefined') return;
    const context = new AudioContext();
    const destination = context.createMediaStreamDestination();
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(destination.stream, mimeType ? { mimeType } : undefined);
    const state = { recorder, context, destination, connected: new Set<string>(), chunks: [] as Blob[], recordingId: activeRecording.id, startedAt: Date.now() };
    recorder.addEventListener('dataavailable', (event) => { if (event.data.size > 0) state.chunks.push(event.data); });
    recorder.start(1000);
    recorderRef.current = state;
    const timeout = window.setTimeout(() => setRecorderRunning(true), 0);
    return () => window.clearTimeout(timeout);
  }, [activeRecording, shouldRecord]);
  useEffect(() => {
    const active = recorderRef.current;
    if (!active) return;
    const sources: Array<[string, MediaStream | null]> = [['self', localStream], ...peers.map((peer) => [peer.id, peer.audio] as [string, MediaStream | null])];
    for (const [id, stream] of sources) {
      if (!stream || active.connected.has(id) || stream.getAudioTracks().length === 0) continue;
      active.context.createMediaStreamSource(stream).connect(active.destination);
      active.connected.add(id);
    }
  }, [localStream, peers, recorderRunning]);
  // Cancelled elsewhere (or the requester left voice): stop, keep nothing.
  useEffect(() => {
    if (recorderRef.current && !shouldRecord) {
      const stillRecording = recordings.some((recording) => recording.id === recorderRef.current?.recordingId && recording.status === 'recording');
      void stopRecorder(stillRecording);
    }
  }, [recordings, shouldRecord, stopRecorder]);

  const stopRecording = useCallback(async () => { await stopRecorder(true); }, [stopRecorder]);

  const value = useMemo<VoiceContextValue>(() => ({
    roomId, joined, joining, micEnabled: micEnabled && !forcedMute, sharingScreen, peers, error, moderation, hands,
    recordings, consents, recordingActive: Boolean(activeRecording), recorderRunning, savingRecording,
    localStream, screenStream, join, leave, toggleMic, startScreen, stopScreen, stopRecording, reload, setError,
  }), [activeRecording, consents, error, forcedMute, hands, join, joined, joining, leave, localStream, micEnabled, moderation, peers, recorderRunning, recordings, reload, roomId, savingRecording, screenStream, sharingScreen, startScreen, stopRecording, stopScreen, toggleMic]);

  return (
    <VoiceContext.Provider value={value}>
      {children}
      {/* Remote voices play here so they continue while the panel is closed. */}
      <div hidden>
        {peers.map((peer) => (
          <VoiceAudio key={peer.id} stream={peer.audio} muted={Boolean(moderation.get(peer.id)?.audio_muted)} />
        ))}
      </div>
    </VoiceContext.Provider>
  );
}

function VoiceAudio({ stream, muted }: { stream: MediaStream | null; muted: boolean }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (element.srcObject !== stream) element.srcObject = stream;
    element.muted = muted;
    if (stream) void element.play().catch(() => undefined);
  }, [muted, stream]);
  return <audio ref={ref} autoPlay data-voice-peer-audio={muted ? 'muted' : 'live'} />;
}

export function VideoStream({ stream, label }: { stream: MediaStream; label: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (element && element.srcObject !== stream) element.srcObject = stream;
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted className="voice-screen-video" aria-label={label} />;
}
