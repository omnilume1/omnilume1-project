import Link from 'next/link';
import OmniLogo from '@/components/ui/OmniLogo';

const columns = [
  {
    title: 'Explore',
    links: [
      { label: 'Home', href: '/' },
      { label: 'Explore rooms', href: '/explore' },
      { label: 'Messages', href: '/messages' },
      { label: 'Features', href: '#about' },
    ],
  },
  {
    title: 'Account',
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
              {column.links.map((link) => (
                <Link key={`${column.title}-${link.label}`} href={link.href} className="omni-footer-link">
                  {link.label}
                </Link>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="omni-footer-bottom">
        <span>Study · Connect · Create · Together</span>
        <span>Built for focus, connection and shared momentum.</span>
      </div>
    </footer>
  );
}
