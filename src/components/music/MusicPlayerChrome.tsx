'use client';

import { useEffect, useRef, type CSSProperties, type KeyboardEvent } from 'react';
import { useMusicPlayer } from '@/hooks/useMusicPlayer';
import { formatMusicTime } from '@/lib/music-model';
import { upNext, type UpNextTier } from '@/lib/music-queue';
import { MusicIcon } from './MusicIcon';
import { Artwork, EmptyState } from './MusicParts';

export type SidePanelKind = 'queue' | 'lyrics';

export function Transport({ compact = false }: { compact?: boolean }) {
  const player = useMusicPlayer();
  const { shuffle, repeat, current } = player.queue;
  return (
    <div className={`mu-transport ${compact ? 'is-compact' : ''}`}>
      <button type="button" className={`mu-icon-button mu-hide-phone ${shuffle ? 'is-on' : ''}`} aria-pressed={shuffle} aria-label="Shuffle" onClick={player.toggleShuffle}><MusicIcon name="shuffle" /></button>
      <button type="button" className="mu-icon-button mu-hide-phone" aria-label="Previous" onClick={player.previous} disabled={!current}><MusicIcon name="previous" size={24} /></button>
      <button type="button" className="mu-icon-button is-main" aria-label={player.isPlaying ? 'Pause' : 'Play'} onClick={player.toggle} disabled={!current}><MusicIcon name={player.isPlaying ? 'pause' : 'play'} size={28} /></button>
      <button type="button" className="mu-icon-button" aria-label="Next" onClick={player.next} disabled={!current}><MusicIcon name="next" size={24} /></button>
      <button type="button" className={`mu-icon-button mu-hide-phone ${repeat !== 'off' ? 'is-on' : ''}`} aria-label={`Repeat: ${repeat}`} aria-pressed={repeat !== 'off'} onClick={player.cycleRepeat}><MusicIcon name={repeat === 'one' ? 'repeatOne' : 'repeat'} /></button>
    </div>
  );
}

export function Progress() {
  const player = useMusicPlayer();
  const duration = player.durationMs || player.queue.current?.durationMs || 0;
  const position = Math.min(player.positionMs, duration);
  const percent = duration ? (position / duration) * 100 : 0;
  return (
    <div className="mu-progress">
      <span className="mu-time">{formatMusicTime(position)}</span>
      <input
        type="range" className="mu-range" aria-label="Seek" min={0} max={duration || 1} step={1000} value={position}
        aria-valuetext={`${formatMusicTime(position)} of ${formatMusicTime(duration)}`}
        disabled={!player.queue.current} onChange={(event) => player.seek(Number(event.target.value))}
        style={{ '--mu-fill': `${percent}%` } as CSSProperties}
      />
      <span className="mu-time">-{formatMusicTime(duration - position)}</span>
    </div>
  );
}

export function VolumeControl() {
  const player = useMusicPlayer();
  const level = player.muted ? 0 : player.volume;
  return (
    <div className="mu-volume" onWheel={(event) => player.setVolume(player.volume + (event.deltaY < 0 ? 0.05 : -0.05))}>
      <button type="button" className="mu-icon-button" aria-label={player.muted ? 'Unmute' : 'Mute'} aria-pressed={player.muted} onClick={player.toggleMute}>
        <MusicIcon name={level === 0 ? 'mute' : 'volume'} />
      </button>
      <input
        type="range" className="mu-range" aria-label="Volume" min={0} max={1} step={0.01} value={level}
        aria-valuetext={`${Math.round(level * 100)}%`} onChange={(event) => player.setVolume(Number(event.target.value))}
        style={{ '--mu-fill': `${level * 100}%` } as CSSProperties}
      />
    </div>
  );
}

