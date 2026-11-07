'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRoomRealtime } from '@/components/room/RoomRealtimeProvider';
import { PEER_TIMEOUT_MS, VoiceMesh, type RtcSignal, type VoicePeer } from '@/lib/voice-mesh';
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
  // False while joined only to watch a shared tab (no microphone).
  hasMic: boolean;
  canUseVoice: boolean;
  // Other members sharing a tab or screen right now, known even before this
  // member joins voice (from the room's `hello` heartbeats).
  liveSharers: string[];
  shareVolume: number;
  shareMuted: boolean;
  shareSoundBlocked: boolean;
  setShareVolume: (volume: number) => void;
  setShareMuted: (muted: boolean) => void;
  resumeShareSound: () => void;
  join: (options?: { mic?: boolean }) => Promise<void>;
  enableMic: () => Promise<void>;
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

const getMic = () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });

function voiceUnavailable(chatAllowed: boolean) {
  if (!chatAllowed) return 'Voice is not available to your room role.';
  if (typeof RTCPeerConnection === 'undefined') return 'This browser does not support voice.';
  return null;
}

// A shared tab at up to 720p and 30 fps, with the tab's own sound. Chrome and
// Edge open on the tab list; the room's own tab is left out of it.
export const TAB_SHARE_CONSTRAINTS = {
  video: { frameRate: { ideal: 30, max: 30 }, width: { max: 1280 }, height: { max: 720 }, displaySurface: 'browser' },
  audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  selfBrowserSurface: 'exclude',
  surfaceSwitching: 'include',
  systemAudio: 'include',
} as DisplayMediaStreamOptions;

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
  const { currentUserId, subscribeRoomEvents, sendRoomEvent, connectionState, connectionGeneration } = useRoomRealtime();
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
  const [hasMic, setHasMic] = useState(false);
  const [sharerSeen, setSharerSeen] = useState<Map<string, number>>(() => new Map());
  const [shareVolume, setShareVolume] = useState(1);
  const [shareMuted, setShareMuted] = useState(false);
  const [shareSoundBlocked, setShareSoundBlocked] = useState(false);
  const [soundNonce, setSoundNonce] = useState(0);

  const syncFromMesh = useCallback(() => {
    const mesh = meshRef.current;
    setPeers(mesh ? mesh.peerList() : []);
    setSharingScreen(Boolean(mesh?.isSharingScreen));
    setScreenStream(mesh?.screenStream ?? null);
    setLocalStream(mesh?.localStream ?? null);
    setHasMic(Boolean(mesh?.hasMic));
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

  // Signaling. Messages for other members are ignored inside the mesh. Every
  // member (in voice or not) notes who announces a share, so the stage can
  // offer "Watch" before anyone joins voice.
  useEffect(() => subscribeRoomEvents((event) => {
    if (event.type !== 'rtc_signal') return;
    const signal = event.payload as RtcSignal;
    if (event.senderId !== currentUserId && (signal.kind === 'bye' || (signal.kind === 'hello' && typeof signal.screen === 'boolean'))) {
      const sharing = signal.kind === 'hello' && signal.screen === true;
      setSharerSeen((current) => {
        if (!sharing && !current.has(event.senderId)) return current;
        const next = new Map(current);
        if (sharing) next.set(event.senderId, Date.now()); else next.delete(event.senderId);
        return next;
      });
    }
    void meshRef.current?.handleSignal(event.senderId, signal);
  }), [currentUserId, subscribeRoomEvents]);

  // Ask who is sharing whenever the room connection (re)opens.
  useEffect(() => {
    if (connectionState === 'connected' && capabilities.chat) sendRoomEvent('rtc_signal', { kind: 'who' });
  }, [capabilities.chat, connectionGeneration, connectionState, sendRoomEvent]);

  // A sharer that stops sending heartbeats (closed tab, lost network) is dropped.
  useEffect(() => {
    if (sharerSeen.size === 0) return;
    const timer = window.setInterval(() => {
      const cutoff = Date.now() - PEER_TIMEOUT_MS;
      setSharerSeen((current) => {
        if (![...current.values()].some((seen) => seen < cutoff)) return current;
        return new Map([...current].filter(([, seen]) => seen >= cutoff));
      });
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [sharerSeen.size]);

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

  // Joins the mesh synchronously (no await) so a screen picker opened in the
  // same click still has the user's gesture.
  const openMesh = useCallback((local: MediaStream | null) => {
    if (!currentUserId) return null;
    const mesh = new VoiceMesh(currentUserId, (signal) => sendRoomEvent('rtc_signal', signal as unknown as Record<string, unknown>), syncFromMesh);
    meshRef.current = mesh;
    mesh.join(local);
    mesh.setMicEnabled(!forcedMute && micEnabled);
    setJoined(true);
    setError(null);
    return mesh;
  }, [currentUserId, forcedMute, micEnabled, sendRoomEvent, syncFromMesh]);

  // `mic: false` joins only to watch and listen; the browser asks for nothing.
  const join = useCallback(async (options?: { mic?: boolean }) => {
    if (!currentUserId || meshRef.current?.isJoined || joining) return;
    const unavailable = voiceUnavailable(capabilities.chat);
    if (unavailable) { setError(unavailable); return; }
    if (options?.mic === false) { openMesh(null); return; }
    if (!navigator.mediaDevices?.getUserMedia) { setError('This browser does not support voice.'); return; }
    setJoining(true);
    try {
      const stream = await getMic();
      if (meshRef.current?.isJoined) meshRef.current.addMic(stream);
      else openMesh(stream);
    } catch (joinError) {
      setError(mediaErrorMessage(joinError, 'mic'));
    } finally {
      setJoining(false);
    }
  }, [capabilities.chat, currentUserId, joining, openMesh]);

  const enableMic = useCallback(async () => {
    const mesh = meshRef.current;
    if (!mesh?.isJoined || mesh.hasMic || joining) return;
    if (!navigator.mediaDevices?.getUserMedia) { setError('This browser does not support voice.'); return; }
    setJoining(true);
    try {
      const stream = await getMic();
      if (meshRef.current === mesh && mesh.isJoined) { mesh.addMic(stream); mesh.setMicEnabled(!forcedMute && micEnabled); setError(null); }
      else stream.getTracks().forEach((track) => track.stop());
    } catch (micError) {
      setError(mediaErrorMessage(micError, 'mic'));
    } finally {
      setJoining(false);
    }
  }, [forcedMute, joining, micEnabled]);

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

  // Works without joining voice first: the picker opens straight from the
  // click, then the member joins watch-only (no microphone) to send it.
  const startScreen = useCallback(async () => {
    if (screenBlocked) { setError('A room manager stopped your screen sharing.'); return; }
    const unavailable = voiceUnavailable(capabilities.chat);
    if (unavailable) { setError(unavailable); return; }
    if (!navigator.mediaDevices?.getDisplayMedia) { setError('This browser does not support screen sharing.'); return; }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia(TAB_SHARE_CONSTRAINTS);
    } catch (screenError) {
      setError(mediaErrorMessage(screenError, 'screen'));
      return;
    }
    const mesh = meshRef.current?.isJoined ? meshRef.current : openMesh(null);
    if (!mesh) { stream.getTracks().forEach((track) => track.stop()); return; }
    mesh.startScreen(stream);
    setError(null);
  }, [capabilities.chat, openMesh, screenBlocked]);

  // Remote tab sound plays from one hidden element per sharer; a browser that
  // blocks it until the next click reports it so the stage can offer a button.
  const resumeShareSound = useCallback(() => { setShareSoundBlocked(false); setSoundNonce((value) => value + 1); }, []);
  const markShareSoundBlocked = useCallback(() => setShareSoundBlocked(true), []);

  const liveSharers = useMemo(() => {
    const blocked = (id: string) => Boolean(moderation.get(id)?.screen_blocked);
    const ids = new Set<string>([...sharerSeen.keys()]);
    for (const peer of peers) if (peer.sharingScreen) ids.add(peer.id);
    return [...ids].filter((id) => id !== currentUserId && !blocked(id));
  }, [currentUserId, moderation, peers, sharerSeen]);

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
    localStream, screenStream, hasMic, canUseVoice: capabilities.chat, liveSharers, shareVolume, shareMuted, shareSoundBlocked,
    setShareVolume, setShareMuted, resumeShareSound,
    join, enableMic, leave, toggleMic, startScreen, stopScreen, stopRecording, reload, setError,
  }), [activeRecording, capabilities.chat, consents, enableMic, error, forcedMute, hands, hasMic, join, joined, joining, leave, liveSharers, localStream, micEnabled, moderation, peers, recorderRunning, recordings, reload, resumeShareSound, roomId, savingRecording, screenStream, shareMuted, shareSoundBlocked, shareVolume, sharingScreen, startScreen, stopRecording, stopScreen, toggleMic]);

  return (
    <VoiceContext.Provider value={value}>
      {children}
      {/* Remote voices and shared-tab sound play here so they continue while the panel is closed. */}
      <div hidden>
        {peers.map((peer) => (
          <VoiceAudio key={peer.id} stream={peer.audio} muted={Boolean(moderation.get(peer.id)?.audio_muted)} />
        ))}
        {peers.filter((peer) => peer.screen && liveSharers.includes(peer.id)).map((peer) => (
          <ShareAudio key={`${peer.id}-${soundNonce}`} stream={peer.screen as MediaStream} volume={shareVolume} muted={shareMuted} onBlocked={markShareSoundBlocked} />
        ))}
      </div>
    </VoiceContext.Provider>
  );
}

function ShareAudio({ stream, volume, muted, onBlocked }: { stream: MediaStream; volume: number; muted: boolean; onBlocked: () => void }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (element.srcObject !== stream) element.srcObject = stream;
    void element.play().catch((playError: unknown) => { if (playError instanceof DOMException && playError.name === 'NotAllowedError') onBlocked(); });
  }, [onBlocked, stream]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.volume = Math.min(1, Math.max(0, volume));
    element.muted = muted;
  }, [muted, volume]);
  return <audio ref={ref} autoPlay data-share-audio="live" />;
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
