'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRoomRealtime } from '@/components/room/RoomRealtimeProvider';
import { PEER_TIMEOUT_MS, VoiceMesh, loadIceServers, type RtcSignal, type VoicePeer } from '@/lib/voice-mesh';
import { VOICE_CHAIRS, chairsTakenMessage, isFull, nextChairStep, pruneSeen, screenFullMessage, seatedIds } from '@/lib/voice-seats';
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
  // How loud each member's voice plays for this listener only (0 to 2, 1 = as sent).
  memberVolumes: Record<string, number>;
  setMemberVolume: (userId: string, volume: number) => void;
  resumeShareSound: () => void;
  // Set when a join was refused because every chair is taken ('mic' or watch-only).
  floor: 'mic' | 'watch' | null;
  // "Take the next chair": join on our own when a chair frees up.
  nextChair: boolean;
  takeNextChair: (on: boolean) => Promise<void>;
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

function samePeers(a: VoicePeer[], b: VoicePeer[]) {
  return a.length === b.length && a.every((peer, index) => {
    const other = b[index];
    return peer.id === other.id && peer.audio === other.audio && peer.screen === other.screen && peer.state === other.state
      && peer.sharingScreen === other.sharingScreen && peer.hasMic === other.hasMic;
  });
}

const getMic = () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });

function voiceUnavailable(chatAllowed: boolean) {
  if (!chatAllowed) return 'Voice is not available to your room role.';
  if (typeof RTCPeerConnection === 'undefined') return 'This browser does not support voice.';
  return null;
}

// A shared tab at up to 1080p and 30 fps, with the tab's own sound. A tab is
// captured at its on-screen size, so 1080p needs the video in full screen on a
// 1080p display. Chrome and Edge open on the tab list; the room's own tab is
// left out of it.
export const TAB_SHARE_CONSTRAINTS = {
  video: { frameRate: { ideal: 30, max: 30 }, width: { max: 1920 }, height: { max: 1080 }, displaySurface: 'browser' },
  audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  selfBrowserSurface: 'exclude',
  surfaceSwitching: 'exclude',
  systemAudio: 'include',
} as DisplayMediaStreamOptions;

