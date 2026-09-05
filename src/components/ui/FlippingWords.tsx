'use client';

import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';

interface FlippingWordsProps {
  phrases: string[];
  prefix?: string;
  intervalMs?: number;
  className?: string;
}

// Must match the flip-word-out duration in globals.css.
const EXIT_MS = 560;
const CHAR_STAGGER_MS = 35;

/**
 * Shared animated phrase line: the outgoing phrase lifts up, blurs and fades
 * while the incoming phrase enters from below with a per-character stagger —
 * both layers render on the same frame, so there is never an empty gap.
 */
export default function FlippingWords({
  phrases,
  prefix,
  intervalMs = 3200,
  className = '',
}: FlippingWordsProps) {
  const safePhrases = phrases.filter(Boolean);
  const [index, setIndex] = useState<{ current: number; outgoing: number | null }>({
    current: 0,
    outgoing: null,
  });

  useEffect(() => {
    if (safePhrases.length < 2) return;

    const timer = window.setInterval(() => {
      setIndex((state) => ({ current: (state.current + 1) % safePhrases.length, outgoing: state.current }));
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [intervalMs, safePhrases.length]);

  // Remove the exit layer once its animation has fully finished so the DOM
  // only carries the live phrase between cycles.
  useEffect(() => {
    if (index.outgoing === null) return;
    const cleanup = window.setTimeout(() => {
      setIndex((state) => (state.outgoing === null ? state : { ...state, outgoing: null }));
    }, EXIT_MS);
    return () => window.clearTimeout(cleanup);
  }, [index.outgoing]);

  if (safePhrases.length === 0) return null;

  const renderChars = (phrase: string, animated: boolean) =>
    phrase.split('').map((char, charIndex) => {
      if (char === ' ') {
        return <span key={`${charIndex}-space`} className="flip-space">{'\u00A0'}</span>;
      }
      return (
        <span
          key={charIndex}
          className="flip-char"
          style={animated ? ({ '--char-delay': `${charIndex * CHAR_STAGGER_MS}ms` } as CSSProperties) : undefined}
        >
          {char}
        </span>
      );
    });

  return (
    <p className={`flipping-words ${className}`.trim()} aria-live="polite">
      {prefix && <span className="flipping-words-prefix">{prefix}</span>}
      <span className="flipping-words-window">
        {index.outgoing !== null && (
          <span
            key={`out-${index.outgoing}`}
            className="flipping-words-value is-outgoing"
            aria-hidden="true"
          >
            {renderChars(safePhrases[index.outgoing], false)}
          </span>
        )}
        <span key={`in-${index.current}`} className="flipping-words-value is-incoming">
          {renderChars(safePhrases[index.current], true)}
        </span>
      </span>
    </p>
  );
}
