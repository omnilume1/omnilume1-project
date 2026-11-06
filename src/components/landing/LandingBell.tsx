'use client';

import dynamic from 'next/dynamic';

// Only signed-in visitors see the bell on the landing, so everyone else never downloads it, the app
// styles it uses or the Supabase client it brings. A Server Component cannot code-split a Client Component itself.
const LandingBell = dynamic(() => import('./AccountBell'));

export default LandingBell;
