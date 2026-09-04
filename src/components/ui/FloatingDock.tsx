'use client';

import Link from 'next/link';
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
  { title: 'Explore', href: '/explore', icon: 'search' },
  { title: 'Rooms', href: '/room', icon: 'rooms' },
  { title: 'Create', href: '/create-room', icon: 'plus', emphasis: true },
  { title: 'Messages', href: '/messages', icon: 'message' },
  { title: 'Notifications', href: '/home#notifications', icon: 'bell' },
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

  return (
    <div className="floating-dock-wrap">
      <nav className="floating-dock" aria-label="OmniLume navigation">
        <div className="dock-brand"><OmniLogo compact /></div>
        <div className="dock-items">
          {items.map((item) => {
            const active = item.href === '/home'
              ? pathname === '/home'
              : pathname.startsWith(item.href.split('#')[0]);
            return (
              <Link
                key={item.title}
                href={item.href}
                aria-label={item.title}
                title={item.title}
                onClick={playDockClick}
                className={`dock-item ${active ? 'is-active' : ''} ${item.emphasis ? 'is-emphasis' : ''}`}
              >
                <OmniIcon name={item.icon} size={item.emphasis ? 20 : 17} />
                <span>{item.title}</span>
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
