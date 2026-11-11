import type { Metadata } from 'next';
import Link from 'next/link';
import LegalPage, { LegalList, LegalSection, Placeholder } from '@/components/legal/LegalPage';

export const metadata: Metadata = {
  title: 'Terms of Use · OmniLume',
  description: 'The plain-English rules for using OmniLume: who can use it, what is not allowed, who owns what you post, and rooms that delete themselves.',
};

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Use"
      intro={<p>By using OmniLume you agree to these terms. They are short, so please read them. OmniLume is run by <Placeholder>legal name of the person or company that runs OmniLume</Placeholder> (&quot;we&quot;).</p>}
    >
      <LegalSection title="Who can use OmniLume">
        <p>You must be at least 13 years old. Give your real date of birth when you set up your profile. Keep your sign-in to yourself: you are responsible for what happens on your account.</p>
      </LegalSection>

      <LegalSection title="What's not allowed">
        <p>Don&apos;t use OmniLume to:</p>
        <LegalList>
          <li>break the law, or help someone else break it;</li>
          <li>harass, bully, threaten or abuse anyone, or post hate speech;</li>
          <li>share sexual content involving anyone under 18, or intimate images of anyone without their consent;</li>
          <li>share someone else&apos;s private information without their permission;</li>
          <li>post content you don&apos;t own or don&apos;t have the right to share (see our <Link href="/copyright" className="underline hover:text-white">copyright page</Link>);</li>
          <li>pretend to be someone else;</li>
          <li>spam people, spread malware, or try to break into accounts, rooms or our systems.</li>
        </LegalList>
      </LegalSection>

      <LegalSection title="Your content">
        <p>You own what you post. To run OmniLume we need your permission to store it, copy it, send it and show it to the people you share it with. You give us that permission, worldwide and free of charge, only for running OmniLume. It ends when your content is deleted.</p>
        <p>Only upload things you own or have the right to share.</p>
      </LegalSection>

      <LegalSection title="Rooms that delete themselves">
        <p>Temporary rooms close when their timer ends and are then permanently deleted, either straight away or after a 7-day recovery window, depending on the room. Everything in the room goes with it. A room that is deleted at expiry can&apos;t be brought back, not even by us. Keep your own copy of anything you want to keep. See our <Link href="/privacy" className="underline hover:text-white">privacy policy</Link> for the details.</p>
      </LegalSection>

      <LegalSection title="Removing content and accounts">
        <p>We can remove content, close rooms, and suspend or delete accounts that break these terms or the law, or that put other people at risk. You can delete your own account at any time in your profile settings.</p>
      </LegalSection>

      <LegalSection title="Other services">
        <p>Videos, music and GIFs you play in a room may come from other services such as YouTube, Vimeo, Twitch or Giphy. Their own terms apply to that content.</p>
      </LegalSection>

      <LegalSection title="No warranty">
        <p>OmniLume is provided &quot;as is&quot;, without any warranty. We don&apos;t promise it will always be available, free of errors or keep your data forever. As far as the law allows, we aren&apos;t liable for any loss that comes from using it.</p>
      </LegalSection>

      <LegalSection title="Changes">
        <p>We may update these terms. When we do, we&apos;ll change the date at the top of this page.</p>
      </LegalSection>

      <LegalSection title="Governing law and contact">
        <p>These terms are governed by <Placeholder>governing law and courts, e.g. the laws of India and the courts of a named city</Placeholder>.</p>
        <p>Questions about these terms: <Placeholder>contact email</Placeholder>.</p>
      </LegalSection>
    </LegalPage>
  );
}
