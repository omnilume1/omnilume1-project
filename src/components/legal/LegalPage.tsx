import Link from 'next/link';
import type { ReactNode } from 'react';
import OmniLogo from '@/components/ui/OmniLogo';

export const LEGAL_LAST_UPDATED = '10 November 2026';

const LEGAL_LINKS = [
  { href: '/privacy', label: 'Privacy' },
  { href: '/terms', label: 'Terms' },
  { href: '/copyright', label: 'Copyright' },
];

// Shared shell for the public legal pages (/privacy, /terms, /copyright).
// Plain server component: no auth, no client JS.
export default function LegalPage({ title, intro, children }: { title: string; intro: ReactNode; children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10 sm:py-16">
      <OmniLogo />
      <article className="glass-card-ambient mt-8 p-6 sm:p-10" aria-labelledby="legal-title">
        <p className="section-kicker">Legal</p>
        <h1 id="legal-title" className="text-2xl font-semibold text-white">{title}</h1>
        <p className="mt-2 text-xs text-neutral-500">Last updated {LEGAL_LAST_UPDATED}</p>
        <div className="mt-5 space-y-3 text-sm leading-relaxed text-neutral-300">{intro}</div>
        {children}
      </article>
      <nav aria-label="Legal pages" className="mt-6 flex flex-wrap gap-4 text-sm text-neutral-400">
        {LEGAL_LINKS.map((link) => (
          <Link key={link.href} href={link.href} className="hover:text-white">{link.label}</Link>
        ))}
        <Link href="/" className="hover:text-white">OmniLume home</Link>
      </nav>
    </main>
  );
}

export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold text-white">{title}</h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-neutral-300">{children}</div>
    </section>
  );
}

export function LegalList({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-1.5 pl-5">{children}</ul>;
}

/** Marks details the owner still has to fill in (roadmap D3). */
export function Placeholder({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-white">[PLACEHOLDER: {children}]</strong>;
}
