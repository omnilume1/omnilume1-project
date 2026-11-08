import type { MetadataRoute } from 'next';

const SITE = 'https://omnilume.vercel.app';

// Public pages only; app pages need an account and are disallowed in robots.ts.
export default function sitemap(): MetadataRoute.Sitemap {
  return ['/', '/study-together', '/watch-together', '/listen-together', '/explore'].map((path) => ({
    url: `${SITE}${path}`,
    changeFrequency: 'weekly',
    priority: path === '/' ? 1 : 0.8,
  }));
}
