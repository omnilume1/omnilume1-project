'use client';

import Form from 'next/form';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMusicPlayer } from '@/hooks/useMusicPlayer';
import { MUSIC_PLAYLISTS } from '@/lib/music-fixtures';
import { musicShortcutFor } from '@/lib/music-shortcuts';
import { MusicIcon, type MusicIconName } from './MusicIcon';
import { FullScreenPlayer, PlayerPill, SidePanel, type SidePanelKind } from './MusicPlayerChrome';

const LIBRARY: [string, string, MusicIconName][] = [
  ['songs', 'Songs', 'note'],
  ['albums', 'Albums', 'album'],
  ['artists', 'Artists', 'artist'],
  ['playlists', 'Playlists', 'playlist'],
];

function NavItem({ href, icon, children, active }: { href: string; icon: MusicIconName; children: ReactNode; active: boolean }) {
  return (
    <Link href={href} className={`mu-nav-item ${active ? 'is-active' : ''}`} aria-current={active ? 'page' : undefined}>
      <MusicIcon name={icon} size={20} />
      <span>{children}</span>
    </Link>
  );
}

export default function MusicShell({ fontClass, children }: { fontClass: string; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const player = useMusicPlayer();
  const playerRef = useRef(player);
  const [panel, setPanel] = useState<SidePanelKind>('queue');
  const [panelOpen, setPanelOpen] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    playerRef.current = player;
  });

  const togglePanel = (kind: SidePanelKind) => {
    setPanelOpen(!(panelOpen && panel === kind));
    setPanel(kind);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const shortcut = musicShortcutFor({ key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, target: event.target as HTMLElement | null });
      if (!shortcut) return;
      const current = playerRef.current;
      if (shortcut === 'escape') {
        if (fullScreen) setFullScreen(false);
        else if (drawerOpen) setDrawerOpen(false);
        else if (panelOpen) setPanelOpen(false);
        return;
      }
      event.preventDefault();
      if (shortcut === 'toggle') current.toggle();
      else if (shortcut === 'next') current.next();
      else if (shortcut === 'previous') current.previous();
      else if (shortcut === 'volumeUp') current.setVolume(current.volume + 0.1);
      else if (shortcut === 'volumeDown') current.setVolume(current.volume - 0.1);
      else if (shortcut === 'search') {
        const field = [...document.querySelectorAll<HTMLInputElement>('[data-music-search]')].find((input) => input.offsetParent !== null);
        if (field) field.focus();
        else router.push('/music/search');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullScreen, drawerOpen, panelOpen, router]);

  return (
    <div className={`music-app ${fontClass}`} data-panel-open={panelOpen} data-drawer-open={drawerOpen} data-has-track={Boolean(player.queue.current)}>
      <a href="#music-main" className="mu-skip">Skip to content</a>

      <header className="mu-topbar">
        <button type="button" className="mu-icon-button" aria-label="Open music navigation" aria-expanded={drawerOpen} aria-controls="music-sidebar" onClick={() => setDrawerOpen(true)}><MusicIcon name="menu" /></button>
        <Link href="/music" className="mu-brand"><MusicIcon name="note" size={18} /> Music</Link>
        <Link href="/music/search" className="mu-icon-button" aria-label="Search music"><MusicIcon name="search" /></Link>
      </header>

      <div className="mu-scrim" onClick={() => setDrawerOpen(false)} aria-hidden="true" />
      <aside id="music-sidebar" className="mu-sidebar" aria-label="Music sidebar">
        <div className="mu-sidebar-head">
          <Link href="/music" className="mu-brand"><MusicIcon name="note" size={20} /> OmniLume Music</Link>
          <button type="button" className="mu-icon-button mu-drawer-close" aria-label="Close music navigation" onClick={() => setDrawerOpen(false)}><MusicIcon name="close" size={18} /></button>
        </div>
        <Form action="/music/search" className="mu-search" role="search">
          <MusicIcon name="search" size={16} />
          <input name="q" type="search" placeholder="Search" aria-label="Search music" maxLength={100} data-music-search />
        </Form>
        <nav aria-label="Music" onClick={(event) => { if ((event.target as HTMLElement).closest('a')) setDrawerOpen(false); }}>
          <NavItem href="/music" icon="home" active={pathname === '/music'}>Home</NavItem>
          <NavItem href="/music/search" icon="search" active={pathname === '/music/search'}>Search</NavItem>
          <h2 className="mu-nav-heading">Library</h2>
          {LIBRARY.map(([section, label, icon]) => (
            <NavItem key={section} href={`/music/library/${section}`} icon={icon} active={pathname === `/music/library/${section}`}>{label}</NavItem>
          ))}
          <h2 className="mu-nav-heading">Playlists</h2>
          {MUSIC_PLAYLISTS.map((playlist) => (
            <NavItem key={playlist.id} href={`/music/playlist/${playlist.id}`} icon="playlist" active={pathname === `/music/playlist/${playlist.id}`}>{playlist.title}</NavItem>
          ))}
        </nav>
        <div className="mu-sidebar-foot">
          <NavItem href="/music/settings" icon="settings" active={pathname === '/music/settings'}>Settings</NavItem>
          <NavItem href="/home" icon="back" active={false}>Back to OmniLume</NavItem>
        </div>
      </aside>

      <main id="music-main" className="mu-main" tabIndex={-1}>{children}</main>

      <PlayerPill panel={panel} panelOpen={panelOpen} onPanel={togglePanel} onExpand={() => setFullScreen(true)} />
      <SidePanel kind={panel} open={panelOpen} />
      {fullScreen ? <FullScreenPlayer onClose={() => setFullScreen(false)} /> : null}
    </div>
  );
}
