'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import styles from '@/app/landing.module.css';

const STATES = 3;

// Steps through focus timer → whiteboard → shared notes while on screen.
// The markup is server-rendered; this only sets data-state on the wrapper.
// Lit sentences are buttons, so the order can be picked by hand (and is the
// only way it changes under reduced motion).
export default function WhatElse({ children }: { children: ReactNode }) {
  const [state, setState] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let timer = 0;
    const observer = new IntersectionObserver(([entry]) => {
      window.clearInterval(timer);
      // The concept video's pace: a new sentence lights every 2.2 s.
      if (entry.isIntersecting) timer = window.setInterval(() => { if (!pausedRef.current) setState((s) => (s + 1) % STATES); }, 2200);
    }, { threshold: 0.35 });
    observer.observe(root);
    return () => { observer.disconnect(); window.clearInterval(timer); };
  }, []);

  return (
    <div
      ref={rootRef}
      className={styles.moreGrid}
      data-state={state}
      // It keeps cycling under the pointer, as in the video; only the whiteboard holds it, so a drawing is not cut off.
      onPointerOver={(event) => { pausedRef.current = Boolean((event.target as Element).closest('[data-sketch]')); }}
      onPointerLeave={() => { pausedRef.current = false; }}
      onFocus={() => { pausedRef.current = true; }}
      onBlur={() => { pausedRef.current = false; }}
      onClick={(event) => {
        const pick = (event.target as Element).closest<HTMLElement>('[data-state-to]');
        if (pick) setState(Number(pick.dataset.stateTo));
      }}
      onKeyDown={(event) => {
        // The pickable sentences are inline role="button" spans so they wrap with the paragraph.
        const pick = (event.target as Element).closest<HTMLElement>('[data-state-to]');
        if (!pick || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        setState(Number(pick.dataset.stateTo));
      }}
    >
      {children}
    </div>
  );
}
