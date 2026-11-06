// The mark draws itself: tile, ring, core, then the friend's light springs in.
// CSS-only so it paints before any JS; reduced motion shows it already drawn.
export default function OmniIntro({ tagline = true, className = '' }: { tagline?: boolean; className?: string }) {
  return (
    <div className={`omni-intro ${className}`} role="status" aria-label="Loading OmniLume">
      <svg className="omni-intro-mark" viewBox="0 0 64 64" aria-hidden="true">
        <rect className="omni-intro-tile" x="1" y="1" width="62" height="62" rx="18" fill="url(#ol-tile)" stroke="rgba(255,255,255,.14)" strokeWidth="1.5" />
        <circle className="omni-intro-core" cx="32" cy="32" r="13" fill="url(#ol-core)" />
        <path className="omni-intro-ring" pathLength={1} d="M48.59 28.29 A17 17 0 1 1 35.71 15.41" fill="none" stroke="url(#ol-ring)" strokeWidth="5" strokeLinecap="round" />
        <g className="omni-intro-dot"><circle cx="44.02" cy="19.98" r="8" fill="url(#ol-glow)" /><circle cx="44.02" cy="19.98" r="3.6" fill="#fff" /></g>
      </svg>
      <span className="omni-intro-word">OmniLume</span>
      {tagline && <span className="omni-intro-tag">Rooms where friends study, watch and listen together</span>}
    </div>
  );
}
