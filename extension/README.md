# OmniLume: Send to a room (browser extension)

Sends the YouTube or Twitch page you are on to OmniLume. You pick one of your
rooms and the room opens with the link ready to **Play now**, **Play next** or
**Add to queue** (owners and people with Watch control).

Three ways to send:

- the **Send to OmniLume** button on YouTube videos, Shorts, live streams and
  playlists, and on Twitch channels and videos;
- the OmniLume button in the browser toolbar (sends the page you are on);
- right-click a link or a page → **Send to an OmniLume room**.

## Try it (Chrome, Edge, Brave)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this `extension` folder.

It opens `https://omnilume.vercel.app/share`. To point it at another address,
change `OMNILUME` in `background.js`.

Permissions: `contextMenus` (the right-click item) and `activeTab` (read the
address of the tab when you click the toolbar button). The page button only
runs on youtube.com and twitch.tv.

Kick is not included yet: Kick channel pages cannot be played in a room, only
direct `.m3u8` stream links.
