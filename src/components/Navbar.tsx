import Link from "next/link";
import OmniLogo from "@/components/ui/OmniLogo";
import { OmniIcon } from "@/components/ui/OmniIcon";
import type { CurrentAccount } from '@/lib/current-account';

function initials(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return (parts.slice(0, 2).map((part) => part[0]).join('') || 'O').toUpperCase();
}

export function Navbar({ account }: { account: CurrentAccount | null }) {
  const profileHref = account?.profileDetailsCompleted ? '/profile' : '/profile/setup';

  return (
    <header className="public-nav">
      <OmniLogo />
      <div className="public-nav-links" aria-label="Public navigation">
        <Link href="/explore" className="public-nav-link">Explore</Link>
        <Link href="/explore" className="public-nav-link">Rooms</Link>
        <Link href="#about" className="public-nav-link">About</Link>
      </div>
      <div className="public-nav-actions">
        <Link href="/explore" className="icon-button" aria-label="Search rooms" title="Search rooms">
          <OmniIcon name="search" size={17} />
        </Link>
        {account ? <>
          <Link href="/home#notifications" className="icon-button" aria-label="Notifications" title="Notifications">
            <OmniIcon name="bell" size={17} />
            <span className="notification-dot" />
          </Link>
          <Link href={profileHref} className="avatar avatar-small public-account-avatar" aria-label="Open your profile" title="Profile">
            {account.avatarUrl ? <img src={account.avatarUrl} alt="" /> : initials(account.displayName)}
          </Link>
        </> : <Link href="/login" className="public-login">Sign in</Link>}
      </div>
    </header>
  );
}

export function NavLinks() {
  return (
    <div className="public-nav-links" aria-label="Public navigation">
      <Link href="/explore" className="public-nav-link">Rooms</Link>
      <Link href="/explore" className="public-nav-link">Watch</Link>
      <Link href="/explore" className="public-nav-link">Study</Link>
    </div>
  );
}
