import Link from 'next/link';
import { OmniMark } from '@/components/ui/OmniMarkSprite';

export default function OmniLogo({ href = '/', compact = false, size = 28 }: { href?: string; compact?: boolean; size?: number }) {
  return (
    <Link href={href} className="omni-logo" aria-label="OmniLume home">
      <OmniMark size={size} className="omni-logo-mark" />
      {!compact && <span className="omni-logo-word">OmniLume</span>}
    </Link>
  );
}
