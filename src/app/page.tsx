import Link from "next/link";
import { Navbar } from "@/components/Navbar";
import { OmniIcon, type OmniIconName } from "@/components/ui/OmniIcon";
import OmniFooter from "@/components/ui/OmniFooter";
import FlippingWords from "@/components/ui/FlippingWords";

const floatingFeatures: Array<{ icon: OmniIconName; title: string; meta: string; preview: string }> = [
  { icon: "study", title: "Study Together", meta: "Shared focus sessions", preview: "Mini room · 3 learners · 25:00 focus" },
  { icon: "play", title: "Watch Together", meta: "Stay in sync", preview: "Now playing · everyone follows along" },
  { icon: "music", title: "Music", meta: "Make it yours", preview: "Shared queue · soft waveform · now playing" },
  { icon: "file", title: "Shared Files", meta: "One calm workspace", preview: "PDF preview · notes · room documents" },
  { icon: "spark", title: "AI Assistant", meta: "Coming to every room", preview: "Ideas, summaries and next steps" },
];

const platformFeatures: Array<{ icon: OmniIconName; title: string; description: string }> = [
  { icon: "play", title: "Watch Together", description: "Shared media, gentle synchronization and a room that keeps everyone on the same page." },
  { icon: "study", title: "Study Together", description: "Focus sessions, timers and useful tools for making progress alongside other people." },
  { icon: "message", title: "Chat Together", description: "Room conversation and private encrypted messaging, designed to stay calm and connected." },
];

export default function Home() {
  return (
    <div className="omni-public omni-home">
      <Navbar />

      <main className="public-main">
        <section className="hero-grid">
          <div className="hero-copy fade-up">
            <p className="hero-eyebrow">Study · Connect · Create · Together</p>
            <h1 className="hero-title">A Brighter Space to Grow</h1>
            <p className="hero-subtitle">Study together, share ideas, build hobbies and grow together — in a space made for meaningful shared experiences.</p>
            <div className="hero-actions">
              <Link href="/login" className="omni-button omni-button-primary">Get started <OmniIcon name="arrow" size={16} /></Link>
              <Link href="/explore" className="omni-button omni-button-ghost">Explore rooms</Link>
            </div>
            <FlippingWords
              prefix="CREATE TOGETHER ·"
              phrases={["STUDY TOGETHER", "WATCH TOGETHER", "LISTEN TOGETHER", "GROW TOGETHER"]}
              className="hero-flipping-words"
            />
            <div className="stat-row" aria-label="OmniLume highlights">
              <div className="stat-item"><span className="stat-value">50K+</span><span className="stat-label">Active learners</span></div>
              <div className="stat-item"><span className="stat-value">1M+</span><span className="stat-label">Study hours</span></div>
              <div className="stat-item"><span className="stat-value">2K+</span><span className="stat-label">Active rooms</span></div>
              <div className="stat-item"><span className="stat-value">4.9/5</span><span className="stat-label">Community rating</span></div>
            </div>
          </div>

          <div className="hero-stage" aria-label="OmniLume feature highlights">
            {floatingFeatures.map((feature) => (
              <div key={feature.title} className="feature-float" tabIndex={0}>
                <span className="feature-float-icon"><OmniIcon name={feature.icon} size={16} /></span>
                <span><span className="feature-float-title">{feature.title}</span><span className="feature-float-meta">{feature.meta}</span></span>
                <span className="feature-preview" aria-hidden="true">
                  <span className="preview-heading"><span>{feature.title}</span><span>•</span></span>
                  <span className="preview-line" />
                  <span className="preview-line short" />
                  <span className="feature-float-meta">{feature.preview}</span>
                </span>
              </div>
            ))}
          </div>
        </section>

        <section id="about" className="public-feature-strip" aria-label="OmniLume features">
          {platformFeatures.map((feature) => (
            <article key={feature.title} className="public-feature-card">
              <span className="feature-float-icon"><OmniIcon name={feature.icon} size={17} /></span>
              <h2>{feature.title}</h2>
              <p>{feature.description}</p>
            </article>
          ))}
        </section>
      </main>

      <OmniFooter />
    </div>
  );
}
