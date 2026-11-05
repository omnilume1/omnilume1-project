import type { ReactNode, SVGProps } from 'react';

// OmniLume's own transport glyphs (24px grid). Filled shapes use currentColor.
const glyphs = {
  play: <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" fill="currentColor" />,
  pause: <><rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" /><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" /></>,
  next: <><path d="M4 6.6v10.8a.8.8 0 0 0 1.2.7l8.3-5.4a.8.8 0 0 0 0-1.4L5.2 5.9a.8.8 0 0 0-1.2.7Z" fill="currentColor" /><path d="M12 6.6v10.8a.8.8 0 0 0 1.2.7l8.3-5.4a.8.8 0 0 0 0-1.4l-8.3-5.4a.8.8 0 0 0-1.2.7Z" fill="currentColor" /></>,
  previous: <><path d="M20 6.6v10.8a.8.8 0 0 1-1.2.7l-8.3-5.4a.8.8 0 0 1 0-1.4l8.3-5.4a.8.8 0 0 1 1.2.7Z" fill="currentColor" /><path d="M12 6.6v10.8a.8.8 0 0 1-1.2.7l-8.3-5.4a.8.8 0 0 1 0-1.4l8.3-5.4a.8.8 0 0 1 1.2.7Z" fill="currentColor" /></>,
  shuffle: <path d="M3 7h3.5c2 0 3.2 1 4.3 2.8l2.4 4.4c1 1.8 2.3 2.8 4.3 2.8H20m0 0-2.5-2.5M20 17l-2.5 2.5M3 17h3.5c1.2 0 2.1-.4 2.8-1.1M20 7h-2.5c-1.2 0-2.1.4-2.8 1.1M20 7l-2.5-2.5M20 7l-2.5 2.5" />,
  repeat: <path d="M4 11V9.5A3.5 3.5 0 0 1 7.5 6H19m0 0-2.5-2.5M19 6l-2.5 2.5M20 13v1.5a3.5 3.5 0 0 1-3.5 3.5H5m0 0 2.5 2.5M5 18l2.5-2.5" />,
  repeatOne: <><path d="M4 11V9.5A3.5 3.5 0 0 1 7.5 6H19m0 0-2.5-2.5M19 6l-2.5 2.5M20 13v1.5a3.5 3.5 0 0 1-3.5 3.5H5m0 0 2.5 2.5M5 18l2.5-2.5" /><path d="M11.2 10.4 12.5 9.6V14.4" /></>,
  queue: <path d="M4 6h12M4 11h12M4 16h7M15.5 14.5v5l4-2.5-4-2.5Z" />,
  lyrics: <><path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-7l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" /><path d="M8 9h8M8 12h5" /></>,
  volume: <><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4Z" fill="currentColor" stroke="none" /><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" /></>,
  mute: <><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4Z" fill="currentColor" stroke="none" /><path d="m16 9.5 5 5M21 9.5l-5 5" /></>,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  more: <><circle cx="6" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="18" cy="12" r="1.5" fill="currentColor" stroke="none" /></>,
  expand: <path d="M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  search: <><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 5 5" /></>,
  home: <path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1v-8.5Z" />,
  note: <><path d="M9 18V5.5l10-2V16" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="16.5" cy="16" r="2.5" /></>,
  album: <><rect x="3.5" y="3.5" width="17" height="17" rx="3" /><circle cx="12" cy="12" r="3.5" /></>,
  artist: <><circle cx="12" cy="8.5" r="3.5" /><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" /></>,
  playlist: <path d="M4 6h11M4 11h11M4 16h6M17 19.5V9l4-1" />,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2-1.2L14.2 3h-4.4l-.4 2.6a7 7 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-.9a7 7 0 0 0 2 1.2l.4 2.6h4.4l.4-2.6a7 7 0 0 0 2-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2Z" /></>,
  back: <path d="M15 5 8 12l7 7" />,
  chevronRight: <path d="m9 5 7 7-7 7" />,
} satisfies Record<string, ReactNode>;

export type MusicIconName = keyof typeof glyphs;

export function MusicIcon({ name, size = 20, ...props }: SVGProps<SVGSVGElement> & { name: MusicIconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>
      {glyphs[name]}
    </svg>
  );
}
