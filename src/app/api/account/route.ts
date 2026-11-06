import { NextResponse } from 'next/server';
import { getCurrentAccount } from '@/lib/current-account';

// The landing is static, so its nav asks here who is signed in: just the name and avatar it shows.
export async function GET() {
  const account = await getCurrentAccount();
  return NextResponse.json(account && { displayName: account.displayName, avatarUrl: account.avatarUrl }, {
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
