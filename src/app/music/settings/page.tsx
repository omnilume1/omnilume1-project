import { PageTitle } from '@/components/music/MusicParts';
import { SourcesSetting } from '@/components/music/MusicSources';
import { PresenceSetting } from '@/components/music/MusicTogether';

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
        <PresenceSetting />
        <h2 className="mu-section-title">Your music</h2>
        <p className="mu-muted">
          Uploads are private to you and are deleted 7 days after you add them (up to 40 files, 50 MB each, 300 MB in total).
          You can share an upload to a room or group you belong to; only its members can play it, and you can stop sharing at any time.
          Playlists and listening history are visible only to you; clear history from Recently Played. Shuffle, repeat and volume are remembered on this device.
        </p>
        <SourcesSetting />
      </section>
    </>
  );
}
