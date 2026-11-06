'use client';

import { useEffect } from 'react';

// One listener and one rAF for the whole app: the hovered .glow surfaces get
// --mx/--my so their ::before/::after light follows the pointer. No React state.
export default function GlassPointerLight() {
  useEffect(() => {
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let frame = 0;
    let x = 0;
    let y = 0;
    let target: Element | null = null;
    let lit: HTMLElement[] = [];

    const paint = () => {
      frame = 0;
      const next: HTMLElement[] = [];
      for (let el = target?.closest<HTMLElement>('.glow') ?? null; el; el = el.parentElement?.closest<HTMLElement>('.glow') ?? null) next.push(el);
      for (const el of lit) if (!next.includes(el)) { el.style.removeProperty('--mx'); el.style.removeProperty('--my'); }
      for (const el of next) {
        const rect = el.getBoundingClientRect();
        el.style.setProperty('--mx', `${Math.round(x - rect.left)}px`);
        el.style.setProperty('--my', `${Math.round(y - rect.top)}px`);
      }
      lit = next;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };
    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      x = event.clientX;
      y = event.clientY;
      target = event.target instanceof Element ? event.target : null;
      schedule();
    };
    const onLeave = () => { target = null; schedule(); };

    document.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
    };
  }, []);
  return null;
}
