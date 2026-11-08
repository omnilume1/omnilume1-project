import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      // Signed-in app pages: crawlers only ever see the sign-in redirect.
      disallow: ['/api/', '/home', '/messages', '/music', '/create-room', '/room', '/room-settings', '/profile', '/settings', '/admin', '/share'],
    },
    sitemap: 'https://omnilume.vercel.app/sitemap.xml',
  };
}
