import Link from 'next/link';
import { EmptyState } from '@/components/music/MusicParts';

export default function MusicNotFound() {
  return (
    <EmptyState title="This page isn’t available" detail="It may have moved, or the link is wrong.">
      <Link href="/music" className="mu-pill-button is-key">Go to Music Home</Link>
    </EmptyState>
  );
}
