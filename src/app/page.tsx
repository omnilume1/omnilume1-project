import Link from 'next/link';
import { Navbar } from '@/components/Navbar';
import { OmniIcon, type OmniIconName } from '@/components/ui/OmniIcon';
import OmniFooter from '@/components/ui/OmniFooter';
import FlippingWords from '@/components/ui/FlippingWords';
import { getCurrentAccount } from '@/lib/current-account';

type MarketingFeature = 'study' | 'watch' | 'music' | 'files' | 'assistant';

const floatingFeatures: Array<{ icon: OmniIconName; title: string; meta: string; kind: MarketingFeature }> = [
  { icon: 'study', title: 'Study Together', meta: 'Shared focus spaces', kind: 'study' },
  { icon: 'play', title: 'Watch Together', meta: 'Stay in sync', kind: 'watch' },
  { icon: 'music', title: 'Music', meta: 'Make it yours', kind: 'music' },
  { icon: 'file', title: 'Shared Files', meta: 'One calm workspace', kind: 'files' },
  { icon: 'spark', title: 'AI Assistant', meta: 'Planned room companion', kind: 'assistant' },
];

const platformFeatures: Array<{ icon: OmniIconName; title: string; description: string; kind: MarketingFeature }> = [
  { icon: 'play', title: 'Watch Together', description: 'Shared media, gentle synchronization and a room that keeps everyone on the same page.', kind: 'watch' },
  { icon: 'study', title: 'Study Together', description: 'Focus sessions, timers and useful tools for making progress alongside other people.', kind: 'study' },
  { icon: 'message', title: 'Chat Together', description: 'Room conversation and private encrypted messaging, designed to stay calm and connected.', kind: 'assistant' },
];

function MarketingPreview({ kind }: { kind: MarketingFeature }) {
  if (kind === 'study') {
    return <span className="feature-preview-visual preview-study" aria-hidden="true"><span className="preview-focus-ring"><span /></span><span><strong>Focus room</strong><small>25:00</small></span></span>;
  }
  if (kind === 'watch') {
    return <span className="feature-preview-visual preview-watch" aria-hidden="true"><span className="preview-play"><OmniIcon name="play" size={12} /></span><span className="preview-progress"><span /></span><small>Shared playback</small></span>;
  }
  if (kind === 'music') {
    return <span className="feature-preview-visual preview-music" aria-hidden="true"><span className="preview-wave"><i /><i /><i /><i /><i /><i /><i /></span><small>Room soundtrack</small></span>;
  }
  if (kind === 'files') {
    return <span className="feature-preview-visual preview-files" aria-hidden="true"><span className="preview-file-page"><i /><i /><i /></span><small>Shared workspace</small></span>;
  }
  return <span className="feature-preview-visual preview-assistant" aria-hidden="true"><span className="preview-orb" /><span><strong>Room companion</strong><small>Ideas in context</small></span></span>;
}

export default async function Home() {
  const account = await getCurrentAccount();
  const startHref = account ? (account.profileDetailsCompleted ? '/home' : '/profile/setup') : '/login';

  return (
    <div className="omni-public omni-home">
      <Navbar account={account} />

      <main className="public-main">
        <section className="hero-grid">
          <div className="hero-copy fade-up">
            <p className="hero-eyebrow">Study · Connect · Create · Together</p>
            <h1 className="hero-title">A Brighter Space to Grow</h1>
            <p className="hero-subtitle">Study together, share ideas, build hobbies and grow together.</p>
            <div className="hero-actions">
              <Link href={startHref} className="omni-button omni-button-primary">{account ? 'Go to your space' : 'Get started'} <OmniIcon name="arrow" size={16} /></Link>
              <Link href="/explore" className="omni-button omni-button-ghost">Explore rooms</Link>
            </div>
            <FlippingWords
              prefix="Create together ·"
              phrases={['Study together', 'Watch together', 'Listen together', 'Grow together']}
              className="hero-flipping-words"
            />
            <div className="stat-row" aria-label="OmniLume highlights">
              <div className="stat-item"><span className="stat-value">50K+</span><span className="stat-label">Active learners</span></div>
              <div className="stat-item"><span className="stat-value">1M+</span><span className="stat-label">Study hours</span></div>
              <div className="stat-item"><span className="stat-value">2K+</span><span className="stat-label">Active rooms</span></div>
              <div className="stat-item"><span className="stat-value">4.9/5</span><span className="stat-label">Community rating</span></div>
            </div>
          </div>

          <div className="hero-stage" aria-label="Illustrated OmniLume feature previews">
            {floatingFeatures.map((feature) => (
              <article key={feature.title} className={`feature-float feature-float--${feature.kind}`} tabIndex={0}>
                <span className="feature-float-icon"><OmniIcon name={feature.icon} size={16} /></span>
                <span><span className="feature-float-title">{feature.title}</span><span className="feature-float-meta">{feature.meta}</span></span>
                <MarketingPreview kind={feature.kind} />
              </article>
            ))}
          </div>
        </section>

        <section id="about" className="public-feature-strip" aria-label="OmniLume features">
          {platformFeatures.map((feature) => (
            <article key={feature.title} className="public-feature-card" tabIndex={0}>
              <span className="feature-float-icon"><OmniIcon name={feature.icon} size={17} /></span>
              <h2>{feature.title}</h2>
              <p>{feature.description}</p>
              <MarketingPreview kind={feature.kind} />
            </article>
          ))}
        </section>
      </main>

      <OmniFooter />
    </div>
  );
}