export function PlayerPill({ panel, panelOpen, onPanel, onExpand }: { panel: SidePanelKind; panelOpen: boolean; onPanel: (kind: SidePanelKind) => void; onExpand: () => void }) {
  const player = useMusicPlayer();
  const track = player.queue.current;
  return (
    <div className="mu-pill-dock">
      <div className="mu-pill" role="region" aria-label="Player">
        <Transport />
        <div className="mu-lcd">
          {track ? (
            <>
              <button type="button" className="mu-lcd-art" onClick={onExpand} aria-label="Open full-screen player">
                <Artwork hue={track.hue} src={track.artwork} className="is-lcd" />
                <span className="mu-lcd-expand"><MusicIcon name="expand" size={14} /></span>
              </button>
              <div className="mu-lcd-body">
                <p className="mu-lcd-title">{track.title}</p>
                <p className={`mu-lcd-subtitle ${player.error ? 'is-error' : ''}`} role={player.error ? 'alert' : undefined}>{player.error ?? `${track.artist} — ${track.album}`}</p>
                <Progress />
              </div>
            </>
          ) : (
            <span className="mu-lcd-empty" aria-label="Nothing playing"><MusicIcon name="note" size={22} /></span>
          )}
        </div>
        <div className="mu-pill-actions">
          <button type="button" className={`mu-icon-button ${panelOpen && panel === 'lyrics' ? 'is-on' : ''}`} aria-label="Lyrics" aria-pressed={panelOpen && panel === 'lyrics'} onClick={() => onPanel('lyrics')}><MusicIcon name="lyrics" size={18} /></button>
          <button type="button" className={`mu-icon-button ${panelOpen && panel === 'queue' ? 'is-on' : ''}`} aria-label="Up Next" aria-pressed={panelOpen && panel === 'queue'} onClick={() => onPanel('queue')}><MusicIcon name="queue" size={18} /></button>
          <VolumeControl />
        </div>
      </div>
    </div>
  );
}

function UpNextRows({ tier, label }: { tier: UpNextTier; label: string }) {
  const player = useMusicPlayer();
  const rows = upNext(player.queue)[tier];
  if (rows.length === 0) return null;
  const onKey = (event: KeyboardEvent, i: number) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    player.move(tier, i, i + (event.key === 'ArrowUp' ? -1 : 1));
  };
  return (
    <section className="mu-upnext-section" aria-label={label}>
      <h3 className="mu-eyebrow">{label}</h3>
      <ol>
        {rows.map((track, i) => (
          <li
            key={track.id} className="mu-upnext-row" draggable
            onDragStart={(event) => event.dataTransfer.setData('text/plain', `${tier}:${i}`)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              const [fromTier, from] = event.dataTransfer.getData('text/plain').split(':');
              if (fromTier === tier) player.move(tier, Number(from), i);
            }}
          >
            <button type="button" className="mu-upnext-play" onClick={() => player.jumpTo(tier, i)} onKeyDown={(event) => onKey(event, i)} title="Alt+↑/↓ to reorder">
              <Artwork hue={track.hue} src={track.artwork} className="is-row" />
              <span className="mu-track-main"><span className="mu-track-title">{track.title}</span><span className="mu-track-artist">{track.artist}</span></span>
              <span className="mu-track-time">{formatMusicTime(track.durationMs)}</span>
            </button>
            <button type="button" className="mu-icon-button mu-upnext-remove" aria-label={`Remove ${track.title} from Up Next`} onClick={() => player.remove(tier, i)}><MusicIcon name="close" size={14} /></button>
          </li>
        ))}
      </ol>
    </section>
  );
}

function UpNextPanel() {
  const player = useMusicPlayer();
  const { user, context } = upNext(player.queue);
  return (
    <>
      <header className="mu-side-header">
        <h2>Up Next</h2>
        {user.length > 0 ? <button type="button" className="mu-text-button" onClick={player.clearUpcoming}>Clear</button> : null}
      </header>
      {user.length + context.length === 0 ? (
        <EmptyState title="Nothing up next" detail="Play an album or playlist, or add songs with Play Next." />
      ) : (
        <>
          <UpNextRows tier="user" label="Queue" />
          <UpNextRows tier="context" label={`Playing from ${player.queue.source}`} />
        </>
      )}
    </>
  );
}

