import { screenBitrate, shouldInitiateOffer, withStereoOpus } from '@/lib/collab-model';

// Peer-to-peer voice and screen share (Action 12). No managed media provider
// is configured, so this is the provider-neutral free path: a full mesh of
// RTCPeerConnections (fine for small study rooms), public STUN for address
// discovery, plus a TURN relay from /api/ice-servers when one is configured
// (without it, members behind strict NATs may fail to connect). Signaling
// travels as `rtc_signal` events on the private, chat-capability-scoped room
// topic through useRoomSync.
//
// Negotiation follows the "perfect negotiation" pattern: either side may
// renegotiate (e.g. to add a screen track); on an offer collision the polite
// peer (the higher user id) rolls back and the impolite peer's offer wins.
//
// Members may join without a microphone ("watch only") to receive a shared
// screen. A shared screen carries its video and, when the browser allows it, its
// sound: both tracks travel in one MediaStream, so the receiver tells tab
// sound from a microphone by the stream they arrive in.

export type RtcSignal = {
  to?: string;
  kind: 'hello' | 'bye' | 'offer' | 'answer' | 'ice' | 'who';
  sdp?: string;
  candidate?: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
  screen?: boolean;
  mic?: boolean;
  watching?: boolean;
};

export type VoicePeer = {
  id: string;
  audio: MediaStream | null;
  screen: MediaStream | null;
  state: RTCPeerConnectionState | 'new';
  sharingScreen: boolean;
  hasMic: boolean;
};

type PeerEntry = {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  audio: MediaStream | null;
  screen: MediaStream | null;
  screenSenders: RTCRtpSender[];
  micSenders: RTCRtpSender[];
  lastSeen: number;
  sharingScreen: boolean;
  hasMic: boolean;
  watching: boolean;
};

const HEARTBEAT_MS = 10_000;
export const PEER_TIMEOUT_MS = 32_000;
export const ICE_SERVERS: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
const ICE_CACHE_MS = 30 * 60_000;
let iceCache: { at: number; servers: Promise<RTCIceServer[]> } | null = null;

// STUN first (direct paths win), then any TURN relay the server hands out.
// Failures are not cached and fall back to STUN only.
export function loadIceServers(): Promise<RTCIceServer[]> {
  if (iceCache && Date.now() - iceCache.at < ICE_CACHE_MS) return iceCache.servers;
  const servers = fetch('/api/ice-servers', { credentials: 'include', cache: 'no-store' })
    .then(async (response) => {
      if (!response.ok) throw new Error('ICE servers unavailable');
      const body = await response.json() as { iceServers?: unknown };
      return [...ICE_SERVERS, ...(Array.isArray(body.iceServers) ? body.iceServers as RTCIceServer[] : [])];
    })
    .catch(() => {
      iceCache = null;
      return ICE_SERVERS;
    });
  iceCache = { at: Date.now(), servers };
  return servers;
}
// A conservative per-viewer ceiling keeps ordinary desktop uploads viable.
const SCREEN_ENCODER_MAX_BITRATE = 2_500_000;

// Allow the browser to trade resolution and frame rate under load. Bitrate per
// watcher comes from screenBitrate (total upload cap), with a conservative
// sender ceiling for compatibility.
// A mesh encodes the screen once per viewer, so a viewer who is not looking (room
// tab hidden, no picture-in-picture) gets a trickle: 2 fps at a low bitrate
// frees their share of the cap for the others. The video is never switched
// off: Chrome on Windows reports a covered window as hidden, so switching to
// another window used to stop the picture and need a reconnect to come back.
// Full rate returns the moment they look again. Tab sound is unaffected.
const HIDDEN_VIEWER_BITRATE = 500_000;
const HIDDEN_VIEWER_FRAMERATE = 2;
async function tuneVideoSender(sender: RTCRtpSender, watching: boolean, maxBitrate: number) {
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].active = true;
    params.encodings[0].maxBitrate = Math.min(maxBitrate, watching ? SCREEN_ENCODER_MAX_BITRATE : HIDDEN_VIEWER_BITRATE);
    params.encodings[0].maxFramerate = watching ? 30 : HIDDEN_VIEWER_FRAMERATE;
    (params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = 'balanced';
    await sender.setParameters(params);
  } catch {
    // Older browsers keep their defaults.
  }
}

