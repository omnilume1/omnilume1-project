import type { CSSProperties } from 'react';
import styles from '@/app/landing.module.css';

const PALETTE = ['#5b3df5', '#8b6cff', '#b9a8ff', '#3a2399', '#c084fc', '#7c5cff'];

// Seeded, so server and client render the same markup (concept video recipe).
function makeBars(count: number, seed: number, scale: number) {
  let r = seed;
  const rnd = () => (r = (r * 9301 + 49297) % 233280) / 233280;
  return Array.from({ length: count }, () => {
    const height = (30 + rnd() * 120) * scale;
    const c1 = PALETTE[Math.floor(rnd() * PALETTE.length)];
    const c2 = PALETTE[Math.floor(rnd() * PALETTE.length)];
    const top = 1300 - 700 * scale + rnd() * 1400 * scale;
    const blur = (6 + rnd() * 18) * scale;
    const o = 0.35 + rnd() * 0.5;
    const s = 0.25 + rnd() * 0.35;
    const p = rnd() * 6.28;
    const x = (rnd() - 0.5) * 700 * scale;
    const half = Math.PI / s; // half a sine period, in seconds
    return {
      style: {
        top: `${top.toFixed(0)}px`, height: `${height.toFixed(0)}px`, filter: `blur(${blur.toFixed(1)}px)`,
        background: `linear-gradient(90deg, transparent 18%, ${c1} 38%, ${c2} 52%, transparent 70%)`,
        ['--x' as string]: `${x.toFixed(0)}px`, ['--o' as string]: o.toFixed(3),
        ['--drift' as string]: `${half.toFixed(2)}s`, ['--pulse' as string]: `${(half / 1.7).toFixed(2)}s`, ['--delay' as string]: `${(-(p / s)).toFixed(2)}s`,
      } as CSSProperties,
    };
  });
}

// Diagonal light bars whose lit segment drifts along the bar. Motion is pure
// CSS transform/opacity and pauses offscreen via LandingMotion.
export default function Stripes({ count, seed, scale = 1, className }: { count: number; seed: number; scale?: number; className: string }) {
  return (
    <div className={`${styles.stripes} ${className}`} data-anim aria-hidden="true">
      <div className={styles.stripesRot}>
        {makeBars(count, seed, scale).map((bar, index) => <span key={index} className={styles.stripe} style={bar.style} />)}
      </div>
    </div>
  );
}
