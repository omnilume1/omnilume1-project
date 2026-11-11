import type { Metadata } from 'next';
import LegalPage, { LegalList, LegalSection, Placeholder } from '@/components/legal/LegalPage';

export const metadata: Metadata = {
  title: 'Copyright and Grievances · OmniLume',
  description: 'How to report copyright infringement to OmniLume (DMCA), how to send a counter-notice, and how to reach our grievance officer in India.',
};

export default function CopyrightPage() {
  return (
    <LegalPage
      title="Copyright and Grievances"
      intro={<p>Only upload content you own or have the right to share. If you think something on OmniLume infringes your copyright, or you have a complaint under India&apos;s IT Rules, this page explains how to tell us.</p>}
    >
      <LegalSection title="Our designated copyright agent (DMCA)">
        <LegalList>
          <li>Name: <Placeholder>agent name</Placeholder></li>
          <li>Address: <Placeholder>agent postal address</Placeholder></li>
          <li>Email: <Placeholder>agent email</Placeholder></li>
          <li>US Copyright Office registration number: <Placeholder>DMCA designated agent registration number</Placeholder></li>
        </LegalList>
      </LegalSection>

      <LegalSection title="How to send a copyright notice">
        <p>Email our agent with:</p>
        <LegalList>
          <li>your physical or electronic signature (or that of someone allowed to act for the copyright owner);</li>
          <li>the work you say is being infringed;</li>
          <li>the material you want removed, and where it is on OmniLume (a link to the room or file, if you have one);</li>
          <li>your name, address, phone number and email;</li>
          <li>a statement that you believe in good faith that the use isn&apos;t allowed by the copyright owner, its agent or the law;</li>
          <li>a statement that the information in your notice is accurate and, under penalty of perjury, that you are the copyright owner or allowed to act for them.</li>
        </LegalList>
        <p>When we get a valid notice, we remove or disable the material and tell the person who posted it.</p>
      </LegalSection>

      <LegalSection title="Counter-notice">
        <p>If your content was removed and you believe that was a mistake, or that you had the right to post it, email our agent with:</p>
        <LegalList>
          <li>your physical or electronic signature;</li>
          <li>what was removed, and where it was before it was removed;</li>
          <li>a statement, under penalty of perjury, that you believe in good faith it was removed by mistake or misidentification;</li>
          <li>your name, address and phone number;</li>
          <li>a statement that you consent to the jurisdiction of the US federal district court for your address (or, if you are outside the US, any judicial district where we can be found), and that you will accept service of legal papers from the person who sent the original notice.</li>
        </LegalList>
        <p>We send your counter-notice to the person who sent the original notice. Unless they tell us within 10 to 14 business days that they have gone to court, we may put the content back.</p>
      </LegalSection>

      <LegalSection title="Repeat infringers">
        <p>We delete the accounts of people who repeatedly infringe copyright, in appropriate circumstances.</p>
      </LegalSection>

      <LegalSection title="Grievance officer (India)">
        <p>Under India&apos;s Information Technology (Intermediary Guidelines and Digital Media Ethics Code) Rules, 2021, you can raise a complaint about content on OmniLume with our grievance officer:</p>
        <LegalList>
          <li>Name: <Placeholder>grievance officer name</Placeholder></li>
          <li>Email: <Placeholder>grievance officer email</Placeholder></li>
          <li>Address: <Placeholder>grievance officer postal address</Placeholder></li>
        </LegalList>
        <p>What we commit to:</p>
        <LegalList>
          <li>we acknowledge your complaint within 24 hours;</li>
          <li>we resolve it within 15 days;</li>
          <li>we act within 36 hours of an order from a court or an authorised government agency;</li>
          <li>we remove or disable content within 24 hours of a complaint that it shows a person&apos;s intimate images, or a person in a sexual act, shared without their consent, including images that have been faked or altered.</li>
        </LegalList>
      </LegalSection>

      <LegalSection title="What you can upload">
        <p>Only upload files and other content you own or have the right to share. Uploading someone else&apos;s work without permission can get the content removed and your account deleted.</p>
      </LegalSection>
    </LegalPage>
  );
}
