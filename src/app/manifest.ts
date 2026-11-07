import type { MetadataRoute } from 'next';

// Installing OmniLume from the browser menu (Android: "Install app" / "Add to
// Home screen") adds it to the phone's share sheet: sharing a link from the
// YouTube or Twitch app opens /share with it.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'OmniLume',
    short_name: 'OmniLume',
    description: 'Shared digital spaces for watching, studying, and talking together.',
    start_url: '/home',
    scope: '/',
    display: 'standalone',
    background_color: '#0b0911',
    theme_color: '#0b0911',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    share_target: {
      action: '/share',
      method: 'GET',
      params: { title: 'title', text: 'text', url: 'url' },
    },
  } as MetadataRoute.Manifest;
}
