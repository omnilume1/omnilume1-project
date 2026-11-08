import type { Metadata } from 'next';
import UseCasePage from '@/components/landing/UseCasePage';

export const metadata: Metadata = {
  title: 'Watch YouTube Together in Sync With Friends | Omnilume',
  description: 'Watch YouTube, Twitch, Vimeo and Internet Archive videos together, in sync. Play, pause and seek reach everyone at once, with voice and chat. Free, in your browser.',
};

export default function WatchTogetherPage() {
  return (
    <UseCasePage
      path="/watch-together"
      title="Watch videos together, perfectly in sync"
      lede="Search YouTube, Twitch, Vimeo or the Internet Archive from inside the room, or paste a link. Play, pause and seek reach everyone at the same moment."
      features={[
        { icon: 'tv', name: 'Synced playback', desc: 'Play, pause and seek reach everyone in the room at the same moment.' },
        { icon: 'search', name: 'Search four sources', desc: 'Find videos on YouTube, Twitch, Vimeo and the Internet Archive without leaving the room.' },
        { icon: 'share', name: 'Share a tab', desc: 'Show a browser tab to the whole room when the video lives somewhere else.' },
        { icon: 'mic', name: 'Voice and chat', desc: 'React together out loud or in the chat on the side.' },
      ]}
    />
  );
}
