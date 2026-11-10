import type { MetadataRoute } from 'next';
import { APP_SHELL_COLOR } from '@/lib/app-shell';

const shortcutIcon = (name: string) => [{ src: `/icons/shortcut-${name}.png`, sizes: '192x192', type: 'image/png' }];

// Installing OmniLume from the browser menu (Android: "Install app" / "Add to
// Home screen") adds it to the phone's share sheet: sharing a link from the
// YouTube or Twitch app opens /share with it. The Android app (a Trusted Web
// Activity, see android/) is built from this manifest.
export default function manifest(): MetadataRoute.Manifest {
  return {
    // Same as start_url, so browser installs made before `id` existed keep their identity.
    id: '/home',
    name: 'OmniLume',
    short_name: 'OmniLume',
    description: 'Shared digital spaces for watching, studying, and talking together.',
    start_url: '/home',
    scope: '/',
    display: 'standalone',
    display_override: ['standalone'],
    // No `orientation`: full-screen video must be free to rotate.
    background_color: APP_SHELL_COLOR,
    theme_color: APP_SHELL_COLOR,
    categories: ['social', 'entertainment', 'productivity'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      // White on transparent: the small icon Android shows in the status bar for notifications.
      { src: '/icons/badge-96.png', sizes: '96x96', type: 'image/png', purpose: 'monochrome' },
    ],
    shortcuts: [
      { name: 'Home', url: '/home', icons: shortcutIcon('home') },
      { name: 'Rooms', url: '/explore', icons: shortcutIcon('rooms') },
      { name: 'Messages', url: '/messages', icons: shortcutIcon('messages') },
      { name: 'Music', url: '/music', icons: shortcutIcon('music') },
    ],
    share_target: {
      action: '/share',
      method: 'GET',
      enctype: 'application/x-www-form-urlencoded',
      params: { title: 'title', text: 'text', url: 'url' },
    },
  } as MetadataRoute.Manifest;
}