// Tab sound in stereo at 128 kbps per watcher (film and music quality; the
// browser default is about 32 kbps).
const TAB_AUDIO_BITRATE = 128_000;
async function tuneAudioSender(sender: RTCRtpSender) {
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = TAB_AUDIO_BITRATE;
    await sender.setParameters(params);
  } catch {
    // Older browsers keep their defaults.
  }
}

export class VoiceMesh {
  private peers = new Map<string, PeerEntry>();
  private local: MediaStream | null = null;
  private screen: MediaStream | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private joined = false;
  private watching = true;
  private iceServers: RTCIceServer[] = ICE_SERVERS;

  constructor(
    private readonly selfId: string,
    private readonly send: (signal: RtcSignal) => boolean,
    private readonly onChange: () => void,
  ) {}

  get isJoined() { return this.joined; }
  get isSharingScreen() { return this.screen !== null; }
  get hasMic() { return Boolean(this.local?.getAudioTracks().length); }
  get localStream() { return this.local; }
  get screenStream() { return this.screen; }

  peerList(): VoicePeer[] {
    return [...this.peers.entries()].map(([id, peer]) => ({ id, audio: peer.audio, screen: peer.screen, state: peer.pc.connectionState, sharingScreen: peer.sharingScreen, hasMic: peer.hasMic }));
  }

  private hello(to?: string) {
    this.send({ kind: 'hello', ...(to ? { to } : {}), screen: this.screen !== null, mic: this.hasMic, watching: this.watching });
  }

  // Whether this member can see a shared picture right now; sharers slow
  // their video to a member who cannot.
  private readonly updateWatching = () => {
    const watching = document.visibilityState === 'visible' || Boolean(document.pictureInPictureElement);
    if (watching === this.watching) return;
    this.watching = watching;
    if (this.joined) this.hello();
  };

  private watchVisibility(on: boolean) {
    if (typeof document === 'undefined') return;
    const method = on ? 'addEventListener' : 'removeEventListener';
    document[method]('visibilitychange', this.updateWatching);
    // Picture-in-picture events do not bubble; capture catches them.
    document[method]('enterpictureinpicture', this.updateWatching, true);
    document[method]('leavepictureinpicture', this.updateWatching, true);
  }

  // `local` is null for a member who only watches (no microphone).
  join(local: MediaStream | null) {
    this.local = local;
    this.joined = true;
    this.watching = typeof document === 'undefined' || document.visibilityState === 'visible' || Boolean(document.pictureInPictureElement);
    this.watchVisibility(true);
    // Stays synchronous (a screen picker may need this click's gesture); the
    // relay list applies to new peers and to ICE restarts of existing ones.
    void loadIceServers().then((servers) => { if (this.joined) this.setIceServers(servers); });
    this.hello();
    this.heartbeat = setInterval(() => {
      this.hello();
      const now = Date.now();
      for (const [id, peer] of this.peers) if (now - peer.lastSeen > PEER_TIMEOUT_MS) this.dropPeer(id);
    }, HEARTBEAT_MS);
    this.onChange();
  }

  private setIceServers(servers: RTCIceServer[]) {
    this.iceServers = servers;
    for (const { pc } of this.peers.values()) {
      try { pc.setConfiguration({ ...pc.getConfiguration(), iceServers: servers }); } catch { /* closed peer */ }
    }
  }

