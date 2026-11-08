'use client';

import { useId } from 'react';

// Static preview art for room cards (dusk town, study ring, listening wave).
// Picked from the room id so a room keeps its art; no motion, cheap to paint.
export type RoomArtKind = 'scene' | 'study' | 'listen';

export function roomArtFor(seed: string): RoomArtKind {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return (['scene', 'study', 'listen'] as const)[Math.abs(hash) % 3];
}

// The art's purples are palette variables (app-themes.css), so it follows the app theme.
// SVG attributes can't read CSS variables, so those colours go through `style`.
const pal = (hex: string) => `rgb(var(--pal-${hex}))`;

export default function RoomArt({ kind, className }: { kind: RoomArtKind; className?: string }) {
  const id = useId().replace(/:/g, '');
  if (kind === 'study') {
    return (
      <svg className={className} viewBox="0 0 400 128" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <defs><linearGradient id={`${id}s`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" style={{ stopColor: pal('2a2048') }} /><stop offset="1" style={{ stopColor: pal('1b1530') }} /></linearGradient></defs>
        <rect width="400" height="128" fill={`url(#${id}s)`} />
        <circle cx="200" cy="64" r="40" fill="none" stroke="rgba(255,255,255,.12)" strokeWidth="6" />
        <circle cx="200" cy="64" r="40" fill="none" style={{ stroke: pal('b9a8ff') }} strokeWidth="6" strokeLinecap="round" pathLength={1} strokeDasharray="1" strokeDashoffset=".38" transform="rotate(-90 200 64)" />
        <g fill="rgba(255,255,255,.14)"><rect x="34" y="34" width="90" height="8" rx="4" /><rect x="34" y="52" width="66" height="8" rx="4" /><rect x="34" y="70" width="78" height="8" rx="4" /><rect x="284" y="34" width="84" height="60" rx="8" /></g>
      </svg>
    );
  }
  if (kind === 'listen') {
    return (
      <svg className={className} viewBox="0 0 400 128" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <defs><linearGradient id={`${id}l`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#1f4b4a" /><stop offset="1" style={{ stopColor: pal('3a2399') }} /></linearGradient></defs>
        <rect width="400" height="128" fill={`url(#${id}l)`} />
        <g fill="#bfe3c9" opacity=".85">{Array.from({ length: 40 }, (_, k) => { const h = 10 + Math.abs(Math.sin(k * 0.55) * Math.sin(k * 0.21 + 1)) * 64; return <rect key={k} x={40 + k * 8} y={64 - h / 2} width="4" height={h} rx="2" />; })}</g>
      </svg>
    );
  }
  return (
    <svg className={className} viewBox="0 0 1200 720" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs><linearGradient id={`${id}k`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" style={{ stopColor: pal('211a38') }} /><stop offset=".38" style={{ stopColor: pal('3b2c63') }} /><stop offset=".62" style={{ stopColor: pal('674b8e') }} /><stop offset=".78" style={{ stopColor: pal('9a74a8') }} /><stop offset=".88" style={{ stopColor: pal('c999a8') }} /></linearGradient></defs>
      <rect width="1200" height="720" fill={`url(#${id}k)`} />
      <circle cx="1060" cy="132" r="22" style={{ fill: pal('f3e8ff') }} opacity=".92" /><circle cx="1070" cy="126" r="20" style={{ fill: pal('3b2c63') }} opacity=".9" />
      <g opacity=".45"><ellipse cx="260" cy="300" rx="260" ry="34" style={{ fill: pal('a585c4') }} /><ellipse cx="900" cy="250" rx="300" ry="30" style={{ fill: pal('8f6fb4') }} /><ellipse cx="620" cy="420" rx="380" ry="40" style={{ fill: pal('d6a6b8') }} /></g>
      <path d="M0 560 C 140 520 260 540 380 528 C 520 512 640 548 780 530 C 920 512 1060 540 1200 520 L1200 720 L0 720 Z" style={{ fill: pal('4a3770') }} />
      <path d="M0 600 C 160 580 300 596 460 584 C 620 572 760 600 920 588 C 1040 580 1120 590 1200 584 L1200 720 L0 720 Z" style={{ fill: pal('2f2449') }} />
      <path style={{ fill: pal('1d1630') }} d="M0 640 L40 640 L40 620 L64 604 L88 620 L88 632 L130 632 L130 612 L170 598 L196 612 L196 636 L240 636 L240 616 L268 596 L296 616 L296 640 L340 640 L340 622 L400 590 L420 606 L420 640 L470 640 L470 628 L548 610 L548 640 L600 640 L600 616 L630 600 L660 616 L660 636 L720 636 L760 604 L780 636 L830 636 L830 614 L860 594 L890 614 L890 640 L940 640 L990 604 L1010 624 L1060 624 L1090 592 L1120 610 L1120 636 L1200 618 L1200 720 L0 720 Z" />
      <rect y="660" width="1200" height="60" style={{ fill: pal('17121f') }} />
    </svg>
  );
}
