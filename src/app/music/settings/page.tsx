import { PageTitle } from '@/components/music/MusicParts';

const SHORTCUTS: [string, string][] = [
  ['Space', 'Play / pause'],
  ['Ctrl/⌘ + →', 'Next song'],
  ['Ctrl/⌘ + ←', 'Previous song (restarts after 10 s)'],
  ['Ctrl/⌘ + ↑ / ↓', 'Volume up / down'],
  ['Ctrl/⌘ + F or /', 'Search'],
  ['Esc', 'Close full screen, menu or side panel'],
  ['Alt + ↑ / ↓', 'Reorder a focused Up Next song'],
];

export default function MusicSettingsPage() {
  return (
    <>
      <PageTitle>Settings</PageTitle>
      <section className="mu-section mu-settings" aria-labelledby="mu-shortcuts">
        <h2 id="mu-shortcuts" className="mu-section-title">Keyboard shortcuts</h2>
        <dl className="mu-kv">
          {SHORTCUTS.map(([keys, action]) => (
            <div key={keys}><dt><kbd>{keys}</kbd></dt><dd>{action}</dd></div>
          ))}
        </dl>
        <h2 className="mu-section-title">Your music</h2>
        <p className="mu-muted">Uploads, playlists and listening history arrive in the next stage. Shuffle, repeat and volume are remembered on this device.</p>
      </section>
    </>
  );
}