  // Turns a watch-only member into a speaking one.
  addMic(stream: MediaStream) {
    if (this.hasMic) { stream.getTracks().forEach((track) => track.stop()); return; }
    this.local = stream;
    for (const peer of this.peers.values()) this.addMicTracks(peer);
    this.hello();
    this.onChange();
  }

  leave() {
    if (this.joined) this.send({ kind: 'bye' });
    this.joined = false;
    this.watchVisibility(false);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const id of [...this.peers.keys()]) this.dropPeer(id);
    this.stopTracks(this.screen);
    this.stopTracks(this.local);
    this.screen = null;
    this.local = null;
    this.onChange();
  }

  setMicEnabled(enabled: boolean) {
    this.local?.getAudioTracks().forEach((track) => { track.enabled = enabled; });
    this.onChange();
  }

  startScreen(stream: MediaStream) {
    this.stopScreen();
    this.screen = stream;
    const [track] = stream.getVideoTracks();
    // No contentHint: 'motion' makes Chrome capture a tab at camera-like low
    // resolution (288x180 in tests); the sender settings keep full resolution.
    track?.addEventListener('ended', () => { if (this.screen === stream) this.stopScreen(); });
    // Film and music, not speech: Opus keeps the full band and stereo image.
    for (const sound of stream.getAudioTracks()) sound.contentHint = 'music';
    for (const peer of this.peers.values()) this.addScreenTrack(peer);
    this.hello();
    this.onChange();
  }

  stopScreen() {
    if (!this.screen) return;
    for (const peer of this.peers.values()) {
      for (const sender of peer.screenSenders) {
        try { peer.pc.removeTrack(sender); } catch { /* connection already closed */ }
      }
      peer.screenSenders = [];
    }
    this.stopTracks(this.screen);
    this.screen = null;
    this.hello();
    this.onChange();
  }

  async handleSignal(senderId: string, signal: RtcSignal) {
    if (!this.joined || senderId === this.selfId) return;
    if (signal.to && signal.to !== this.selfId) return;
    if (signal.kind === 'who') { if (this.screen) this.hello(); return; }
    if (signal.kind === 'bye') { this.dropPeer(senderId); this.onChange(); return; }

    const known = this.peers.has(senderId);
    const peer = this.ensurePeer(senderId);
    peer.lastSeen = Date.now();
    if (signal.kind === 'hello') {
      if (typeof signal.screen === 'boolean') {
        peer.sharingScreen = signal.screen;
        if (!signal.screen) peer.screen = null;
      }
      // Older clients do not send `mic`; they always joined with one.
      peer.hasMic = signal.mic !== false;
      // Older clients do not send `watching`; they always get the picture.
      const watching = signal.watching !== false;
      if (watching !== peer.watching) {
        peer.watching = watching;
        this.retuneScreen();
      }
      // Introduce ourselves to a newcomer (a directed hello is not answered,
      // so heartbeats never ping-pong).
      if (!known && !signal.to) this.hello(senderId);
      this.onChange();
      return;
    }

    try {
      if (signal.kind === 'offer' || signal.kind === 'answer') {
        const description: RTCSessionDescriptionInit = { type: signal.kind, sdp: signal.sdp && withStereoOpus(signal.sdp) };
        const collision = signal.kind === 'offer' && (peer.makingOffer || peer.pc.signalingState !== 'stable');
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;
        await peer.pc.setRemoteDescription(description);
        if (signal.kind === 'offer') {
          await peer.pc.setLocalDescription();
          const answer = peer.pc.localDescription;
          if (answer?.sdp) this.send({ kind: 'answer', to: senderId, sdp: answer.sdp });
        }
      } else if (signal.kind === 'ice') {
        try {
          await peer.pc.addIceCandidate(signal.candidate
            ? { candidate: signal.candidate, sdpMid: signal.sdpMid ?? null, sdpMLineIndex: signal.sdpMLineIndex ?? null }
            : null);
        } catch (error) {
          if (!peer.ignoreOffer) throw error;
        }
      }
    } catch {
      // A failed negotiation step leaves the pair to the next heartbeat/offer;
      // nothing about the connection is logged (SDP contains addresses).
    }
    this.onChange();
  }

  private ensurePeer(peerId: string): PeerEntry {
    const existing = this.peers.get(peerId);
    if (existing) return existing;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer: PeerEntry = {
      pc,
      polite: !shouldInitiateOffer(this.selfId, peerId),
      makingOffer: false,
      ignoreOffer: false,
      audio: null,
      screen: null,
      screenSenders: [],
      micSenders: [],
      lastSeen: Date.now(),
      sharingScreen: false,
      hasMic: true,
      watching: true,
    };
    this.peers.set(peerId, peer);
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        const offer = pc.localDescription;
        if (offer?.sdp) this.send({ kind: 'offer', to: peerId, sdp: offer.sdp });
      } catch {
        // retried on the next negotiationneeded
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      this.send({
        kind: 'ice',
        to: peerId,
        candidate: candidate?.candidate ?? '',
        ...(candidate?.sdpMid ? { sdpMid: candidate.sdpMid } : {}),
        ...(typeof candidate?.sdpMLineIndex === 'number' ? { sdpMLineIndex: candidate.sdpMLineIndex } : {}),
      });
    };
    pc.ontrack = ({ track, streams }) => {
      const stream = streams[0] ?? new MediaStream([track]);
      if (track.kind === 'video') {
        peer.screen = stream;
        track.addEventListener('ended', () => { if (peer.screen === stream) { peer.screen = null; this.onChange(); } });
        track.addEventListener('mute', () => { if (!peer.sharingScreen && peer.screen === stream) { peer.screen = null; this.onChange(); } });
      } else if (stream.getVideoTracks().length > 0 || peer.screen?.id === stream.id) {
        // Tab sound: it already plays from the shared-tab stream. Tracks of one
        // offer are attached to their streams before any track event fires, so
        // the video is in the stream by the time its sound arrives.
      } else {
        peer.audio = stream;
      }
      this.onChange();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') pc.restartIce();
      if (pc.connectionState === 'failed' || pc.connectionState === 'connected') this.retuneScreen();
      this.onChange();
    };
    this.addMicTracks(peer);
    if (this.screen) this.addScreenTrack(peer);
    return peer;
  }

  private addMicTracks(peer: PeerEntry) {
    if (!this.local || peer.micSenders.length) return;
    for (const track of this.local.getAudioTracks()) peer.micSenders.push(peer.pc.addTrack(track, this.local));
  }

  // Video first, then the tab's sound, in the same stream.
  private addScreenTrack(peer: PeerEntry) {
    if (!this.screen) return;
    for (const track of [...this.screen.getVideoTracks(), ...this.screen.getAudioTracks()]) {
      const sender = peer.pc.addTrack(track, this.screen);
      peer.screenSenders.push(sender);
      if (track.kind === 'audio') void tuneAudioSender(sender);
    }
    this.retuneScreen();
  }

  // Splits the upload cap between the members who are watching; a connection
  // that failed or closed sends nothing, so it takes no share.
  private retuneScreen() {
    if (!this.screen) return;
    const live = (peer: PeerEntry) => peer.watching && peer.pc.connectionState !== 'failed' && peer.pc.connectionState !== 'closed';
    const maxBitrate = screenBitrate([...this.peers.values()].filter(live).length);
    for (const peer of this.peers.values()) {
      for (const sender of peer.screenSenders) if (sender.track?.kind === 'video') void tuneVideoSender(sender, peer.watching, maxBitrate);
    }
  }

  private dropPeer(peerId: string) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.pc.onnegotiationneeded = null;
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    this.peers.delete(peerId);
    if (peer.screenSenders.length) this.retuneScreen();
  }

  private stopTracks(stream: MediaStream | null) {
    stream?.getTracks().forEach((track) => track.stop());
  }
}
