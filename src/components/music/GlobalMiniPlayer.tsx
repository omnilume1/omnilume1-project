'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { CSSProperties } from 'react';
import { useMusicPlayer } from '@/hooks/useMusicPlayer';
import { MusicIcon } from './MusicIcon';
import './mini-player.css';

/** Keeps music controllable on every page outside /music (which has its own pill). */
export default function GlobalMiniPlayer() {
  const pathname = usePathname();
  const player = useMusicPlayer();
  const track = player.queue.current;
  if (!track || pathname === '/music' || pathname.startsWith('/music/')) return null;
  const percent = track.durationMs ? Math.min(100, (player.positionMs / track.durationMs) * 100) : 0;

  return (
    <div className="music-mini" role="region" aria-label="Music player" style={{ '--mm-hue': track.hue, '--mm-progress': `${percent}%` } as CSSProperties}>
      <Link href="/music" className="music-mini-info" aria-label={`Open Music: ${track.title} by ${track.artist}`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- blob/signed artwork URL */}
        <span className="music-mini-art">{track.artwork ? <img src={track.artwork} alt="" /> : null}</span>
        <span className="music-mini-text">
          <span className="music-mini-title">{track.title}</span>
          <span className="music-mini-artist">{track.artist}</span>
        </span>
      </Link>
      <button type="button" aria-label="Previous" onClick={player.previous}><MusicIcon name="previous" size={18} /></button>
      <button type="button" aria-label={player.isPlaying ? 'Pause' : 'Play'} onClick={player.toggle}><MusicIcon name={player.isPlaying ? 'pause' : 'play'} size={20} /></button>
      <button type="button" aria-label="Next" onClick={player.next}><MusicIcon name="next" size={18} /></button>
      <button type="button" aria-label="Stop and close player" onClick={player.stop}><MusicIcon name="close" size={16} /></button>
      <span className="music-mini-progress" aria-hidden="true" />
    </div>
  );
}
