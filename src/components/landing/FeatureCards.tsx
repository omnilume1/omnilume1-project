'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import styles from '@/app/landing.module.css';

const TABS = [{ label: 'Study', first: 0 }, { label: 'Watch', first: 4 }, { label: 'Music', first: 6 }, { label: 'Social', first: 8 }];

// Tabs scroll the rail to their first card; scrolling the rail by hand moves
// the tab. The highlight slides with transform only.
export default function FeatureCards({ heading, children }: { heading: ReactNode; children: ReactNode }) {
  const [active, setActive] = useState(0);
  const railRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const hiRef = useRef<HTMLSpanElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const moveHighlight = useCallback((index: number) => {
    const tab = tabRefs.current[index];
    const hi = hiRef.current;
    if (!tab || !hi) return;
    hi.style.width = `${tab.offsetWidth}px`;
    hi.style.transform = `translateX(${tab.offsetLeft}px)`;
    tabsRef.current?.setAttribute('data-ready', '');
  }, []);
  useLayoutEffect(() => moveHighlight(active), [active, moveHighlight]);

  const cardsOf = () => [...(railRef.current?.querySelectorAll<HTMLElement>('[data-card]') ?? [])];
  const go = (index: number) => {
    setActive(index);
    const rail = railRef.current;
    const card = cardsOf()[TABS[index].first];
    if (!rail || !card) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    rail.scrollTo({ left: card.offsetLeft - cardsOf()[0].offsetLeft, behavior: reduced ? 'auto' : 'smooth' });
  };

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    let frame = 0;
    const sync = () => {
      frame = 0;
      const cards = cardsOf();
      if (!cards.length) return;
      const left = rail.scrollLeft + cards[0].offsetLeft + 40;
      const atEnd = rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 4;
      let index = 0;
      TABS.forEach((tab, i) => { if (cards[tab.first] && cards[tab.first].offsetLeft <= left) index = i; });
      setActive(atEnd ? TABS.length - 1 : index);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(sync); };
    // scrollend fires once a smooth tab scroll settles, so the tab never flickers mid-way.
    rail.addEventListener('scrollend', onScroll);
    const onResize = () => moveHighlight(TABS.findIndex((_, i) => tabRefs.current[i]?.getAttribute('aria-pressed') === 'true'));
    window.addEventListener('resize', onResize);
    return () => { cancelAnimationFrame(frame); rail.removeEventListener('scrollend', onScroll); window.removeEventListener('resize', onResize); };
  }, [moveHighlight]);

  return (
    <>
      <div className={styles.splitHead} data-reveal>
        {heading}
        <div className={`${styles.tabs} glass glow`} ref={tabsRef} role="group" aria-label="Feature groups">
          <span className={styles.tabHi} ref={hiRef} aria-hidden="true" />
          {TABS.map((tab, index) => (
            <button key={tab.label} type="button" ref={(el) => { tabRefs.current[index] = el; }} className={styles.tab} aria-pressed={active === index} onClick={() => go(index)}>{tab.label}</button>
          ))}
        </div>
      </div>
      <div className={styles.rail} ref={railRef} data-reveal style={{ ['--d' as string]: '.25s' }}>
        <div className={styles.row} data-anim>{children}</div>
      </div>
    </>
  );
}
