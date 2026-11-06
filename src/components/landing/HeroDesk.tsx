'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { OmniIcon, type OmniIconName } from '@/components/ui/OmniIcon';
import { clampPoint } from '@/lib/desk-layout';
import styles from '@/app/landing.module.css';
import { mmss } from './LandingMotion';
import { ROOM_SCREEN } from './heroScreenRoom';
import './hero-app.css';

type WinKey = 'main' | 'music' | 'chat';
type Point = { x: number; y: number };
type MoreKey = 'study' | 'home' | 'music';

// The demo desk is laid out on a fixed 1200×680 stage and scaled to fit.
const STAGE = { w: 1200, h: 680 };
const START: Record<WinKey, Point> = { main: { x: 32, y: 40 }, music: { x: 904, y: 372 }, chat: { x: 868, y: 72 } };
const ROOMS: Array<{ key: 'room' | MoreKey; icon: OmniIconName; name: string; meta: string; title: string; alt: string }> = [
  { key: 'room', icon: 'message', name: 'gg sh', meta: 'Room chat', title: 'gg sh · Room', alt: 'A room with a synced film, a focus timer and the room chat' },
  { key: 'study', icon: 'book', name: 'Study workspace', meta: 'Timer · notes · whiteboard', title: 'gg sh · Study workspace', alt: 'A study room with the whiteboard, shared notes and focus timer tiled' },
  { key: 'home', icon: 'home', name: 'Home', meta: 'Rooms and friends', title: 'Home', alt: 'Home with your rooms, focus history and friends' },
  { key: 'music', icon: 'music', name: 'Music', meta: 'Library · Listen Together', title: 'OmniLume Music', alt: 'OmniLume Music with uploads and Listen together' },
];

// The first screen ships with the page; the other three load once it is idle (or on the first pick).
let moreScreens: Promise<Readonly<Record<MoreKey, string>>> | null = null;
const loadMore = () => (moreScreens ??= import('./heroScreensMore').then((mod) => mod.MORE_SCREENS));

