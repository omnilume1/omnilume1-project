import Link from 'next/link';

export default function OmniLogo({ href = '/', compact = false }: { href?: string; compact?: boolean }) {
  return (
    <Link href={href} className="omni-logo" aria-label="OmniLume home">
      <span className="omni-logo-mark" aria-hidden="true"><span /></span>
      {!compact && <span className="omni-logo-word">OmniLume</span>}
    </Link>
  );
}
