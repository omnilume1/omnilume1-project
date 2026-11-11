'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { OmniIcon, type OmniIconName } from '@/components/ui/OmniIcon';
import { SendLinkButton } from '@/components/room/DoorShare';
import { useVoiceRoom } from '@/components/room/VoiceRoom';
import { useCloseOnBack } from '@/hooks/useCloseOnBack';
import { useListenTogether } from '@/hooks/useListenTogether';
import { countSpots, ROOM_SPOTS, type RoomSpot } from '@/lib/room-live-status';
import type { RoomPresenceValue } from '@/hooks/useRoomPresence';
import './room-phone-shell.css';

// Phase 13: the room below 768 px. Four spot tabs on top, the active spot's
// stage, the room chat, and a floating bottom bar. The page renders this OR
// RoomDesk, never both, so there is one player, one timer and one chat.

export type PhoneMoreItem = { id: string; label: string; icon: OmniIconName; enabled: boolean; content?: ReactNode; onOpen?: () => void };

const SPOT_META: Record<RoomSpot, { label: string; icon: OmniIconName }> = {
  desk: { label: 'Desk', icon: 'book' },
  screen: { label: 'Screen', icon: 'tv' },
  speaker: { label: 'Speaker', icon: 'music' },
  bed: { label: 'Bed', icon: 'users' },
};

const OFF = <p className="phone-off">Off in this room</p>;

function SpeakerPanel({ roomId, roomName }: { roomId: string; roomName: string }) {
  const together = useListenTogether();
  const here = together.target?.kind === 'room' && together.target.id === roomId;
  const live = here && together.session && !together.session.ended ? together.session : null;
  const current = live?.uploadId ? together.tracksById.get(live.uploadId) : undefined;
  return (
    <section className="phone-speaker glass-panel" aria-label="Listen together">
      <h2>Listen together</h2>
      {!here ? (
        <button type="button" className="omni-button omni-button-primary" onClick={() => void together.select({ kind: 'room', id: roomId, name: roomName })}>Listen together here</button>
      ) : (
        <>
          <p aria-live="polite">
            {live
              ? current ? `${live.isPlaying ? 'Playing' : 'Paused'}: ${current.title} — ${current.artist}` : `Hosted by ${live.hostName}. Nothing playing yet.`
              : 'No one is listening here right now.'}
          </p>
          <div className="phone-speaker-actions">
            {together.following
              ? <button type="button" className="omni-button omni-button-ghost" onClick={together.leave}>Leave</button>
              : <button type="button" className="omni-button omni-button-primary" onClick={() => void together.join(false)}>{live ? 'Join' : 'Start listening together'}</button>}
            <Link href="/music/together" className="omni-button omni-button-ghost">Open in Music</Link>
          </div>
        </>
      )}
      {together.error && <p role="alert" className="phone-error">{together.error}</p>}
    </section>
  );
}

