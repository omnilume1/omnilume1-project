'use client';

import Link from 'next/link';
import { useId, useRef, type CSSProperties, type ReactNode } from 'react';
import { useMusicLibrary } from '@/hooks/useMusicLibrary';
import { useMusicPlayer } from '@/hooks/useMusicPlayer';
import { formatMusicTime, type MusicAlbum, type MusicPlaylist, type MusicTrack } from '@/lib/music-model';
import { MusicIcon } from './MusicIcon';

const hueStyle = (hue: number) => ({ '--mu-hue': hue }) as CSSProperties;
const playable = (tracks: MusicTrack[]) => tracks.filter((track) => track.available !== false);

export function Artwork({ hue, src, className = '', label }: { hue: number; src?: string; className?: string; label?: string }) {
  return (
    <span className={`mu-art ${className}`} style={hueStyle(hue)} role={label ? 'img' : undefined} aria-label={label}>
      {/* eslint-disable-next-line @next/next/no-img-element -- private signed artwork URL, not optimisable */}
      {src ? <img src={src} alt="" loading="lazy" /> : null}
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

function CollectionLockup({ href, title, subtitle, hue, artwork, tracks }: { href: string; title: string; subtitle: string; hue: number; artwork?: string; tracks: MusicTrack[] }) {
  const player = useMusicPlayer();
  const list = playable(tracks);
  return (
    <div className="mu-lockup">
      <div className="mu-lockup-art">
        <Link href={href} tabIndex={-1} aria-hidden="true"><Artwork hue={hue} src={artwork} className="is-square" /></Link>
        {list.length ? (
          <button type="button" className="mu-art-play" aria-label={`Play ${title}`} onClick={() => player.playList(list, 0, title)}>
            <MusicIcon name="play" size={18} />
          </button>
        ) : null}
      </div>
      <Link href={href} className="mu-lockup-title">{title}</Link>
      <p className="mu-lockup-subtitle">{subtitle}</p>
    </div>
  );
}

export function AlbumLockup({ album }: { album: MusicAlbum }) {
  return <CollectionLockup href={`/music/album/${album.id}`} title={album.title} subtitle={album.artist} hue={album.hue} artwork={album.artwork} tracks={album.tracks} />;
}

export function PlaylistLockup({ playlist }: { playlist: MusicPlaylist }) {
  const count = playlist.tracks.length;
  return <CollectionLockup href={`/music/playlist/${playlist.id}`} title={playlist.title} subtitle={`${count} ${count === 1 ? 'song' : 'songs'}`} hue={playlist.hue} artwork={playlist.tracks[0]?.artwork} tracks={playlist.tracks} />;
}

export function ArtistLockup({ name, hue }: { name: string; hue: number }) {
  return (
    <Link href={`/music/search?q=${encodeURIComponent(name)}`} className="mu-artist">
      <Artwork hue={hue} className="is-round" />
      <span>{name}</span>
    </Link>
  );
}

export function TrackMenu({ track, playlistId }: { track: MusicTrack; playlistId?: string }) {
  const player = useMusicPlayer();
  const library = useMusicLibrary();
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const owned = Boolean(track.uploadId) && !track.sharedFrom;
  const live = track.available !== false;
  const place = (button: HTMLButtonElement) => {
    const rect = button.getBoundingClientRect();
    const element = menu.current;
    if (!element) return;
    element.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - element.offsetHeight - 8, window.innerHeight - 280))}px`;
    element.style.left = `${Math.max(8, Math.min(rect.right - 200, window.innerWidth - 208))}px`;
  };
  const run = (action: () => unknown) => {
    menu.current?.hidePopover();
    Promise.resolve(action()).catch((error: unknown) => window.alert(error instanceof Error ? error.message : 'Something went wrong.'));
  };
  return (
    <>
      <button type="button" className="mu-icon-button mu-row-more" popoverTarget={id} aria-label={`More options for ${track.title}`} onClick={(event) => place(event.currentTarget)}>
        <MusicIcon name="more" size={18} />
      </button>
      <div ref={menu} id={id} popover="auto" className="mu-menu" role="menu" aria-label={`${track.title} options`}>
        {live ? (
          <>
            <button type="button" role="menuitem" onClick={() => run(() => player.playNext(track))}>Play Next</button>
            <button type="button" role="menuitem" onClick={() => run(() => player.addToQueue(track))}>Add to Queue</button>
          </>
        ) : null}
        {owned ? library.playlists.filter((list) => list.id !== playlistId && !list.trackIds.includes(track.id)).slice(0, 8).map((list) => (
          <button key={list.id} type="button" role="menuitem" onClick={() => run(() => library.addToPlaylist(list.id, track.id))}>Add to “{list.title}”</button>
        )) : null}
        {owned ? <Link role="menuitem" href="/music/library/playlists" onClick={() => menu.current?.hidePopover()}>New Playlist…</Link> : null}
        {playlistId ? <button type="button" role="menuitem" onClick={() => run(() => library.removeFromPlaylist(playlistId, track.id))}>Remove from Playlist</button> : null}
        {owned && live ? <button type="button" role="menuitem" onClick={() => run(() => library.openShare(track))}>Share to a Room or Group…</button> : null}
        {track.albumId && live && !track.sharedFrom ? <Link role="menuitem" href={`/music/album/${track.albumId}`} onClick={() => menu.current?.hidePopover()}>Go to Album</Link> : null}
        {owned ? (
          <button type="button" role="menuitem" className="is-destructive" onClick={() => run(async () => {
            if (!window.confirm(`Delete “${track.title}” now? This can’t be undone.`)) return;
            await library.deleteUpload(track.id);
            if (player.queue.current?.id === track.id) player.stop();
          })}>Delete Upload</button>
        ) : null}
      </div>
    </>
  );
}

function NowPlayingBars() {
  return <span className="mu-bars" aria-hidden="true"><i /><i /><i /></span>;
}

export function TrackList({ tracks, source, showArt = false, detail, playlistId }: {
  tracks: MusicTrack[];
  source: string;
  showArt?: boolean;
  /** Third column; defaults to the album name. */
  detail?: (track: MusicTrack) => string | undefined;
  playlistId?: string;
}) {
  const player = useMusicPlayer();
  const currentId = player.queue.current?.id;
  if (tracks.length === 0) return <EmptyState title="No songs" />;
  const list = playable(tracks);
  const start = (track: MusicTrack) => player.playList(list, list.indexOf(track), source);
  return (
    <ol className={`mu-tracklist ${showArt ? 'has-art' : ''}`} aria-label={`${source} songs`}>
      {tracks.map((track, i) => {
        const isCurrent = track.id === currentId;
        const live = track.available !== false;
        return (
          <li key={`${track.id}-${i}`} className={`mu-track ${isCurrent ? 'is-current' : ''} ${live ? '' : 'is-unavailable'}`} onDoubleClick={() => live && start(track)}>
            <span className="mu-track-lead">
              {showArt ? <Artwork hue={track.hue} src={track.artwork} className="is-row" /> : <span className="mu-track-index">{isCurrent && player.isPlaying ? <NowPlayingBars /> : i + 1}</span>}
              {live ? (
                <button type="button" className="mu-track-play" aria-label={isCurrent && player.isPlaying ? `Pause ${track.title}` : `Play ${track.title}`} onClick={() => (isCurrent ? player.toggle() : start(track))}>
                  <MusicIcon name={isCurrent && player.isPlaying ? 'pause' : 'play'} size={14} />
                </button>
              ) : null}
            </span>
            <span className="mu-track-main">
              <span className="mu-track-title">{track.title}</span>
              <span className="mu-track-artist">{track.sharedFrom ? `${track.artist} · ${track.sharedFrom}` : track.artist}</span>
            </span>
            <span className="mu-track-album">{detail ? detail(track) : track.album}</span>
            <span className="mu-track-time">{live ? formatMusicTime(track.durationMs) : <span className="mu-badge">Expired</span>}</span>
            <TrackMenu track={track} playlistId={playlistId} />
          </li>
        );
      })}
    </ol>
  );
}

/** Track lockup shelf: columns of four rows. */
export function TrackLockups({ tracks, source }: { tracks: MusicTrack[]; source: string }) {
  const player = useMusicPlayer();
  const list = playable(tracks);
  const columns = Array.from({ length: Math.ceil(list.length / 4) }, (_, c) => list.slice(c * 4, c * 4 + 4));
  return columns.map((column, c) => (
    <ul key={c} className="mu-track-lockups">
      {column.map((track, r) => (
        <li key={track.id} className="mu-track-lockup">
          <button type="button" className="mu-track-lockup-play" onClick={() => player.playList(list, c * 4 + r, source)} aria-label={`Play ${track.title} by ${track.artist}`}>
            <Artwork hue={track.hue} src={track.artwork} className="is-row" />
            <span className="mu-track-main">
              <span className="mu-track-title">{track.title}</span>
              <span className="mu-track-artist">{track.sharedFrom ?? `${track.artist} · ${track.album}`}</span>
            </span>
          </button>
          <TrackMenu track={track} />
        </li>
      ))}
    </ul>
  ));
}

export function DetailHeader({ title, subtitle, meta, description, hue, artwork, tracks, children }: {
  title: string; subtitle: string; meta: string; description?: string; hue: number; artwork?: string; tracks: MusicTrack[]; children?: ReactNode;
}) {
  const player = useMusicPlayer();
  const list = playable(tracks);
  const minutes = Math.round(list.reduce((sum, track) => sum + track.durationMs, 0) / 60000);
  const shufflePlay = () => {
    if (!player.queue.shuffle) player.toggleShuffle();
    player.playList(list, Math.floor(Math.random() * list.length), title);
  };
  return (
    <header className="mu-detail" style={hueStyle(hue)}>
      <div className="mu-detail-art"><Artwork hue={hue} src={artwork} className="is-hero is-glow" /><Artwork hue={hue} src={artwork} className="is-hero" label={`${title} artwork`} /></div>
      <div className="mu-detail-text">
        <h1 className="mu-detail-title">{title}</h1>
        <p className="mu-detail-subtitle">{subtitle}</p>
        <p className="mu-detail-meta">{meta}</p>
        {description ? <p className="mu-detail-description">{description}</p> : null}
        <div className="mu-detail-actions">
          <button type="button" className="mu-pill-button" onClick={() => player.playList(list, 0, title)} disabled={list.length === 0}><MusicIcon name="play" size={16} /> Play</button>
          <button type="button" className="mu-pill-button" onClick={shufflePlay} disabled={list.length === 0}><MusicIcon name="shuffle" size={16} /> Shuffle</button>
          {children}
        </div>
      </div>
      <p className="mu-detail-footer">{list.length} {list.length === 1 ? 'song' : 'songs'}, {minutes} {minutes === 1 ? 'minute' : 'minutes'}</p>
    </header>
  );
}
