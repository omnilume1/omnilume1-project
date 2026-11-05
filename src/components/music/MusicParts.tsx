'use client';

import Link from 'next/link';
import { useId, useRef, type CSSProperties, type ReactNode } from 'react';
import { useMusicPlayer } from '@/hooks/useMusicPlayer';
import { formatMusicTime, type MusicTrack } from '@/lib/music-model';
import type { MusicAlbum, MusicPlaylist } from '@/lib/music-fixtures';
import { MusicIcon } from './MusicIcon';

const hueStyle = (hue: number) => ({ '--mu-hue': hue }) as CSSProperties;

export function Artwork({ hue, src, className = '', label }: { hue: number; src?: string; className?: string; label?: string }) {
  return (
    <span className={`mu-art ${className}`} style={hueStyle(hue)} role={label ? 'img' : undefined} aria-label={label}>
      {/* eslint-disable-next-line @next/next/no-img-element -- user artwork is a blob/signed URL, not optimisable */}
      {src ? <img src={src} alt="" /> : null}
    </span>
  );
}

export function PageTitle({ children }: { children: ReactNode }) {
  return <h1 className="mu-title">{children}</h1>;
}

export function EmptyState({ title, detail, children }: { title: string; detail?: string; children?: ReactNode }) {
  return (
    <div className="mu-empty" role="status">
      <MusicIcon name="note" size={34} />
      <h2>{title}</h2>
      {detail ? <p>{detail}</p> : null}
      {children}
    </div>
  );
}