export default function RoomPhoneShell({ roomId, roomName, nameplate, presence, study, media, chat, voice: voicePanel, canShareDoor, door, more }: {
  roomId: string;
  roomName: string;
  nameplate: string | null;
  presence: Pick<RoomPresenceValue, 'publicUsers' | 'mySpot' | 'setSpot'>;
  // null when the room has the feature turned off.
  study: ReactNode | null;
  media: ReactNode | null;
  chat: ReactNode | null;
  voice: ReactNode | null;
  canShareDoor: boolean;
  door: { token: string | null; failed: boolean };
  more: PhoneMoreItem[];
}) {
  const voice = useVoiceRoom();
  // 'menu' shows the list; an item id shows that window inside the sheet.
  const [sheet, setSheet] = useState<string | null>(null);
  useCloseOnBack(sheet !== null, () => setSheet(null));
  // Counts read the public channel only: ghosts are never in it (roadmap §0.9).
  const { spots } = countSpots(presence.publicUsers);
  const active = presence.mySpot;
  // A feature switched off while its sheet is open falls back to the list.
  const openItem = more.find((item) => item.id === sheet && item.enabled);
  useEffect(() => {
    if (!sheet) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setSheet(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheet]);

  const micLabel = !voice.joined ? 'Join voice' : !voice.hasMic ? 'Turn on mic' : voice.micEnabled ? 'Mute' : 'Unmute';
  const onMic = () => {
    if (!voice.joined) void voice.join();
    else if (!voice.hasMic) void voice.enableMic();
    else voice.toggleMic();
  };

  const stages: Record<RoomSpot, ReactNode> = {
    desk: study ?? OFF,
    screen: media ?? OFF,
    speaker: <SpeakerPanel roomId={roomId} roomName={roomName} />,
    bed: voicePanel ?? OFF,
  };

  return (
    <div className="phone-shell">
      <nav className="phone-tabs" role="tablist" aria-label="Spots in this room">
        {ROOM_SPOTS.map((spot) => (
          <button key={spot} type="button" role="tab" data-spot={spot} aria-selected={active === spot} aria-controls={`phone-pane-${spot}`} aria-label={`${SPOT_META[spot].label}, ${spots[spot]} here`} className="phone-tab" onClick={() => presence.setSpot(spot)}>
            <OmniIcon name={SPOT_META[spot].icon} size={16} />
            <span>{SPOT_META[spot].label}</span>
            <span className="phone-tab-count mono" aria-hidden="true">{spots[spot]}</span>
          </button>
        ))}
      </nav>

      {/* Every stage stays mounted while hidden, so switching tabs never resets video sync or the timer. */}
      <div className="phone-stage">
        {ROOM_SPOTS.map((spot) => (
          <div key={spot} id={`phone-pane-${spot}`} role="tabpanel" aria-label={SPOT_META[spot].label} className="phone-pane" data-pane={spot} hidden={active !== spot}>
            {stages[spot]}
          </div>
        ))}
      </div>

      {chat && <section className="phone-chat" aria-label="Room chat">{chat}</section>}

      {/* Pinned above the bar so a refused mic tap is seen; tap to dismiss (it only clears on the next voice success). */}
      {voice.error && active !== 'bed' && <p role="alert" className="phone-error phone-voice-error" onClick={() => voice.setError(null)}>{voice.error}</p>}

      <div className="phone-bar" role="toolbar" aria-label="Room controls">
        <button type="button" className={`phone-bar-btn ${voice.joined && voice.hasMic && !voice.micEnabled ? 'is-off' : ''} ${voice.joined ? 'is-live' : ''}`} onClick={onMic} disabled={!voicePanel || voice.joining} aria-pressed={voice.joined && voice.hasMic ? !voice.micEnabled : undefined} aria-label={voice.joining ? 'Joining voice' : micLabel} title={micLabel}>
          <OmniIcon name="mic" size={18} />
        </button>
        <button type="button" className="phone-bar-btn" disabled aria-disabled="true" aria-label="Earphones (coming soon)" title="Earphones (coming soon)">
          <OmniIcon name="headphones" size={18} />
        </button>
        {canShareDoor && <div className="phone-bar-share"><SendLinkButton roomId={roomId} nameplate={nameplate} door={door} size="header" /></div>}
        <button type="button" className="phone-bar-btn" aria-haspopup="dialog" aria-expanded={sheet !== null} aria-label="More" title="More" onClick={() => setSheet('menu')}>
          <OmniIcon name="more" size={18} />
        </button>
      </div>

      {sheet && (
        <>
          <div className="phone-sheet-scrim" aria-hidden="true" onClick={() => setSheet(null)} />
          <div className="phone-sheet glass-strong" role="dialog" aria-modal="true" aria-label={openItem?.label ?? 'More'}>
            <div className="phone-sheet-head">
              {openItem && <button type="button" className="icon-button" aria-label="Back to More" onClick={() => setSheet('menu')}><OmniIcon name="back" size={16} /></button>}
              <h2>{openItem?.label ?? 'More'}</h2>
              <button type="button" className="icon-button" aria-label="Close" onClick={() => setSheet(null)}><OmniIcon name="close" size={16} /></button>
            </div>
            {openItem?.content ? <div className="phone-sheet-body">{openItem.content}</div> : (
              <ul className="phone-sheet-list">
                {more.map((item) => (
                  <li key={item.id}>
                    <button type="button" className="phone-sheet-item" disabled={!item.enabled} onClick={() => { if (item.onOpen) { setSheet(null); item.onOpen(); } else setSheet(item.id); }}>
                      <OmniIcon name={item.icon} size={17} /><span>{item.label}</span>{!item.enabled && <small>Off in this room</small>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
