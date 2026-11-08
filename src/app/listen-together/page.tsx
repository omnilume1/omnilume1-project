import type { Metadata } from 'next';
import UseCasePage from '@/components/landing/UseCasePage';

export const metadata: Metadata = {
  title: 'Listen to Music Together Online With Friends | Omnilume',
  description: 'Listen to music together online. Upload your songs and the whole room hears the same track at the same second, with lyrics, voice and chat. Free, in your browser.',
};

export default function ListenTogetherPage() {
  return (
    <UseCasePage
      path="/listen-together"
      title="Listen to music together, at the same second"
      lede="Upload your songs and play them for the whole room. Everyone hears the same track at the same moment, with voice and chat on the side."
      features={[
        { icon: 'headphones', name: 'In-sync listening', desc: 'Everyone hears the same song at the same second.' },
        { icon: 'upload', name: 'Your own music', desc: 'Upload your tracks with their cover art and play them for the room.' },
        { icon: 'list', name: 'Lyrics', desc: 'Follow along with the lyrics when a track has them.' },
        { icon: 'mic', name: 'Voice and chat', desc: 'Talk between songs or keep the chat going on the side.' },
      ]}
    />
  );
}
