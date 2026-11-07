// Logos for the sites people watch from. YouTube and Twitch open the room's
// own search when the parent passes onSearch; otherwise (and always for Kick)
// they open the site in a new tab so a link can be pasted back here. Kick
// plays only from .m3u8 links.
const SITES = [
  {
    name: 'YouTube',
    href: 'https://www.youtube.com/',
    color: '#ff0033',
    hint: 'Open YouTube in a new tab. Copy a video or playlist link and paste it here.',
    path: 'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z',
  },
  {
    name: 'Twitch',
    href: 'https://www.twitch.tv/',
    color: '#9146ff',
    hint: 'Open Twitch in a new tab. Copy a channel or video link and paste it here.',
    path: 'M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z',
  },
  {
    name: 'Kick',
    href: 'https://kick.com/',
    color: '#53fc18',
    hint: 'Open Kick in a new tab. Kick plays here only from a direct .m3u8 stream link.',
    path: 'M1.333 0h8v5.333H12V2.667h2.667V0h8v8H20v2.667h-2.667v2.666H20V16h2.667v8h-8v-2.667H12v-2.666H9.333V24h-8Z',
  },
] as const;

// Sites the room can search itself; with onSearch their logos open that
// search inside the room instead of a new tab.
const SEARCHABLE: Partial<Record<(typeof SITES)[number]['name'], 'youtube' | 'twitch'>> = { YouTube: 'youtube', Twitch: 'twitch' };

export default function SiteLinks({ className = '', onSearch }: { className?: string; onSearch?: (source: 'youtube' | 'twitch') => void }) {
  return (
    <nav aria-label="Find something to watch" className={`site-links ${className}`}>
      <span className="site-links-label">Find something on</span>
      {SITES.map((site) => {
        const logo = <svg viewBox="0 0 24 24" width="16" height="16" fill={site.color} aria-hidden="true"><path d={site.path} /></svg>;
        const source = SEARCHABLE[site.name];
        if (onSearch && source) {
          return (
            <button key={site.name} type="button" className="site-link" title={`Search ${site.name} here and play a result for everyone.`} aria-label={`Search ${site.name} in the room`} onClick={() => onSearch(source)}>
              {logo}<span>{site.name}</span>
            </button>
          );
        }
        return (
          <a key={site.name} href={site.href} target="_blank" rel="noopener noreferrer" className="site-link" title={site.hint} aria-label={`Open ${site.name} in a new tab`}>
            {logo}<span>{site.name}</span>
          </a>
        );
      })}
    </nav>
  );
}
