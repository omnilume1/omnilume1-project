'use client';

import { useEffect, useState } from 'react';

interface FlippingWordsProps {
  phrases: string[];
  prefix?: string;
  intervalMs?: number;
  className?: string;
}

export default function FlippingWords({
  phrases,
  prefix,
  intervalMs = 3200,
  className = '',
}: FlippingWordsProps) {
  const safePhrases = phrases.filter(Boolean);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (safePhrases.length < 2) return;

    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % safePhrases.length);
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [intervalMs, safePhrases.length]);

  if (safePhrases.length === 0) return null;

  return (
    <p className={`flipping-words ${className}`.trim()} aria-live="polite">
      {prefix && <span className="flipping-words-prefix">{prefix}</span>}
      <span className="flipping-words-window">
        <span key={`${safePhrases[index]}-${index}`} className="flipping-words-value">
          {safePhrases[index]}
        </span>
      </span>
    </p>
  );
}