export function Shelf({ title, kind, children }: { title: string; kind: 'square' | 'tracks' | 'artists' | 'tiles'; children: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const scroll = (direction: 1 | -1) => scroller.current?.scrollBy({ left: direction * scroller.current.clientWidth, behavior: 'smooth' });
  return (
    <section className="mu-shelf" aria-label={title}>
      <h2 className="mu-section-title">{title}</h2>
      <div className="mu-shelf-frame">
        <button type="button" className="mu-shelf-arrow is-prev" aria-label={`Scroll ${title} back`} onClick={() => scroll(-1)}><MusicIcon name="back" size={18} /></button>
        <div ref={scroller} className={`mu-shelf-scroller is-${kind}`}>{children}</div>
        <button type="button" className="mu-shelf-arrow is-next" aria-label={`Scroll ${title} forward`} onClick={() => scroll(1)}><MusicIcon name="chevronRight" size={18} /></button>
      </div>
    </section>
  );
}

function CollectionLockup({ href, title, subtitle, hue, tracks }: { href: string; title: string; subtitle: string; hue: number; tracks: MusicTrack[] }) {
  const player = useMusicPlayer();
  return (
    <div className="mu-lockup">
      <div className="mu-lockup-art">
        <Link href={href} tabIndex={-1} aria-hidden="true"><Artwork hue={hue} className="is-square" /></Link>
        <button type="button" className="mu-art-play" aria-label={`Play ${title}`} onClick={() => player.playList(tracks, 0, title)}>
          <MusicIcon name="play" size={18} />
        </button>
      </div>
      <Link href={href} className="mu-lockup-title">{title}</Link>
      <p className="mu-lockup-subtitle">{subtitle}</p>
    </div>
  );
}

export function AlbumLockup({ album }: { album: MusicAlbum }) {
  return <CollectionLockup href={`/music/album/${album.id}`} title={album.title} subtitle={album.artist} hue={album.hue} tracks={album.tracks} />;
}

export function PlaylistLockup({ playlist }: { playlist: MusicPlaylist }) {
  return <CollectionLockup href={`/music/playlist/${playlist.id}`} title={playlist.title} subtitle="Playlist" hue={playlist.hue} tracks={playlist.tracks} />;
}

export function ArtistLockup({ name, hue }: { name: string; hue: number }) {
  return (
    <Link href={`/music/search?q=${encodeURIComponent(name)}`} className="mu-artist">
      <Artwork hue={hue} className="is-round" />
      <span>{name}</span>
    </Link>
  );
}

export function TrackMenu({ track }: { track: MusicTrack }) {
  const player = useMusicPlayer();
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const place = (button: HTMLButtonElement) => {
    const rect = button.getBoundingClientRect();
    const element = menu.current;
    if (!element) return;
    element.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 140)}px`;
    element.style.left = `${Math.max(8, Math.min(rect.right - 190, window.innerWidth - 198))}px`;
  };
  const run = (action: () => void) => {
    action();
    menu.current?.hidePopover();
  };
  return (
    <>
      <button type="button" className="mu-icon-button mu-row-more" popoverTarget={id} aria-label={`More options for ${track.title}`} onClick={(event) => place(event.currentTarget)}>
        <MusicIcon name="more" size={18} />
      </button>
      <div ref={menu} id={id} popover="auto" className="mu-menu" role="menu" aria-label={`${track.title} options`}>
        <button type="button" role="menuitem" onClick={() => run(() => player.playNext(track))}>Play Next</button>
        <button type="button" role="menuitem" onClick={() => run(() => player.addToQueue(track))}>Add to Queue</button>
        {track.albumId ? <Link role="menuitem" href={`/music/album/${track.albumId}`} onClick={() => menu.current?.hidePopover()}>Go to Album</Link> : null}
      </div>
    </>
  );
}

function NowPlayingBars() {
  return <span className="mu-bars" aria-hidden="true"><i /><i /><i /></span>;
}

export function TrackList({ tracks, source, showArt = false, showAlbum = true }: { tracks: MusicTrack[]; source: string; showArt?: boolean; showAlbum?: boolean }) {
  const player = useMusicPlayer();
  const currentId = player.queue.current?.id;
  if (tracks.length === 0) return <EmptyState title="No songs" />;
  return (
    <ol className={`mu-tracklist ${showArt ? 'has-art' : ''}`} aria-label={`${source} songs`}>
      {tracks.map((track, i) => {
        const isCurrent = track.id === currentId;
        return (
          <li key={`${track.id}-${i}`} className={`mu-track ${isCurrent ? 'is-current' : ''}`} onDoubleClick={() => player.playList(tracks, i, source)}>
            <span className="mu-track-lead">
              {showArt ? <Artwork hue={track.hue} src={track.artwork} className="is-row" /> : <span className="mu-track-index">{isCurrent && player.isPlaying ? <NowPlayingBars /> : i + 1}</span>}
              <button type="button" className="mu-track-play" aria-label={isCurrent && player.isPlaying ? `Pause ${track.title}` : `Play ${track.title}`} onClick={() => (isCurrent ? player.toggle() : player.playList(tracks, i, source))}>
                <MusicIcon name={isCurrent && player.isPlaying ? 'pause' : 'play'} size={14} />
              </button>
            </span>
            <span className="mu-track-main">
              <span className="mu-track-title">{track.title}</span>
              <span className="mu-track-artist">{track.artist}</span>
            </span>
            {showAlbum ? <span className="mu-track-album">{track.album}</span> : null}
            <span className="mu-track-time">{formatMusicTime(track.durationMs)}</span>
            <TrackMenu track={track} />
          </li>
        );
      })}
    </ol>
  );
}

/** Track lockup shelf: columns of four rows. */
export function TrackLockups({ tracks, source }: { tracks: MusicTrack[]; source: string }) {
  const player = useMusicPlayer();
  const columns = Array.from({ length: Math.ceil(tracks.length / 4) }, (_, c) => tracks.slice(c * 4, c * 4 + 4));
  return columns.map((column, c) => (
    <ul key={c} className="mu-track-lockups">
      {column.map((track, r) => (
        <li key={track.id} className="mu-track-lockup">
          <button type="button" className="mu-track-lockup-play" onClick={() => player.playList(tracks, c * 4 + r, source)} aria-label={`Play ${track.title} by ${track.artist}`}>
            <Artwork hue={track.hue} className="is-row" />
            <span className="mu-track-main">
              <span className="mu-track-title">{track.title}</span>
              <span className="mu-track-artist">{track.artist} · {track.album}</span>
            </span>
          </button>
          <TrackMenu track={track} />
        </li>
      ))}
    </ul>
  ));
}

export function DetailHeader({ title, subtitle, meta, description, hue, tracks }: { title: string; subtitle: string; meta: string; description?: string; hue: number; tracks: MusicTrack[] }) {
  const player = useMusicPlayer();
  const minutes = Math.round(tracks.reduce((sum, track) => sum + track.durationMs, 0) / 60000);
  const shufflePlay = () => {
    if (!player.queue.shuffle) player.toggleShuffle();
    player.playList(tracks, Math.floor(Math.random() * tracks.length), title);
  };
  return (
    <header className="mu-detail" style={hueStyle(hue)}>
      <div className="mu-detail-art"><Artwork hue={hue} className="is-hero is-glow" /><Artwork hue={hue} className="is-hero" label={`${title} artwork`} /></div>
      <div className="mu-detail-text">
        <h1 className="mu-detail-title">{title}</h1>
        <p className="mu-detail-subtitle">{subtitle}</p>
        <p className="mu-detail-meta">{meta}</p>
        {description ? <p className="mu-detail-description">{description}</p> : null}
        <div className="mu-detail-actions">
          <button type="button" className="mu-pill-button" onClick={() => player.playList(tracks, 0, title)} disabled={tracks.length === 0}><MusicIcon name="play" size={16} /> Play</button>
          <button type="button" className="mu-pill-button" onClick={shufflePlay} disabled={tracks.length === 0}><MusicIcon name="shuffle" size={16} /> Shuffle</button>
        </div>
      </div>
      <p className="mu-detail-footer">{tracks.length} {tracks.length === 1 ? 'song' : 'songs'}, {minutes} {minutes === 1 ? 'minute' : 'minutes'}</p>
    </header>
  );
}
