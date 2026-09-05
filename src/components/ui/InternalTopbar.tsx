'use client';

import type { ReactNode } from 'react';
import OmniLogo from '@/components/ui/OmniLogo';
import CurrentAccountControls, { type AccountView } from '@/components/ui/CurrentAccountControls';

export default function InternalTopbar({
  eyebrow,
  title,
  description,
  actions,
  account,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  account?: AccountView;
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
        <CurrentAccountControls account={account} />
      </div>
    </header>
  );
}
