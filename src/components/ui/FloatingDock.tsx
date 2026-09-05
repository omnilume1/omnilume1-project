'use client';

import Link from 'next/link';
import { useCallback, useRef } from 'react';
import { usePathname } from 'next/navigation';
import OmniLogo from '@/components/ui/OmniLogo';
import { OmniIcon, type OmniIconName } from '@/components/ui/OmniIcon';

export interface FloatingDockItem {
  title: string;
  href: string;
  icon: OmniIconName;
  emphasis?: boolean;
}

const defaultItems: FloatingDockItem[] = [
  { title: 'Home', href: '/home', icon: 'home' },
  { title: 'Search', href: '/search', icon: 'search' },
  { title: 'Rooms', href: '/explore', icon: 'rooms' },
  { title: 'Create', href: '/create-room', icon: 'plus', emphasis: true },
  { title: 'Messages', href: '/messages', icon: 'message' },
  { title: 'Profile', href: '/profile', icon: 'user' },
];

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

export function FloatingDock({ items = defaultItems }: { items?: FloatingDockItem[] }) {
  const pathname = usePathname();
  const itemRefs = useRef<Array<HTMLAnchorElement | null>>([]);

  const resetMagnification = useCallback(() => {
    itemRefs.current.forEach((element) => {
      element?.style.setProperty('--dock-scale', '1');
      element?.style.setProperty('--dock-lift', '0px');
      element?.style.setProperty('--dock-z-index', element?.dataset.dockEmphasis === 'true' ? '5' : '1');
    });
  }, []);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerType !== 'mouse') return;

    const dockRect = event.currentTarget.getBoundingClientRect();
    const pointerX = event.clientX - dockRect.left;

    itemRefs.current.forEach((element) => {
      if (!element) return;
      const isCreate = element.dataset.dockEmphasis === 'true';
      const center = element.offsetLeft + (element.offsetWidth / 2);
      const distance = Math.abs(pointerX - center);
      const proximity = Math.max(0, 1 - (distance / 165));

      // Every item — including the central create control — shares the same
      // distance-based scale and lift. The create control only keeps the top
      // stack level, so magnified neighbours slide beneath it instead of
      // clipping over it.
      element.style.setProperty('--dock-scale', (1 + (proximity * 0.25)).toFixed(3));
      element.style.setProperty('--dock-lift', `${Math.round(proximity * -7)}px`);
      element.style.setProperty('--dock-z-index', isCreate ? '5' : proximity > 0.04 ? '2' : '1');
    });
  }, []);

  return (
    <div className="floating-dock-wrap">
      <nav className="floating-dock" aria-label="OmniLume navigation" onPointerMove={handlePointerMove} onPointerLeave={resetMagnification}>
        <div className="dock-brand"><OmniLogo compact /></div>
        <div className="dock-items">
          {items.map((item, index) => {
            const active = item.href.includes('#')
              ? false
              : item.href === '/home'
              ? pathname === '/home'
              : pathname.startsWith(item.href.split('#')[0]);
            return (
              <Link
                key={item.title}
                ref={(element) => { itemRefs.current[index] = element; }}
                href={item.href}
                data-dock-emphasis={item.emphasis ? 'true' : undefined}
                aria-label={item.title}
                title={item.title}
                onClick={playDockClick}
                onFocus={(event) => {
                  resetMagnification();
                  event.currentTarget.style.setProperty('--dock-scale', '1.16');
                  event.currentTarget.style.setProperty('--dock-lift', '-3px');
                  event.currentTarget.style.setProperty('--dock-z-index', item.emphasis ? '5' : '2');
                }}
                onBlur={resetMagnification}
                className={`dock-item ${active ? 'is-active' : ''} ${item.emphasis ? 'is-emphasis' : ''}`}
              >
                <OmniIcon name={item.icon} size={22} />
                <span className="dock-tooltip" aria-hidden="true">{item.title}</span>
                <span className="dock-sr-label">{item.title}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

export { defaultItems as omniDockItems };
export default FloatingDock;
