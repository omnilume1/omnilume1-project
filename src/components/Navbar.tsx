import Link from "next/link";
import OmniLogo from "@/components/ui/OmniLogo";
import { OmniIcon } from "@/components/ui/OmniIcon";

export function Navbar() {
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
        <Link href="/login" className="icon-button" aria-label="Notifications" title="Sign in to view notifications">
          <OmniIcon name="bell" size={17} />
        </Link>
        <Link href="/login" className="avatar avatar-small" aria-label="Sign in to view your profile">OL</Link>
        <Link href="/login" className="public-login">Sign in</Link>
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
