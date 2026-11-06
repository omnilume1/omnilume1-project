// One copy of the OmniLume mark per page: the ring is a room, the light
// joining it is a friend arriving. Every logo draws it with <use>, so gradient
// ids never repeat and a hidden logo can't break the others.
export default function OmniMarkSprite() {
  return (
    <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: 'absolute' }}>
      <defs>
        <linearGradient id="ol-tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#1d1729" /><stop offset="1" stopColor="#0b0911" /></linearGradient>
        <linearGradient id="ol-ring" gradientUnits="userSpaceOnUse" x1="16" y1="48" x2="48" y2="16"><stop offset="0" stopColor="#4b31d4" /><stop offset=".55" stopColor="#8f78ff" /><stop offset="1" stopColor="#e8e1ff" /></linearGradient>
        <radialGradient id="ol-core"><stop offset="0" stopColor="#b9a8ff" stopOpacity=".32" /><stop offset="1" stopColor="#b9a8ff" stopOpacity="0" /></radialGradient>
        <radialGradient id="ol-glow"><stop offset="0" stopColor="#ece6ff" stopOpacity=".95" /><stop offset=".45" stopColor="#b9a8ff" stopOpacity=".45" /><stop offset="1" stopColor="#b9a8ff" stopOpacity="0" /></radialGradient>
      </defs>
      <symbol id="ol-mark" viewBox="0 0 64 64">
        <rect x="1" y="1" width="62" height="62" rx="18" fill="url(#ol-tile)" stroke="rgba(255,255,255,.14)" strokeWidth="1.5" />
        <circle cx="32" cy="32" r="13" fill="url(#ol-core)" />
        <path d="M48.59 28.29 A17 17 0 1 1 35.71 15.41" fill="none" stroke="url(#ol-ring)" strokeWidth="5" strokeLinecap="round" />
        <circle cx="44.02" cy="19.98" r="8" fill="url(#ol-glow)" />
        <circle cx="44.02" cy="19.98" r="3.6" fill="#fff" />
      </symbol>
    </svg>
  );
}

export function OmniMark({ size = 28, className }: { size?: number; className?: string }) {
  return <svg className={className} width={size} height={size} aria-hidden="true" focusable="false"><use href="#ol-mark" /></svg>;
}