// Per-member voice volume, saved on this device for every room.
const VOLUME_KEY = 'omnilume:voice-volumes';
export const MAX_MEMBER_VOLUME = 2;
function readMemberVolumes(): Record<string, number> {
  try {
    const value = JSON.parse(window.localStorage.getItem(VOLUME_KEY) ?? '{}') as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] >= 0 && entry[1] <= MAX_MEMBER_VOLUME));
  } catch {
    return {};
  }
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
  const [sharerSeen, setSharerSeen] = useState<Set<string>>(() => new Set());
  const sharerSeenAt = useRef(new Map<string, number>());
  // Six chairs: everyone heard saying `hello` (so in voice), with their join time.
  const voicers = useRef(new Map<string, { at?: number; seen: number }>());
  const [floor, setFloorState] = useState<'mic' | 'watch' | null>(null);
  const floorRef = useRef<'mic' | 'watch' | null>(null);
  const [nextChair, setNextChairState] = useState(false);
  const nextChairRef = useRef(false);
  const joinBusy = useRef(false);
  // When another member's rtc_signal was last heard: silence from everyone is not a free chair.
  const heardAt = useRef(0);
  // False once the room page has gone, so a join still waiting opens nothing.
  const alive = useRef(true);
  const seatCheck = useRef<() => void>(() => undefined);
  const [shareVolume, setShareVolume] = useState(1);
  const [shareMuted, setShareMuted] = useState(false);
  const [shareSoundBlocked, setShareSoundBlocked] = useState(false);
  const [soundNonce, setSoundNonce] = useState(0);
  // The room renders client-side only (after the access check), so storage is readable here.
  const [memberVolumes, setMemberVolumes] = useState<Record<string, number>>(readMemberVolumes);
  const setMemberVolume = useCallback((userId: string, volume: number) => {
    const level = Math.round(Math.min(MAX_MEMBER_VOLUME, Math.max(0, volume)) * 100) / 100;
    // Called from the slider, so this click can start the boost's audio context.
    if (level > 1) getBoostContext();
    setMemberVolumes((current) => {
      const next = { ...current };
      if (level === 1) delete next[userId]; else next[userId] = level;
      try { window.localStorage.setItem(VOLUME_KEY, JSON.stringify(next)); } catch { /* storage blocked: the level lasts for this visit */ }
      return next;
    });
  }, []);

  // The mesh reports every signal (ICE candidates, heartbeats); the room only
  // re-renders when something a member can see changed.
  const syncFromMesh = useCallback(() => {
    const mesh = meshRef.current;
    const next = mesh ? mesh.peerList() : [];
    setPeers((current) => (samePeers(current, next) ? current : next));
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
    if (event.senderId !== currentUserId) heardAt.current = Date.now();
    if (event.senderId !== currentUserId && (signal.kind === 'bye' || (signal.kind === 'hello' && typeof signal.screen === 'boolean'))) {
      const id = event.senderId;
      const sharing = signal.kind === 'hello' && signal.screen === true;
      // Heartbeats only refresh the time; the room re-renders when a share starts or ends.
      if (sharing) sharerSeenAt.current.set(id, Date.now()); else sharerSeenAt.current.delete(id);
      setSharerSeen((current) => {
        if (current.has(id) === sharing) return current;
        const next = new Set(current);
        if (sharing) next.add(id); else next.delete(id);
        return next;
      });
    }
    // Seats: any hello (heartbeat, introduction or `who` answer) means that member is in voice.
    if (event.senderId !== currentUserId && (signal.kind === 'hello' || signal.kind === 'bye')) {
      const id = event.senderId;
      const before = voicers.current.get(id);
      if (signal.kind === 'bye') {
        if (voicers.current.delete(id)) seatCheck.current();
      } else {
        const at = typeof signal.at === 'number' ? signal.at : undefined;
        voicers.current.set(id, { at, seen: Date.now() });
        if (!before || before.at !== at) seatCheck.current();
      }
    }
    void meshRef.current?.handleSignal(event.senderId, signal);
  }), [currentUserId, subscribeRoomEvents]);

  // A member in voice who stops sending heartbeats frees their chair after PEER_TIMEOUT_MS.
  useEffect(() => {
    const timer = window.setInterval(() => { if (pruneSeen(voicers.current, Date.now(), PEER_TIMEOUT_MS)) seatCheck.current(); }, 4_000);
    return () => window.clearInterval(timer);
  }, []);

  // Ask who is in voice (and sharing) whenever the room connection (re)opens.
  useEffect(() => {
    if (connectionState === 'connected' && capabilities.chat) sendRoomEvent('rtc_signal', { kind: 'who' });
  }, [capabilities.chat, connectionGeneration, connectionState, sendRoomEvent]);

  // A sharer that stops sending heartbeats (closed tab, lost network) is dropped.
  useEffect(() => {
    if (sharerSeen.size === 0) return;
    const timer = window.setInterval(() => {
      const cutoff = Date.now() - PEER_TIMEOUT_MS;
      const seenAt = sharerSeenAt.current;
      for (const [id, seen] of seenAt) if (seen < cutoff) seenAt.delete(id);
      setSharerSeen((current) => ([...current].every((id) => seenAt.has(id)) ? current : new Set([...current].filter((id) => seenAt.has(id)))));
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

  // Fetch relay credentials before anyone joins, so the first peers use them.
  useEffect(() => { if (currentUserId) void loadIceServers(); }, [currentUserId]);

  // Joins the mesh synchronously (no await) so a screen picker opened in the
  // same click still has the user's gesture.
  const openMesh = useCallback((local: MediaStream | null) => {
    if (!currentUserId || !alive.current) { local?.getTracks().forEach((track) => track.stop()); return null; }
    const mesh = new VoiceMesh(currentUserId, (signal) => sendRoomEvent('rtc_signal', signal as unknown as Record<string, unknown>), syncFromMesh);
    meshRef.current = mesh;
    mesh.join(local);
    mesh.setMicEnabled(!forcedMute && micEnabled);
    setJoined(true);
    setError(null);
    floorRef.current = null;
    setFloorState(null);
    // A newcomer who joined in the same moment may hold an earlier chair (checked once the hellos land).
    window.setTimeout(() => seatCheck.current(), 0);
    return mesh;
  }, [currentUserId, forcedMute, micEnabled, sendRoomEvent, syncFromMesh]);

  // Six chairs: ask who is in voice, give the answers about 1.5 s, then count.
  // An automatic join also needs the question to have been sent (no answers from a dead channel).
  const chairFree = useCallback(async (auto = false) => {
    const sent = sendRoomEvent('rtc_signal', { kind: 'who' });
    await new Promise((resolve) => window.setTimeout(resolve, 1_500));
    pruneSeen(voicers.current, Date.now(), PEER_TIMEOUT_MS);
    return (sent || !auto) && !isFull(voicers.current.size, VOICE_CHAIRS);
  }, [sendRoomEvent]);

  const toFloor = useCallback((mode: 'mic' | 'watch') => {
    floorRef.current = mode;
    setFloorState(mode);
    setError(mode === 'watch' ? screenFullMessage(VOICE_CHAIRS) : chairsTakenMessage(VOICE_CHAIRS));
  }, []);

  // `mic: false` joins only to watch and listen; the browser asks for nothing.
  // When every chair is taken no mesh is made at all: the member stays on the floor.
  // `auto` is "Take the next chair" joining on its own: turning the toggle off
  // while it waits cancels it.
  const join = useCallback(async (options?: { mic?: boolean; auto?: boolean }) => {
    if (!currentUserId || meshRef.current?.isJoined || joinBusy.current) return;
    const unavailable = voiceUnavailable(capabilities.chat);
    if (unavailable) { setError(unavailable); return; }
    const watchOnly = options?.mic === false;
    const auto = Boolean(options?.auto);
    if (!watchOnly && !navigator.mediaDevices?.getUserMedia) { setError('This browser does not support voice.'); return; }
    const cancelled = () => !alive.current || (auto && !nextChairRef.current);
    joinBusy.current = true;
    setJoining(true);
    try {
      const free = await chairFree(auto);
      if (cancelled()) return;
      if (!free) { if (!meshRef.current?.isJoined) toFloor(watchOnly ? 'watch' : 'mic'); return; }
      if (watchOnly) { if (!meshRef.current?.isJoined) openMesh(null); return; }
      const stream = await getMic();
      if (meshRef.current?.isJoined) { meshRef.current.addMic(stream); return; }
      // The mic prompt can stay open for seconds: count again, so a room that filled meanwhile gets no 7th peer.
      pruneSeen(voicers.current, Date.now(), PEER_TIMEOUT_MS);
      const full = isFull(voicers.current.size, VOICE_CHAIRS);
      if (cancelled() || full) { stream.getTracks().forEach((track) => track.stop()); if (full && alive.current) toFloor('mic'); return; }
      openMesh(stream);
    } catch (joinError) {
      setError(mediaErrorMessage(joinError, 'mic'));
      // A refused or missing mic would fail every automatic try too.
      nextChairRef.current = false;
      setNextChairState(false);
    } finally {
      joinBusy.current = false;
      setJoining(false);
    }
  }, [capabilities.chat, chairFree, currentUserId, openMesh, toFloor]);

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

  const leaveMesh = useCallback(() => {
    void stopRecorder(true);
    meshRef.current?.leave();
    meshRef.current = null;
    setJoined(false);
    syncFromMesh();
  }, [stopRecorder, syncFromMesh]);

  // Leaving on purpose also stops waiting for a chair.
  const leave = useCallback(() => {
    leaveMesh();
    nextChairRef.current = false;
    setNextChairState(false);
  }, [leaveMesh]);

  // Runs whenever the members in voice change. In voice: if two people took the
  // last chair at once, the later `at` (then the higher id) gives it up and goes
  // to the floor. On the floor with "Take the next chair" on: join when one frees.
  useEffect(() => {
    seatCheck.current = () => {
      const mesh = meshRef.current;
      if (!currentUserId) return;
      pruneSeen(voicers.current, Date.now(), PEER_TIMEOUT_MS);
      const members = [...voicers.current].map(([id, entry]) => ({ id, at: entry.at }));
      if (mesh?.isJoined) {
        if (seatedIds([...members, { id: currentUserId, at: mesh.joinedTime }], VOICE_CHAIRS).has(currentUserId)) return;
        const mode = mesh.hasMic ? 'mic' : 'watch';
        leaveMesh();
        toFloor(mode);
        return;
      }
      if (!nextChairRef.current || joinBusy.current) return;
      const watchOnly = floorRef.current === 'watch';
      const step = nextChairStep({
        count: members.length, cap: VOICE_CHAIRS, watchOnly, shareLive: sharerSeenAt.current.size > 0,
        connected: connectionState === 'connected', heardAgoMs: Date.now() - heardAt.current, timeoutMs: PEER_TIMEOUT_MS,
      });
      if (step === 'join') void join(watchOnly ? { mic: false, auto: true } : { auto: true });
      // The answers (hellos) run this check again.
      else if (step === 'ask') sendRoomEvent('rtc_signal', { kind: 'who' });
      else if (step === 'give-up') {
        nextChairRef.current = false;
        setNextChairState(false);
        floorRef.current = null;
        setFloorState(null);
        setError((current) => (current === screenFullMessage(VOICE_CHAIRS) ? null : current));
      }
    };
  });

  // The toggle tap is the user gesture, so the mic permission is asked for now
  // (and released at once); the automatic join later needs no prompt.
  const takeNextChair = useCallback(async (on: boolean) => {
    if (on && floorRef.current !== 'watch') {
      if (!navigator.mediaDevices?.getUserMedia) { setError('This browser does not support voice.'); return; }
      try {
        const probe = await getMic();
        probe.getTracks().forEach((track) => track.stop());
      } catch (micError) {
        setError(mediaErrorMessage(micError, 'mic'));
        return;
      }
    }
    nextChairRef.current = on;
    setNextChairState(on);
    if (on) seatCheck.current();
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      meshRef.current?.leave();
      meshRef.current = null;
    };
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
    if (!navigator.mediaDevices?.getDisplayMedia) { setError('Screen sharing works from a computer.'); return; }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia(TAB_SHARE_CONSTRAINTS);
    } catch (screenError) {
      setError(mediaErrorMessage(screenError, 'screen'));
      return;
    }
    // Sharing from outside voice joins watch-only, so it needs a free chair too.
    if (!meshRef.current?.isJoined && !(await chairFree())) {
      stream.getTracks().forEach((track) => track.stop());
      if (!meshRef.current?.isJoined) toFloor('watch');
      return;
    }
    const mesh = meshRef.current?.isJoined ? meshRef.current : openMesh(null);
    if (!mesh) { stream.getTracks().forEach((track) => track.stop()); return; }
    mesh.startScreen(stream);
    setError(null);
  }, [capabilities.chat, chairFree, openMesh, screenBlocked, toFloor]);

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
    setShareVolume, setShareMuted, resumeShareSound, memberVolumes, setMemberVolume, floor, nextChair, takeNextChair,
    join, enableMic, leave, toggleMic, startScreen, stopScreen, stopRecording, reload, setError,
  }), [activeRecording, capabilities.chat, consents, enableMic, error, floor, forcedMute, hands, hasMic, join, joined, joining, leave, liveSharers, localStream, memberVolumes, micEnabled, moderation, nextChair, peers, recorderRunning, recordings, reload, resumeShareSound, roomId, savingRecording, screenStream, setMemberVolume, shareMuted, shareSoundBlocked, shareVolume, sharingScreen, startScreen, stopRecording, stopScreen, takeNextChair, toggleMic]);

  return (
    <VoiceContext.Provider value={value}>
      {children}
      {/* Remote voices and shared-tab sound play here so they continue while the panel is closed. */}
      <div hidden>
        {peers.map((peer) => (
          <VoiceAudio key={peer.id} stream={peer.audio} muted={Boolean(moderation.get(peer.id)?.audio_muted)} volume={memberVolumes[peer.id] ?? 1} />
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

// One shared context plays every boosted voice.
let boostContext: AudioContext | null = null;
function getBoostContext() {
  if (typeof AudioContext === 'undefined') return null;
  boostContext ??= new AudioContext();
  if (boostContext.state === 'suspended') void boostContext.resume().catch(() => undefined);
  return boostContext;
}

// Up to 100% the element plays the voice at `volume`. A manager's mute wins.
function VoiceAudio({ stream, muted, volume }: { stream: MediaStream | null; muted: boolean; volume: number }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const boosting = Boolean(stream) && !muted && volume > 1;
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (element.srcObject !== stream) element.srcObject = stream;
    element.volume = Math.min(1, Math.max(0, volume));
    if (!boosting) element.muted = muted;
    if (stream) void element.play().catch(() => undefined);
  }, [boosting, muted, stream, volume]);
  // Above 100% a gain node plays the voice and the element goes quiet, but
  // only while the audio context runs (Safari starts it on a click), so the
  // voice never drops out. The element keeps playing muted: Chrome feeds a
  // remote stream to Web Audio only while an element plays it.
  useEffect(() => {
    const element = ref.current;
    const context = boosting && stream ? getBoostContext() : null;
    if (!element || !context || !stream) return;
    let source: MediaStreamAudioSourceNode;
    try { source = context.createMediaStreamSource(stream); } catch { return; }
    const gain = context.createGain();
    source.connect(gain).connect(context.destination);
    gainRef.current = gain;
    const sync = () => { element.muted = context.state === 'running'; };
    sync();
    context.addEventListener('statechange', sync);
    return () => { context.removeEventListener('statechange', sync); source.disconnect(); gain.disconnect(); gainRef.current = null; };
  }, [boosting, stream]);
  useEffect(() => { if (gainRef.current) gainRef.current.gain.value = volume; }, [boosting, volume]);
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
