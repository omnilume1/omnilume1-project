'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useRoomRealtime } from '@/components/room/RoomRealtimeProvider';
import { useVoiceRoom } from '@/components/room/VoiceRoom';
import { useMemberNames } from '@/lib/collab-hooks';

// "Share a tab" on the Watch stage. It rides on the voice mesh (VoiceRoom):
// the host's browser sends the tab, with its sound, straight to each member
// who chose to watch. Viewers join watch-only, so no microphone is asked for.

const subscribeToNothing = () => () => undefined;
const canShareHere = () => typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getDisplayMedia);

export function useTabShareLive() {
  const voice = useVoiceRoom();
  return voice.sharingScreen || voice.liveSharers.length > 0;
}

export function ShareTabButton() {
  const voice = useVoiceRoom();
  const supported = useSyncExternalStore(subscribeToNothing, canShareHere, () => true);
  if (!voice.canUseVoice) return null;
  return (
    <div className="tab-share-offer">
      <p className="tab-share-or"><span>or</span></p>
      {supported ? (
        <>
          <button type="button" className="tab-share-button" onClick={() => void voice.startScreen()}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="2.5" y="4" width="19" height="13" rx="2" /><path d="M8 21h8M12 17v4M12 13V8M9.5 10.5 12 8l2.5 2.5" /></svg>
            Share a tab
          </button>
          <p className="tab-share-hint">Show any site you have open, with its sound. Works best in Chrome or Edge.</p>
        </>
      ) : <p className="tab-share-hint">Sharing a tab needs Chrome or Edge on a computer.</p>}
      {voice.error && <p role="alert" className="tab-share-error">{voice.error}</p>}
    </div>
  );
}

// Shown in the stage header while a cast is playing, so a share never covers it.
export function TabShareNotice() {
  const voice = useVoiceRoom();
  const names = useMemberNames(voice.roomId);
  if (voice.sharingScreen) return <span className="tab-share-notice">You&apos;re sharing a tab. It shows here when the stage is free. <button type="button" onClick={voice.stopScreen}>Stop sharing</button></span>;
  const first = voice.liveSharers[0];
  if (!first) return null;
  return <span className="tab-share-notice">{names.get(first) ?? 'A member'} is sharing a tab. It shows here when the stage is free.</span>;
}

function ShareVideo({ stream, label }: { stream: MediaStream; label: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (element.srcObject !== stream) element.srcObject = stream;
    void element.play().catch(() => undefined);
  }, [stream]);
  // Muted: the sound plays from VoiceRoom, so it continues if the stage closes.
  return <video ref={ref} autoPlay playsInline muted className="tab-share-video" aria-label={label} />;
}

