/* global chrome */
// A small "Send to OmniLume" button on YouTube videos and playlists and on
// Twitch channels and videos. Both sites change pages without reloading, so
// the button checks the address once a second and hides on other pages.
(() => {
  const TWITCH_RESERVED = new Set(['directory', 'downloads', 'drops', 'friends', 'inventory', 'jobs', 'messages', 'p', 'payments', 'search', 'settings', 'subscriptions', 'turbo', 'wallet']);

  const shareable = () => {
    const { hostname, pathname, searchParams } = new URL(location.href);
    if (hostname.endsWith('youtube.com')) {
      return (pathname === '/watch' && searchParams.has('v')) || /^\/(shorts|live)\/[\w-]{11}/.test(pathname) || (pathname === '/playlist' && searchParams.has('list'));
    }
    if (hostname.endsWith('twitch.tv')) {
      const parts = pathname.split('/').filter(Boolean);
      if (parts[0] === 'videos' && /^\d+$/.test(parts[1] ?? '')) return true;
      return parts.length === 1 && /^[a-z0-9_]{1,25}$/i.test(parts[0]) && !TWITCH_RESERVED.has(parts[0].toLowerCase());
    }
    return false;
  };

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;display:none';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      button { display:flex; align-items:center; gap:8px; border:1px solid rgba(255,255,255,.18); border-radius:999px; padding:9px 14px 9px 10px;
        background:rgba(17,14,28,.92); color:#f3f0fa; font:600 13px/1 system-ui,sans-serif; cursor:pointer; box-shadow:0 10px 30px rgba(0,0,0,.45); }
      button:hover { background:rgba(40,30,70,.95); }
      button:focus-visible { outline:2px solid #b9a8ff; outline-offset:2px; }
      img { width:18px; height:18px; border-radius:5px; }
    </style>
    <button type="button" title="Play or queue this in one of your OmniLume rooms"><img alt="" src="${chrome.runtime.getURL('icons/icon-32.png')}">Send to OmniLume</button>`;
  root.querySelector('button').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'omnilume-share', url: location.href });
  });
  document.documentElement.append(host);

  let last = '';
  const update = () => {
    if (location.href === last) return;
    last = location.href;
    host.style.display = shareable() ? 'block' : 'none';
  };
  update();
  setInterval(update, 1000);
})();
