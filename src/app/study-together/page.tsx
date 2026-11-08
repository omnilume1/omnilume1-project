import type { Metadata } from 'next';
import UseCasePage from '@/components/landing/UseCasePage';

export const metadata: Metadata = {
  title: 'Study With Friends Online, Shared Focus Timer | Omnilume',
  description: 'Study with friends online in one shared room: a group Pomodoro timer, shared notes, PDFs side by side, a whiteboard and voice chat. Free, in your browser.',
};

export default function StudyTogetherPage() {
  return (
    <UseCasePage
      path="/study-together"
      title="Study with friends online, in one shared room"
      lede="Run one Pomodoro timer for the whole group, write notes together and read the same PDFs side by side. Breaks start together, so nobody drifts off."
      features={[
        { icon: 'timer', name: 'Group focus timer', desc: 'One Pomodoro timer for the whole room, so work and breaks start together.' },
        { icon: 'notes', name: 'Shared notes', desc: 'Write notes together while the session runs. They stay with the room.' },
        { icon: 'file', name: 'PDFs and files', desc: 'Drop in PDFs and files and read them side by side in the room.' },
        { icon: 'pen', name: 'Whiteboard', desc: 'Work through problems on one canvas that everyone can draw on.' },
        { icon: 'mic', name: 'Voice and chat', desc: 'Talk or type without leaving the room.' },
      ]}
    />
  );
}
