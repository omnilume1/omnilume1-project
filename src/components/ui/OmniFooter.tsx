import Link from 'next/link';
import OmniLogo from '@/components/ui/OmniLogo';

interface FooterLink {
  label: string;
  href?: string;
}

const columns: Array<{ title: string; links: FooterLink[] }> = [
  {
    title: 'Pages',
    links: [
      { label: 'Home', href: '/' },
      { label: 'Explore', href: '/explore' },
      { label: 'Rooms', href: '/room' },
      { label: 'Create a room', href: '/create-room' },
    ],
  },
  {
    title: 'Socials',
    links: [{ label: 'Community links are coming soon.' }],
  },
  {
    title: 'Legal',
    links: [{ label: 'Privacy and terms are being prepared.' }],
  },
  {
    title: 'Register',
    links: [
      { label: 'Sign in', href: '/login' },
      { label: 'Create account', href: '/login' },
      { label: 'Forgot password', href: '/forgot-password' },
      { label: 'Profile setup', href: '/profile/setup' },
    ],
  },
];

export default function OmniFooter() {
  return (
    <footer className="omni-footer">
      <div className="omni-footer-grid">
        <div className="omni-footer-brand">
          <OmniLogo />
          <p className="omni-footer-statement">A brighter way to study, connect and grow together.</p>
          <p className="omni-footer-copy">© {new Date().getFullYear()} OmniLume. All rights reserved.</p>
        </div>

        <div className="omni-footer-columns">
          {columns.map((column) => (
            <div key={column.title} className="omni-footer-column">
              <h2>{column.title}</h2>
              {column.links.map((link) => link.href ? (
                <Link key={`${column.title}-${link.label}`} href={link.href} className="omni-footer-link">{link.label}</Link>
              ) : <p key={`${column.title}-${link.label}`} className="omni-footer-note">{link.label}</p>)}
            </div>
          ))}
        </div>
      </div>
      <div className="omni-footer-bottom">
        <span>Study · Connect · Create · Together</span>
        <span>A brighter you · A brighter tomorrow</span>
      </div>
      <span className="omni-footer-watermark" aria-hidden="true">OmniLume</span>
    </footer>
  );
}
