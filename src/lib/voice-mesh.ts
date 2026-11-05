import { shouldInitiateOffer } from '@/lib/collab-model';

// Peer-to-peer voice and screen share (Action 12). No managed media provider
// is configured, so this is the provider-neutral free path: a full mesh of
// RTCPeerConnections (fine for small study rooms), public STUN for address
// discovery and no TURN relay (members behind strict NATs may fail to
// connect; recorded in the ledger). Signaling travels as `rtc_signal` events
// on the private, chat-capability-scoped room topic through useRoomSync.
//
// Negotiation follows the "perfect negotiation" pattern: either side may
// renegotiate (e.g. to add a screen track); on an offer collision the polite
// peer (the higher user id) rolls back and the impolite peer's offer wins.

export type RtcSignal = {
  to?: string;
  kind: 'hello' | 'bye' | 'offer' | 'answer' | 'ice';
  sdp?: string;
  candidate?: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
  screen?: boolean;
};

export type VoicePeer = {
  id: string;
  audio: MediaStream | null;
  screen: MediaStream | null;
  state: RTCPeerConnectionState | 'new';
  sharingScreen: boolean;
};

type PeerEntry = {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  audio: MediaStream | null;
  screen: MediaStream | null;
  screenSenders: RTCRtpSender[];
  lastSeen: number;
  sharingScreen: boolean;
};

const HEARTBEAT_MS = 10_000;
const PEER_TIMEOUT_MS = 32_000;
export const ICE_SERVERS: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

export class VoiceMesh {
  private peers = new Map<string, PeerEntry>();
  private local: MediaStream | null = null;
  private screen: MediaStream | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private joined = false;

  constructor(
    private readonly selfId: string,
    private readonly send: (signal: RtcSignal) => boolean,
    private readonly onChange: () => void,
  ) {}

  get isJoined() { return this.joined; }
  get isSharingScreen() { return this.screen !== null; }
  get localStream() { return this.local; }
  get screenStream() { return this.screen; }

  peerList(): VoicePeer[] {
    return [...this.peers.entries()].map(([id, peer]) => ({ id, audio: peer.audio, screen: peer.screen, state: peer.pc.connectionState, sharingScreen: peer.sharingScreen }));
  }

  join(local: MediaStream) {
    this.local = local;
    this.joined = true;
    this.send({ kind: 'hello', screen: false });
    this.heartbeat = setInterval(() => {
      this.send({ kind: 'hello', screen: this.screen !== null });
      const now = Date.now();
      for (const [id, peer] of this.peers) if (now - peer.lastSeen > PEER_TIMEOUT_MS) this.dropPeer(id);
    }, HEARTBEAT_MS);
    this.onChange();
  }

  leave() {
    if (this.joined) this.send({ kind: 'bye' });
    this.joined = false;
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
    track?.addEventListener('ended', () => this.stopScreen());
    for (const peer of this.peers.values()) this.addScreenTrack(peer);
    this.send({ kind: 'hello', screen: true });
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
    this.send({ kind: 'hello', screen: false });
    this.onChange();
  }

  async handleSignal(senderId: string, signal: RtcSignal) {
    if (!this.joined || senderId === this.selfId) return;
    if (signal.to && signal.to !== this.selfId) return;
    if (signal.kind === 'bye') { this.dropPeer(senderId); this.onChange(); return; }

    const known = this.peers.has(senderId);
    const peer = this.ensurePeer(senderId);
    peer.lastSeen = Date.now();
    if (typeof signal.screen === 'boolean' && signal.kind === 'hello') {
      peer.sharingScreen = signal.screen;
      if (!signal.screen) peer.screen = null;
    }

    if (signal.kind === 'hello') {
      // Introduce ourselves to a newcomer (a directed hello is not answered,
      // so heartbeats never ping-pong).
      if (!known && !signal.to) this.send({ kind: 'hello', to: senderId, screen: this.screen !== null });
      this.onChange();
      return;
    }

    try {
      if (signal.kind === 'offer' || signal.kind === 'answer') {
        const description: RTCSessionDescriptionInit = { type: signal.kind, sdp: signal.sdp };
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
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const peer: PeerEntry = {
      pc,
      polite: !shouldInitiateOffer(this.selfId, peerId),
      makingOffer: false,
      ignoreOffer: false,
      audio: null,
      screen: null,
      screenSenders: [],
      lastSeen: Date.now(),
      sharingScreen: false,
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
      if (track.kind === 'video') {
        peer.screen = streams[0] ?? new MediaStream([track]);
        track.addEventListener('ended', () => { peer.screen = null; this.onChange(); });
        track.addEventListener('mute', () => { if (!peer.sharingScreen) { peer.screen = null; this.onChange(); } });
      } else {
        peer.audio = streams[0] ?? new MediaStream([track]);
      }
      this.onChange();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') pc.restartIce();
      this.onChange();
    };
    this.local?.getAudioTracks().forEach((track) => pc.addTrack(track, this.local as MediaStream));
    if (this.screen) this.addScreenTrack(peer);
    return peer;
  }

  private addScreenTrack(peer: PeerEntry) {
    if (!this.screen) return;
    for (const track of this.screen.getVideoTracks()) peer.screenSenders.push(peer.pc.addTrack(track, this.screen));
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
  }

  private stopTracks(stream: MediaStream | null) {
    stream?.getTracks().forEach((track) => track.stop());
  }
}
