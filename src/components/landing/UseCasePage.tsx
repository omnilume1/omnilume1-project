import Link from 'next/link';
import { OmniIcon, type OmniIconName } from '@/components/ui/OmniIcon';
import { OmniMark } from '@/components/ui/OmniMarkSprite';
import styles from './use-case.module.css';

type Feature = { icon: OmniIconName; name: string; desc: string };

const USE_CASES = [
  { href: '/study-together', label: 'Study together' },
  { href: '/watch-together', label: 'Watch together' },
  { href: '/listen-together', label: 'Listen together' },
];

// Static, search-focused entry pages (one per use case). "Start a room" goes to
// /create-room; the proxy sends signed-out visitors to sign in first.
export default function UseCasePage({ path, title, lede, features }: { path: string; title: string; lede: string; features: Feature[] }) {
  return (
    <div className={styles.page}>
      <div className={styles.wrap}>
        <header className={styles.nav}>
          <Link href="/" className={styles.logo} aria-label="OmniLume home"><OmniMark size={28} />OmniLume</Link>
          <Link href="/login" className={styles.navLink}>Sign in</Link>
        </header>

        <main>
          <section className={styles.hero}>
            <h1 className={styles.h1}>{title}</h1>
            <p className={styles.lede}>{lede}</p>
            <div className={styles.actions}>
              <Link href="/create-room" className="omni-button omni-button-primary">Start a room <OmniIcon name="arrow" size={16} /></Link>
              <Link href="/explore" className="omni-button">Explore public rooms</Link>
            </div>
            <p className={styles.assure}>Free · Runs in your browser, nothing to install · Invite friends with a link</p>
          </section>

          <section aria-labelledby="features-title">
            <h2 id="features-title" className={styles.h2}>What you get in the room</h2>
            <ul className={styles.grid}>
              {features.map((feature) => (
                <li key={feature.name} className={styles.card}>
                  <OmniIcon name={feature.icon} size={20} />
                  <h3>{feature.name}</h3>
                  <p>{feature.desc}</p>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="steps-title">
            <h2 id="steps-title" className={styles.h2}>How it works</h2>
            <ol className={styles.grid}>
              <li className={styles.card}><span className={styles.no}>1</span><h3>Create a room</h3><p>Name it, pick how long it lasts and choose who can join.</p></li>
              <li className={styles.card}><span className={styles.no}>2</span><h3>Share the link</h3><p>Send the invite link. Friends sign in and join from it.</p></li>
              <li className={styles.card}><span className={styles.no}>3</span><h3>Start together</h3><p>Everyone sees and hears the same thing at the same moment.</p></li>
            </ol>
          </section>
        </main>

        <footer className={styles.footer}>
          <nav aria-label="Use cases" className={styles.more}>
            {USE_CASES.filter((useCase) => useCase.href !== path).map((useCase) => (
              <Link key={useCase.href} href={useCase.href}>{useCase.label}</Link>
            ))}
            <Link href="/">OmniLume home</Link>
          </nav>
          <span>© {new Date().getFullYear()} OmniLume</span>
        </footer>
      </div>
    </div>
  );
}
