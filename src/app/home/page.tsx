import Link from 'next/link';
import HomeDashboard from '@/components/home/HomeDashboard';
import { getCurrentAccount } from '@/lib/current-account';

export default async function HomePage() {
  const account = await getCurrentAccount();

  if (!account) {
    return (
      <main className="omni-state-screen">
        <div className="omni-state-card glass-card-ambient">
          <h1 className="text-xl font-semibold text-white">Your session has ended</h1>
          <p className="mt-3 text-sm text-neutral-400">Please sign in again to return to your spaces.</p>
          <Link href="/login?next=%2Fhome" className="omni-button omni-button-primary mt-6">Sign in</Link>
        </div>
      </main>
    );
  }

  return <HomeDashboard account={account} />;
}
