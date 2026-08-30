'use client';

import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';

export default function GlobalFocusTrap() {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    // Check every second to see if the user is trying to escape
    const trapInterval = setInterval(() => {
      const lockedRoomId = localStorage.getItem('omnilume_focus_lock');
      
      // If a lock exists, and the user is NOT in that exact room's URL, bounce them back
      if (lockedRoomId && pathname !== `/room/${lockedRoomId}`) {
        router.replace(`/room/${lockedRoomId}`);
      }
    }, 500);

    return () => clearInterval(trapInterval);
  }, [pathname, router]);

  return null;
}