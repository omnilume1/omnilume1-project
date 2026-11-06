'use client';

import dynamic from 'next/dynamic';

// Development-only annotation overlay. Behind a dynamic import so production
// bundles never ship it (a static import cost every page ~400 KB of JS).
const Agentation = process.env.NODE_ENV === 'development'
  ? dynamic(() => import('agentation').then((mod) => mod.Agentation), { ssr: false })
  : () => null;

export default function DevAgentation() {
  return <Agentation endpoint="http://localhost:4747" />;
}
