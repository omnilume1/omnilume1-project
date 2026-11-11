import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { comeIn } from '@/actions/join';
import OmniLogo from '@/components/ui/OmniLogo';
import { getLoginPath } from '@/lib/auth';
import { getCurrentAccount } from '@/lib/current-account';
import { DEFAULT_TIME_ZONE, focusLine, joinPath, liveLine, parseDoorNotice, safeTimeZone, type DoorNotice } from '@/lib/join-card';
import { getJoinCard, normalizeJoinToken } from '@/lib/join-card-server';
import { cleanRef } from '@/lib/product-events';
import JoinViewed from './JoinViewed';

type Props = {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// The token is in the URL: never index it, and never send it on as a referrer.
const PRIVATE: Metadata = {
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

const GONE_TITLE = "This door's been changed";
const GONE_COPY = 'This link was changed, used up or has expired. Ask whoever sent it for a new one.';

const NOTICES: Record<DoorNotice, string> = {
  changed: GONE_COPY,
  closed: "You can't come into this room right now.",
  retry: "The door didn't open. Try again.",
};

function first(value: string | string[] | undefined) {
  return typeof value === 'string' ? value : undefined;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const token = normalizeJoinToken((await params).token);
  const read = await getJoinCard(token);

  if (read.state === 'gone') {
    return { ...PRIVATE, title: `${GONE_TITLE} · OmniLume`, description: GONE_COPY };
  }
  if (read.state === 'unknown') {
    const title = "Door's open · OmniLume";
    const description = 'Tap to come in.';
    return { ...PRIVATE, title, description, openGraph: { title, description, siteName: 'OmniLume', type: 'website' } };
  }

  const { card } = read;
  const title = `${card.roomName} · door's open`;
  const description = [liveLine(card), focusLine(card.focusEndsAt, DEFAULT_TIME_ZONE)].filter(Boolean).join(' · ');
  return { ...PRIVATE, title, description, openGraph: { title, description, siteName: 'OmniLume', type: 'website' } };
}

export default async function JoinPage({ params, searchParams }: Props) {
  const [{ token: rawToken }, query] = await Promise.all([params, searchParams]);
  const token = normalizeJoinToken(rawToken);
  const ref = cleanRef(first(query.ref));
  const notice = parseDoorNotice(first(query.door));

  const [read, account, requestHeaders] = await Promise.all([getJoinCard(token), getCurrentAccount(), headers()]);

  if (!token || read.state === 'gone' || notice === 'changed') {
    return (
      <main className="omni-state-screen">
        <section className="omni-state-card glass-card-ambient" aria-labelledby="join-title">
          <OmniLogo />
          <h1 id="join-title" className="mt-8 text-xl font-semibold text-white">{GONE_TITLE}</h1>
          <p className="mt-3 text-sm text-neutral-400">{GONE_COPY}</p>
          <Link href="/" className="omni-button omni-button-ghost mt-6">Go to OmniLume</Link>
        </section>
      </main>
    );
  }

  const card = read.state === 'open' ? read.card : null;
  const timeZone = safeTimeZone(requestHeaders.get('x-vercel-ip-timezone'));
  const focus = card ? focusLine(card.focusEndsAt, timeZone) : null;
  const door = joinPath(token, ref);

  return (
    <main className="omni-state-screen">
      <section className="omni-state-card glass-card-ambient" aria-labelledby="join-title">
        <OmniLogo />
        {card && <p className="section-kicker mt-8">{card.roomName}</p>}
        <h1 id="join-title" className={`${card ? '' : 'mt-8 '}text-2xl font-semibold text-white`}>Door&apos;s open</h1>
        {card && <p className="mt-3 text-sm text-neutral-300">{liveLine(card)}</p>}
        {focus && <p className="mt-1 text-sm text-neutral-400">{focus}</p>}
        {notice && <p className="form-error mt-5" role="alert">{NOTICES[notice]}</p>}
        {account ? (
          <form action={comeIn} className="mt-6">
            <input type="hidden" name="token" value={token} />
            {ref && <input type="hidden" name="ref" value={ref} />}
            <button type="submit" className="omni-button omni-button-primary w-full">Come in</button>
          </form>
        ) : (
          <Link href={getLoginPath(door)} prefetch={false} className="omni-button omni-button-primary mt-6 w-full">Sign in to come in</Link>
        )}
      </section>
      <JoinViewed token={token} refTag={ref} />
    </main>
  );
}
