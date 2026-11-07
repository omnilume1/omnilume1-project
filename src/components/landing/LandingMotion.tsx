'use client';

import { useEffect } from 'react';

export const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.max(0, s) % 60).padStart(2, '0')}`;

// All landing motion bookkeeping in one place, with no React state:
// - [data-reveal] rises in once when it scrolls into view (IntersectionObserver).
// - [data-anim] loops play only while on screen.
// - [data-clock] counters tick once a second while on screen.
export default function LandingMotion() {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>('[data-landing]');
    if (!root) return;
    root.dataset.motion = 'on'; // always on, whatever the device's reduce-motion setting

    const reveal = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        (entry.target as HTMLElement).dataset.revealed = '';
        reveal.unobserve(entry.target);
      }
    }, { threshold: 0.12 }); // no bottom inset: the last footer row must still be reachable
    root.querySelectorAll('[data-reveal]').forEach((el) => reveal.observe(el));

    const visible = new Set<Element>();
    const play = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        if (entry.isIntersecting) { visible.add(el); el.dataset.playing = ''; } else { visible.delete(el); delete el.dataset.playing; }
      }
    }, { rootMargin: '100px 0px' });
    root.querySelectorAll('[data-anim], [data-clock]').forEach((el) => play.observe(el));

    const clocks = [...root.querySelectorAll<HTMLElement>('[data-clock]')].map((el) => ({ el, value: Number(el.dataset.clock), step: Number(el.dataset.step ?? -1) }));
    const timer = window.setInterval(() => {
      for (const clock of clocks) {
        if (!visible.has(clock.el)) continue;
        clock.value += clock.step;
        clock.el.textContent = mmss(clock.value);
      }
    }, 1000);

    return () => { reveal.disconnect(); play.disconnect(); window.clearInterval(timer); };
  }, []);
  return null;
}
