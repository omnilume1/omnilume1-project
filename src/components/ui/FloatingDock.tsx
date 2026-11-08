'use client';

import Link from 'next/link';
import { useLayoutEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { OmniMark } from '@/components/ui/OmniMarkSprite';
import { OmniIcon, type OmniIconName } from '@/components/ui/OmniIcon';
import { usePersonalMessageNotifications } from '@/hooks/usePersonalMessageNotifications';

export interface FloatingDockItem {
  title: string;
  href: string;
  icon: OmniIconName;
  emphasis?: boolean;
}

const defaultItems: FloatingDockItem[] = [
  { title: 'Home', href: '/home', icon: 'home' },
  { title: 'Search', href: '/search', icon: 'search' },
  { title: 'Rooms', href: '/explore', icon: 'compass' },
  { title: 'Create', href: '/create-room', icon: 'plus', emphasis: true },
  { title: 'Messages', href: '/messages', icon: 'message' },
  { title: 'Music', href: '/music', icon: 'music' },
  { title: 'Profile', href: '/profile', icon: 'user' },
];

// Each page mounts its own dock, so the highlight's last position is kept here
// and the next dock slides from it instead of jumping.
const highlightMemory = { x: -1 };

function playDockClick() {
  if (typeof window === 'undefined') return;
  try {
    const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 620;
    gain.gain.setValueAtTime(0.018, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.045);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.045);
    window.setTimeout(() => void context.close(), 100);
  } catch {
    // Audio is an optional enhancement and must never affect navigation.
  }
}

function isActive(item: FloatingDockItem, pathname: string) {
  if (item.href.includes('#')) return false;
  if (item.href === '/home') return pathname === '/home';
  return pathname.startsWith(item.href.split('#')[0]);
}

export function FloatingDock({ items = defaultItems }: { items?: FloatingDockItem[] }) {
  const pathname = usePathname();
  const itemRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const highlightRef = useRef<HTMLSpanElement>(null);
  const { unreadCount } = usePersonalMessageNotifications();
  const activeIndex = items.findIndex((item) => isActive(item, pathname));

  useLayoutEffect(() => {
    const highlight = highlightRef.current;
    const active = itemRefs.current[activeIndex];
    if (!highlight) return;
    if (!active) { highlight.dataset.hidden = ''; return; }
    delete highlight.dataset.hidden;
    const x = active.offsetLeft;
    if (highlightMemory.x >= 0 && highlightMemory.x !== x) {
      // Start where the previous page's dock left off, then slide.
      highlight.style.transition = 'none';
      highlight.style.transform = `translateX(${highlightMemory.x}px)`;
      void highlight.offsetWidth;
      highlight.style.transition = '';
    }
    highlight.style.transform = `translateX(${x}px)`;
    highlightMemory.x = x;
    const onResize = () => { highlightMemory.x = active.offsetLeft; highlight.style.transform = `translateX(${active.offsetLeft}px)`; };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [activeIndex]);

  return (
    <>
    {/* Where a pointer can hover, the dock stays tucked below the screen until the pointer reaches this strip or the dock (app.css). */}
    <div className="dock-edge" aria-hidden="true" />
    <div className="floating-dock-wrap">
      <nav className="floating-dock" aria-label="OmniLume navigation">
        <span className="dock-highlight" ref={highlightRef} aria-hidden="true" data-hidden />
        <Link href="/" className="dock-item dock-brand" aria-label="OmniLume home" title="OmniLume"><OmniMark size={26} /><span className="dock-tooltip" aria-hidden="true">OmniLume</span></Link>
        <span className="dock-sep" aria-hidden="true" />
        {items.map((item, index) => {
          const active = index === activeIndex;
          return (
            <Link
              key={item.title}
              ref={(element) => { itemRefs.current[index] = element; }}
              href={item.href}
              aria-label={item.title}
              aria-current={active ? 'page' : undefined}
              onClick={playDockClick}
              className={`dock-item ${active ? 'is-active' : ''} ${item.emphasis ? 'is-emphasis' : ''}`}
            >
              <OmniIcon name={item.icon} size={20} />
              {item.title === 'Messages' && unreadCount > 0 ? (
                <span className="dock-message-badge" aria-label={`${unreadCount} unread personal message${unreadCount === 1 ? '' : 's'}`}>
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              ) : null}
              <span className="dock-tooltip" aria-hidden="true">{item.title}</span>
            </Link>
          );
        })}
      </nav>
    </div>
    </>
  );
}

export default FloatingDock;
