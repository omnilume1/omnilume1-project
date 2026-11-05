import { notFound } from 'next/navigation';

// Unknown /music/* URLs render the music not-found page inside the music shell.
export default function MusicCatchAll() {
  notFound();
}