export default function TabShareStage() {
  const voice = useVoiceRoom();
  const { currentUserId } = useRoomRealtime();
  const names = useMemberNames(voice.roomId);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [slow, setSlow] = useState<string | null>(null);
  const name = (id: string) => (id === currentUserId ? 'You' : names.get(id) ?? 'A member');

  const sharerId = picked && voice.liveSharers.includes(picked) ? picked : voice.liveSharers[0] ?? null;
  const peer = sharerId ? voice.peers.find((item) => item.id === sharerId) : undefined;
  const waiting = Boolean(!voice.sharingScreen && sharerId && voice.joined && !peer?.screen);

  // After 15 s without a picture, say why it may not arrive.
  useEffect(() => {
    if (!waiting || !sharerId) return;
    const timer = window.setTimeout(() => setSlow(sharerId), 15_000);
    return () => window.clearTimeout(timer);
  }, [sharerId, waiting]);

  const fullscreen = () => {
    const frame = frameRef.current;
    if (!frame) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void frame.requestFullscreen?.().catch(() => undefined);
  };

  if (voice.sharingScreen && voice.screenStream) {
    const watching = voice.peers.filter((item) => item.state === 'connected').length;
    const hasSound = voice.screenStream.getAudioTracks().length > 0;
    return (
      <div className="tab-share" ref={frameRef}>
        <div className="tab-share-frame">
          <ShareVideo stream={voice.screenStream} label="Your shared tab" />
          <span className="tab-share-badge"><span className="tab-share-dot" aria-hidden="true" />Live · Your tab</span>
        </div>
        <div className="tab-share-bar">
          <div className="min-w-0">
            <p className="tab-share-title">You&apos;re sharing a tab</p>
            <p className="tab-share-meta" role="status">
              {watching === 0 ? 'Waiting for people to watch' : `${watching} watching`} · only you can control it
            </p>
            {!hasSound && <p className="tab-share-warn">No tab sound. Stop, share again and turn on &ldquo;Also share tab audio&rdquo; (Chrome or Edge).</p>}
          </div>
          <button type="button" className="tab-share-stop" onClick={voice.stopScreen}>Stop sharing</button>
        </div>
      </div>
    );
  }

  if (!sharerId) return null;
  const others = voice.liveSharers.length > 1 ? voice.liveSharers : [];

  return (
    <div className="tab-share" ref={frameRef}>
      {others.length > 0 && (
        <div className="tab-share-pick" role="group" aria-label="Choose whose tab to watch">
          {others.map((id) => <button key={id} type="button" aria-pressed={id === sharerId} onClick={() => setPicked(id)}>{name(id)}</button>)}
        </div>
      )}
      {!voice.joined ? (
        <div className="tab-share-join">
          <p className="tab-share-title">{name(sharerId)} is sharing a tab</p>
          {voice.canUseVoice ? (
            <>
              <button type="button" className="tab-share-button" disabled={voice.joining} onClick={() => void voice.join({ mic: false })}>Watch</button>
              <p className="tab-share-hint">Your mic stays off. You&apos;ll also hear anyone talking in voice.</p>
            </>
          ) : <p className="tab-share-hint">Your room role can&apos;t watch shared tabs.</p>}
          {voice.error && <p role="alert" className="tab-share-error">{voice.error}</p>}
        </div>
      ) : peer?.screen ? (
        <>
          <div className="tab-share-frame">
            <ShareVideo stream={peer.screen} label={`${name(sharerId)}'s shared tab`} />
            <span className="tab-share-badge"><span className="tab-share-dot" aria-hidden="true" />Live · {name(sharerId)}&apos;s tab</span>
            {voice.shareSoundBlocked && <button type="button" className="tab-share-sound" onClick={voice.resumeShareSound}>Turn on sound</button>}
          </div>
          <div className="tab-share-bar">
            <div className="tab-share-controls">
              <button type="button" onClick={() => voice.setShareMuted(!voice.shareMuted)} aria-pressed={voice.shareMuted}>{voice.shareMuted ? 'Unmute' : 'Mute'}</button>
              <input type="range" min={0} max={1} step={0.05} value={voice.shareMuted ? 0 : voice.shareVolume} aria-label="Shared tab volume"
                onChange={(event) => { voice.setShareVolume(Number(event.target.value)); if (voice.shareMuted) voice.setShareMuted(false); }} />
              <button type="button" onClick={fullscreen}>Full screen</button>
            </div>
            <p className="tab-share-meta">
              {peer.screen.getAudioTracks().length === 0 ? 'No sound from this tab' : 'Only the host can control this tab'}
            </p>
            {!voice.hasMic && <button type="button" className="tab-share-leave" onClick={voice.leave}>Stop watching</button>}
          </div>
        </>
      ) : (
        <div className="tab-share-join">
          <p className="tab-share-title" role="status">Connecting to {name(sharerId)}&apos;s tab…</p>
          {slow === sharerId && <p className="tab-share-hint">Still connecting. Some school, office or mobile networks block direct connections between people.</p>}
          {!voice.hasMic && <button type="button" className="tab-share-leave" onClick={voice.leave}>Stop watching</button>}
        </div>
      )}
    </div>
  );
}