/** Synced lines; the current line sits `anchor` of the way down the scroller. */
export function Lyrics({ anchor }: { anchor: number }) {
  const player = useMusicPlayer();
  const lines = player.queue.current?.lyrics;
  const synced = player.queue.current?.lyricsSynced !== false;
  const list = useRef<HTMLOListElement>(null);
  const active = synced ? lines?.reduce((found, line, i) => (line.ms <= player.positionMs ? i : found), -1) ?? -1 : -1;

  useEffect(() => {
    const scroller = list.current;
    const line = scroller?.children[active] as HTMLElement | undefined;
    if (!scroller || !line) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    scroller.scrollTo({ top: line.offsetTop - scroller.clientHeight * anchor, behavior: reduce ? 'auto' : 'smooth' });
  }, [active, anchor]);

  if (!lines?.length) return <EmptyState title="No lyrics available" detail="Lyrics show up when a song includes them or you add an .lrc file." />;
  return (
    <ol ref={list} className={`mu-lyrics ${synced ? '' : 'is-plain'}`} aria-label="Lyrics">
      {lines.map((line, i) => (
        <li key={`${line.ms}-${i}`} className={i === active ? 'is-active' : i < active ? 'is-past' : ''} aria-current={i === active ? 'true' : undefined}>
          {synced ? <button type="button" onClick={() => player.seek(line.ms)}>{line.text}</button> : <p>{line.text}</p>}
        </li>
      ))}
    </ol>
  );
}

export function SidePanel({ kind, open }: { kind: SidePanelKind; open: boolean }) {
  return (
    <aside className="mu-side" data-open={open} aria-label={kind === 'lyrics' ? 'Lyrics' : 'Up Next'} inert={!open}>
      {kind === 'queue' ? <UpNextPanel /> : (
        <>
          <header className="mu-side-header"><h2>Lyrics</h2></header>
          <Lyrics anchor={0.15} />
        </>
      )}
    </aside>
  );
}

// shortcut: mesh is CSS gradients from the fixture hue; sample real artwork colours (canvas) with uploads in 16.4.
function MeshBackdrop({ hue, playing }: { hue: number; playing: boolean }) {
  return <div className="mu-mesh" data-playing={playing} style={{ '--mu-hue': hue } as CSSProperties} aria-hidden="true"><i /><i /><i /></div>;
}

export function FullScreenPlayer({ onClose }: { onClose: () => void }) {
  const player = useMusicPlayer();
  const dialog = useRef<HTMLDialogElement>(null);
  const track = player.queue.current;
  useEffect(() => {
    const element = dialog.current;
    // No close() in cleanup: its async "close" event would re-close under Strict Mode; unmount removes it from the top layer.
    if (element && !element.open) element.showModal();
  }, []);
  // Native Esc closes the dialog; keep the parent's state in sync (the close button calls onClose itself).
  useEffect(() => {
    const element = dialog.current;
    element?.addEventListener('close', onClose);
    return () => element?.removeEventListener('close', onClose);
  }, [onClose]);
  return (
    <dialog ref={dialog} className="mu-fullscreen" aria-label="Now playing">
      <MeshBackdrop hue={track?.hue ?? 260} playing={player.isPlaying} />
      <button type="button" className="mu-icon-button mu-fs-close" aria-label="Close full-screen player" onClick={onClose}><MusicIcon name="close" /></button>
      <div className="mu-fs-grid">
        <div className="mu-fs-player">
          <div className="mu-fs-art">
            <Artwork hue={track?.hue ?? 260} src={track?.artwork} className="is-fs is-glow" />
            <Artwork hue={track?.hue ?? 260} src={track?.artwork} className="is-fs" label={track ? `${track.album} artwork` : undefined} />
          </div>
          <div className="mu-fs-text">
            <p className="mu-fs-title">{track?.title ?? 'Nothing playing'}</p>
            <p className="mu-fs-subtitle">{track ? `${track.artist} — ${track.album}` : ''}</p>
          </div>
          <Progress />
          <Transport />
          <VolumeControl />
        </div>
        <div className="mu-fs-lyrics"><Lyrics anchor={0.3} /></div>
      </div>
    </dialog>
  );
}
