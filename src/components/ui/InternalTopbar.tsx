import type { ReactNode } from 'react';
import Link from 'next/link';
import OmniLogo from '@/components/ui/OmniLogo';
import { OmniIcon } from '@/components/ui/OmniIcon';

export default function InternalTopbar({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="internal-topbar">
      <div className="internal-topbar-left">
        <OmniLogo />
        <span className="topbar-divider" />
        <div>
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h1>{title}</h1>
          {description && <p className="topbar-description">{description}</p>}
        </div>
      </div>
      <div className="internal-topbar-actions">
        {actions}
        <Link href="/home#notifications" className="icon-button" aria-label="Notifications" title="Notifications">
          <OmniIcon name="bell" />
          <span className="notification-dot" />
        </Link>
        <Link href="/profile" className="avatar avatar-small" aria-label="Profile">OL</Link>
      </div>
    </header>
  );
}
