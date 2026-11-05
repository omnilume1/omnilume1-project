'use client';

import { EmptyState } from '@/components/music/MusicParts';

export default function MusicError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <EmptyState title="Couldn’t load this page" detail="Something went wrong on our side.">
      <button type="button" className="mu-pill-button is-key" onClick={() => retry()}>Try Again</button>
    </EmptyState>
  );
}