export default function HeroDesk() {
  const [pos, setPos] = useState(START);
  const [order, setOrder] = useState<WinKey[]>(['main', 'music', 'chat']);
  const [lifted, setLifted] = useState<WinKey | null>(null);
  // n counts switches: the current screen is keyed by it, so each pick mounts fresh and fades in over the last.
  const [screen, setScreen] = useState({ cur: 0, prev: 0, n: 0 });
  const [more, setMore] = useState<Readonly<Record<MoreKey, string>> | null>(null);
  const deskRef = useRef<HTMLDivElement>(null);
  const screensRef = useRef<HTMLDivElement>(null);
  const winRefs = useRef<Partial<Record<WinKey, HTMLDivElement | null>>>({});
  const scaleRef = useRef(1);
  const elapsedRef = useRef(0);
  const dragRef = useRef<{ key: WinKey; id: number; sx: number; sy: number; ox: number; oy: number; x: number; y: number; frame: number; size: { w: number; h: number } } | null>(null);

  useEffect(() => {
    const desk = deskRef.current;
    const screens = screensRef.current;
    if (!desk || !screens) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === screens) {
          screens.style.setProperty('--ss', String(entry.contentRect.width / 1440));
          continue;
        }
        scaleRef.current = Math.min(1, entry.contentRect.width / STAGE.w) || 1;
        desk.style.setProperty('--s', String(scaleRef.current));
      }
    });
    observer.observe(desk);
    observer.observe(screens);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const start = () => loadMore().then((loaded) => { if (!cancelled) setMore(loaded); });
    // Safari has no requestIdleCallback.
    const idle = typeof window.requestIdleCallback === 'function';
    const id = idle ? window.requestIdleCallback(start, { timeout: 4000 }) : window.setTimeout(start, 2500);
    return () => {
      cancelled = true;
      if (idle) window.cancelIdleCallback(id);
      else window.clearTimeout(id);
    };
  }, []);

  // Clocks in the app screens tick once a second while the desk is on screen.
  const applyTicks = useCallback(() => {
    screensRef.current?.querySelectorAll<HTMLElement>('[data-tick]').forEach((el) => {
      el.textContent = mmss(Number(el.dataset.tick) + Number(el.dataset.step) * elapsedRef.current);
    });
  }, []);
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!screensRef.current?.hasAttribute('data-playing')) return;
      elapsedRef.current += 1;
      applyTicks();
    }, 1000);
    return () => window.clearInterval(id);
  }, [applyTicks]);
  // A screen mounted mid-visit shows the same moment as the rest of the desk.
  useLayoutEffect(() => {
    applyTicks();
    const bar = screensRef.current?.querySelector<HTMLElement>('[data-state="cur"] #ha-plProg');
    if (bar) bar.style.animationDelay = `${-elapsedRef.current}s`;
  }, [screen.n, more, applyTicks]);

  const pick = (index: number) => {
    const go = () => setScreen((current) => (current.cur === index ? current : { cur: index, prev: current.cur, n: current.n + 1 }));
    if (index === 0 || more) go();
    else loadMore().then((loaded) => { setMore(loaded); go(); });
  };
  const screenHtml = (index: number) => {
    const key = ROOMS[index].key;
    return key === 'room' ? ROOM_SCREEN : more?.[key] ?? '';
  };
  const layers: Array<[index: number, key: number]> = screen.n ? [[screen.prev, screen.n - 1], [screen.cur, screen.n]] : [[screen.cur, 0]];

  const raise = (key: WinKey) => setOrder((current) => (current[current.length - 1] === key ? current : [...current.filter((k) => k !== key), key]));
  const sizeOf = (key: WinKey) => ({ w: winRefs.current[key]?.offsetWidth ?? 300, h: winRefs.current[key]?.offsetHeight ?? 280 });
  const place = (key: WinKey, point: Point) => clampPoint(point, sizeOf(key), STAGE, 8);
  const keyOf = (el: Element) => el.closest<HTMLElement>('[data-win]')?.dataset.win as WinKey;
  const registerWin = useCallback((el: HTMLDivElement | null) => { if (el) winRefs.current[el.dataset.win as WinKey] = el; }, []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const key = keyOf(event.currentTarget);
    raise(key);
    if (event.button !== 0 || window.matchMedia('(max-width: 767px)').matches) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const { x, y } = pos[key];
    // Measure once: a window's size never changes mid-drag, and reading it per move forces layout.
    dragRef.current = { key, id: event.pointerId, sx: event.clientX, sy: event.clientY, ox: x, oy: y, x, y, frame: 0, size: sizeOf(key) };
    // The light stripes hold still while a window moves: their animated layers make every frame's commit costly.
    deskRef.current?.closest<HTMLElement>('[data-landing]')?.setAttribute('data-dragging', '');
    setLifted(key);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    const s = scaleRef.current;
    const next = clampPoint({ x: drag.ox + (event.clientX - drag.sx) / s, y: drag.oy + (event.clientY - drag.sy) / s }, drag.size, STAGE, 8);
    drag.x = next.x;
    drag.y = next.y;
    // Write the transform once per frame; React state only changes on release.
    if (!drag.frame) drag.frame = requestAnimationFrame(() => {
      drag.frame = 0;
      const el = winRefs.current[drag.key];
      if (el) el.style.transform = `translate3d(${drag.x}px, ${drag.y}px, 0)`;
    });
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    cancelAnimationFrame(drag.frame);
    dragRef.current = null;
    deskRef.current?.closest<HTMLElement>('[data-landing]')?.removeAttribute('data-dragging');
    setLifted(null);
    setPos((current) => ({ ...current, [drag.key]: { x: drag.x, y: drag.y } }));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const key = keyOf(event.currentTarget);
    const step = event.shiftKey ? 64 : 16;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!delta) return;
    event.preventDefault();
    raise(key);
    setPos((current) => ({ ...current, [key]: place(key, { x: current[key].x + delta[0], y: current[key].y + delta[1] }) }));
  };
  const onRaise = (event: PointerEvent<HTMLDivElement>) => raise(keyOf(event.currentTarget));

  const winClass = (key: WinKey, extra: string) => `${styles.win} ${extra} glow ${lifted === key ? styles.lifted : ''}`;
  const winStyle = (key: WinKey) => ({ transform: `translate3d(${pos[key].x}px, ${pos[key].y}px, 0)`, zIndex: order.indexOf(key) + 2 });
  // The bar is named by its visible title (label in name); how to move it is the description.
  const bar = { className: styles.bar, tabIndex: 0, role: 'button', 'aria-roledescription': 'movable window', 'aria-describedby': 'hero-move-hint', onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onKeyDown };

  return (
    <div className={styles.desk} ref={deskRef} data-hero-desk>
      <DuskScene className={styles.scene} />
      <span id="hero-move-hint" className="sr-only">Arrow keys move this window; hold Shift to move it further.</span>
      <div className={styles.stage}>
        <div ref={registerWin} data-win="main" className={winClass('main', styles.winMain)} style={winStyle('main')} onPointerDownCapture={onRaise}>
          <div {...bar}><Dots /><span className={styles.barTitle}>{ROOMS[screen.cur].title}</span><span className={`${styles.here} mono`}>1 online</span></div>
          <div className={styles.mainBody}>
            <nav className={styles.side} aria-label="Preview pages">
              {ROOMS.map((room, index) => (
                <div key={room.name} className={styles.sideGroup}>
                  {index === 0 && <div className={styles.sideLabel}>Your room</div>}
                  {index === 2 && <div className={styles.sideLabel}>Your space</div>}
                  <button type="button" className={styles.room} aria-pressed={screen.cur === index} onClick={() => pick(index)}>
                    <OmniIcon name={room.icon} size={16} className={styles.roomIcon} />
                    <span className={styles.roomName}>{room.name}</span>
                    <span className={styles.roomMeta}>{room.meta}</span>
                  </button>
                </div>
              ))}
            </nav>
            {/* The app itself, drawn live at 1440×900 and scaled in; screen readers get the one-line description. */}
            <div ref={screensRef} className={styles.screens} aria-hidden="true" data-anim>
              {layers.map(([index, key]) => (
                <div key={key} className={styles.screen} data-state={key === screen.n ? 'cur' : 'prev'} data-enter={key === screen.n && key > 0 ? '' : undefined}>
                  <div className={`ha-root ${styles.screenFit}`} dangerouslySetInnerHTML={{ __html: screenHtml(index) }} />
                </div>
              ))}
            </div>
            <span className="sr-only">{ROOMS[screen.cur].alt}</span>
          </div>
        </div>

        <div ref={registerWin} data-win="music" className={winClass('music', styles.winMusic)} style={winStyle('music')} onPointerDownCapture={onRaise}>
          <div {...bar}><Dots /><span className={styles.barTitle}>Listening together</span></div>
          <div className={styles.musicBody}>
            <div className={styles.np}><span className={styles.art}><AlbumArt /></span><div><strong>Slow Tide</strong><span>Hana Mori</span></div></div>
            <div>
              <span className={styles.track} data-anim><b className={styles.musicProg} /></span>
              <div className={`${styles.times} mono`}><span data-clock="112" data-step="1">1:52</span><span>3:28</span></div>
            </div>
            <div className={styles.controls} aria-hidden="true"><OmniIcon name="prev" size={16} /><span className={styles.play}><OmniIcon name="pause" size={16} /></span><OmniIcon name="next" size={16} /></div>
            <div className={styles.listeners}><span className={styles.avs}><span className={styles.av}>LR</span><span className={styles.av}>AG</span></span>Lakshya and Aditya are listening</div>
          </div>
        </div>

        <div ref={registerWin} data-win="chat" className={winClass('chat', styles.winChat)} style={winStyle('chat')} onPointerDownCapture={onRaise}>
          <div {...bar}><Dots /><span className={styles.barTitle}>Aditya Gupta</span></div>
          <div className={styles.msgBody}>
            <span className={styles.e2e}><OmniIcon name="lock" size={12} />End-to-end encrypted</span>
            <div className={`${styles.bubble} ${styles.them}`}>Saved you a seat in gg sh</div>
            <div className={`${styles.bubble} ${styles.me}`}>Joining after this song</div>
            <div className={styles.composer}><span>Message</span><OmniIcon name="arrow" size={16} /></div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Dots() {
  return <span className={styles.dots} aria-hidden="true"><i /><i /><i /></span>;
}

export function AlbumArt() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <defs><linearGradient id="lp-al" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#2a3d6b" /><stop offset=".6" stopColor="#e09a7b" /><stop offset="1" stopColor="#f3c99a" /></linearGradient></defs>
      <rect width="64" height="64" fill="url(#lp-al)" /><circle cx="42" cy="30" r="9" fill="#fff1dc" />
      <path d="M0 44 C 14 36 26 40 36 46 C 46 40 56 38 64 42 L64 64 L0 64 Z" fill="#3a2b55" /><path d="M0 52 C 18 46 34 50 64 48 L64 64 L0 64 Z" fill="#1c1630" />
    </svg>
  );
}

