import type { Metadata } from 'next';
import Link from 'next/link';
import LegalPage, { LegalList, LegalSection, Placeholder } from '@/components/legal/LegalPage';

export const metadata: Metadata = {
  title: 'Privacy Policy · OmniLume',
  description: 'What OmniLume collects, why, who helps run it, how long it is kept, and how to delete it. No ads and no third-party analytics.',
};

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      intro={
        <>
          <p>This page explains what OmniLume collects, why, who helps us run it and how long we keep it.</p>
          <p>OmniLume is run by <Placeholder>legal name of the person or company that runs OmniLume</Placeholder>.</p>
        </>
      }
    >
      <LegalSection title="What we collect">
        <LegalList>
          <li><strong className="text-white">Your email address</strong>, from Google sign-in or from signing up with an email and password. Passwords are handled by our sign-in provider, Supabase Auth. OmniLume&apos;s own code doesn&apos;t store them.</li>
          <li><strong className="text-white">Your profile</strong>: the display name and username you choose, your date of birth, your gender (you can pick &quot;Prefer not to say&quot;), and, if you add them, a profile picture, a bio and a profile colour. Your date of birth and gender are never shown on your public profile.</li>
          <li><strong className="text-white">What you post</strong>: messages, files, notes, whiteboards and anything else you add to rooms, group chats and direct messages.</li>
          <li><strong className="text-white">A key for encrypted messages.</strong> The private half stays in your browser. The public half is saved on your profile so others can send you encrypted messages.</li>
          <li><strong className="text-white">Cookies and browser storage.</strong> Sign-in cookies keep you signed in. An <code>omni_ref</code> cookie (kept for 30 days) holds only a short public tag for the link that brought you here, such as <code>campus-xyz</code>. Your browser also stores settings such as your theme.</li>
        </LegalList>
      </LegalSection>

      <LegalSection title="Why we ask for your date of birth">
        <p>OmniLume is only for people aged 13 and over. We use your date of birth to check that when you set up your profile. We don&apos;t show it to other people or use it for anything else.</p>
      </LegalSection>

      <LegalSection title="What is end-to-end encrypted, and what isn't">
        <p><strong className="text-white">One-to-one direct messages are end-to-end encrypted.</strong> The text is encrypted in your browser before it is sent, and we store only the encrypted version.</p>
        <p><strong className="text-white">Room chat is not end-to-end encrypted.</strong> Neither are room files, notes and whiteboards, group chats, or the short note you send with a message request. These travel over an encrypted connection (HTTPS), but they are stored on our servers in a form we can read.</p>
      </LegalSection>

      <LegalSection title="How long we keep things">
        <LegalList>
          <li><strong className="text-white">Temporary rooms that are deleted at expiry</strong> close when their timer ends. The room and everything in it (chat, files, notes and recordings) is then permanently deleted by our daily clean-up job. It can&apos;t be recovered, not even by us.</li>
          <li><strong className="text-white">Temporary rooms with 7-day recovery</strong> close when their timer ends. For 7 days, members can ask for the room back. If nobody asks, or a request isn&apos;t answered within 7 days, the room and everything in it is permanently deleted at the next daily clean-up.</li>
          <li><strong className="text-white">Permanent rooms</strong> are kept until the owner schedules deletion. Deletion then happens after a grace period of 7 to 14 days, unless the owner cancels it. A room that has been turned into a group chat is not deleted this way.</li>
          <li><strong className="text-white">Room recordings</strong> are deleted 7 days after the recording stops.</li>
          <li><strong className="text-white">Backups and server logs</strong>: <Placeholder>how long database backups and hosting logs are kept on the current Supabase and Vercel plans</Placeholder>.</li>
        </LegalList>
      </LegalSection>

      <LegalSection title="Deleting your account">
        <p>You can delete your account yourself in your profile settings. You type <code>DELETE MY ACCOUNT</code> to confirm, and you must have signed in within the last 10 minutes.</p>
        <p>This deletes your sign-in, your profile, your personal files and the messages you sent. A room you own is handed to another member (an admin first, if there is one). If nobody else is in it, the room is deleted. Files you uploaded to a room are removed from that room&apos;s file list, but the stored copy is only erased when the room itself is deleted.</p>
      </LegalSection>

      <LegalSection title="No ads, no third-party analytics">
        <p>OmniLume shows no ads and does not sell your data. We don&apos;t use third-party analytics or tracking tools.</p>
      </LegalSection>

      <LegalSection title="Our own usage counts">
        <p>To see whether OmniLume works, we count a few things ourselves, such as a room being created, someone joining or a focus timer finishing. We also keep live counts per room, such as how many people are in it and whether its door is open.</p>
        <p>These records hold no user ids, IP addresses, message text or room titles. They hold only the event name, the room&apos;s internal id, the short link tag described above and small numbers such as how many people were there or for how many minutes.</p>
      </LegalSection>

      <LegalSection title="Who helps us run OmniLume">
        <LegalList>
          <li><strong className="text-white">Supabase</strong>: our database, sign-in, live updates and file storage.</li>
          <li><strong className="text-white">Vercel</strong>: hosts the website. Our server code runs in Mumbai, India.</li>
          <li><strong className="text-white">Google</strong>: &quot;Sign in with Google&quot;, if you use it. To set up voice calls, your browser also contacts Google&apos;s public STUN servers, which shows them your IP address.</li>
          <li><strong className="text-white">Cloudflare</strong>: relays voice and screen sharing (TURN) when a direct connection fails. It can also store files (Cloudflare R2) when that option is switched on.</li>
          <li><strong className="text-white">Metered</strong>: a backup relay for voice and screen sharing.</li>
          <li><strong className="text-white">Media services</strong>: when you search for videos, GIFs or music, the words you search for are sent to YouTube, Vimeo, Twitch, the Internet Archive, Giphy or MusicBrainz. Players and images from these services, and from Cover Art Archive, load straight from them in your browser and follow their own privacy policies.</li>
        </LegalList>
        <p><Placeholder>confirm which file storage (Supabase Storage or Cloudflare R2) and which relay (Cloudflare or Metered) are switched on in production, and the Supabase project&apos;s region</Placeholder></p>
      </LegalSection>

      <LegalSection title="Your choices">
        <p>You can change your profile at any time in settings, and you can delete your account as described above. To ask for a copy of your data, a correction or anything else about your privacy, contact us.</p>
      </LegalSection>

      <LegalSection title="Contact">
        <p>Privacy questions and requests: <Placeholder>contact email for privacy requests</Placeholder>.</p>
        <p>For complaints under India&apos;s IT Rules, see the grievance officer on our <Link href="/copyright" className="underline hover:text-white">copyright page</Link>.</p>
      </LegalSection>
    </LegalPage>
  );
}