export function DuskScene({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 1200 720" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id="lp-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#211a38" /><stop offset=".38" stopColor="#3b2c63" /><stop offset=".62" stopColor="#674b8e" /><stop offset=".78" stopColor="#9a74a8" /><stop offset=".88" stopColor="#c999a8" /></linearGradient>
        <filter id="lp-soft" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="14" /></filter>
      </defs>
      <rect width="1200" height="720" fill="url(#lp-sky)" />
      <g fill="#f4ecff" opacity=".7"><circle cx="96" cy="40" r="1.2" /><circle cx="350" cy="28" r="1.4" /><circle cx="690" cy="22" r="1.2" /><circle cx="1010" cy="30" r="1.4" /><circle cx="1150" cy="84" r="1.1" /></g>
      <circle cx="1060" cy="132" r="22" fill="#f3e8ff" opacity=".92" /><circle cx="1070" cy="126" r="20" fill="#3b2c63" opacity=".9" />
      <g filter="url(#lp-soft)" opacity=".55"><ellipse cx="260" cy="300" rx="260" ry="34" fill="#a585c4" /><ellipse cx="900" cy="250" rx="300" ry="30" fill="#8f6fb4" /><ellipse cx="620" cy="420" rx="380" ry="40" fill="#d6a6b8" /></g>
      <path d="M0 560 C 140 520 260 540 380 528 C 520 512 640 548 780 530 C 920 512 1060 540 1200 520 L1200 720 L0 720 Z" fill="#4a3770" />
      <path d="M0 600 C 160 580 300 596 460 584 C 620 572 760 600 920 588 C 1040 580 1120 590 1200 584 L1200 720 L0 720 Z" fill="#2f2449" />
      <path fill="#1d1630" d="M0 640 L40 640 L40 620 L64 604 L88 620 L88 632 L130 632 L130 612 L170 598 L196 612 L196 636 L240 636 L240 616 L268 596 L296 616 L296 640 L340 640 L340 622 L400 590 L420 606 L420 640 L470 640 L470 628 L548 610 L548 640 L600 640 L600 616 L630 600 L660 616 L660 636 L720 636 L760 604 L780 636 L830 636 L830 614 L860 594 L890 614 L890 640 L940 640 L990 604 L1010 624 L1060 624 L1090 592 L1120 610 L1120 636 L1200 618 L1200 720 L0 720 Z" />
      <g fill="#f2c47e"><rect x="56" y="626" width="6" height="8" rx="1" /><rect x="262" y="618" width="6" height="8" rx="1" /><rect x="392" y="612" width="6" height="8" rx="1" /><rect x="624" y="618" width="6" height="8" rx="1" /><rect x="854" y="616" width="6" height="8" rx="1" /><rect x="1084" y="614" width="6" height="8" rx="1" /></g>
      <rect y="660" width="1200" height="60" fill="#17121f" />
    </svg>
  );
}
