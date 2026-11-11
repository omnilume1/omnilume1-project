import { ImageResponse } from 'next/og';
import { DEFAULT_TIME_ZONE, focusLine, liveLine } from '@/lib/join-card';
import { getJoinCard, normalizeJoinToken } from '@/lib/join-card-server';

// The link preview's image. Reads the card with p_log=false (no join_viewed)
// and is cached for a minute, so a busy group chat costs one read a minute.
export const alt = 'An OmniLume room invite';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const revalidate = 60;

// Brand tokens (globals.css :root). Satori can't read CSS variables.
const BG = '#0e0b14';
const BG_DEEP = '#0a0810';
const RAISED = '#17131f';
const TEXT = '#f3f0fa';
const MUTED = '#a39cb8';
const ACCENT = '#b9a8ff';
const PURPLE = '#8b6cff';
const OK = '#6fcf9a';

// The OmniLume mark (OmniMarkSprite), standalone.
const MARK = `data:image/svg+xml;base64,${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs>'
  + '<linearGradient id="t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1d1729"/><stop offset="1" stop-color="#0b0911"/></linearGradient>'
  + '<linearGradient id="r" gradientUnits="userSpaceOnUse" x1="16" y1="48" x2="48" y2="16"><stop offset="0" stop-color="#4b31d4"/><stop offset=".55" stop-color="#8f78ff"/><stop offset="1" stop-color="#e8e1ff"/></linearGradient>'
  + '<radialGradient id="c"><stop offset="0" stop-color="#b9a8ff" stop-opacity=".32"/><stop offset="1" stop-color="#b9a8ff" stop-opacity="0"/></radialGradient>'
  + '<radialGradient id="g"><stop offset="0" stop-color="#ece6ff" stop-opacity=".95"/><stop offset=".45" stop-color="#b9a8ff" stop-opacity=".45"/><stop offset="1" stop-color="#b9a8ff" stop-opacity="0"/></radialGradient>'
  + '</defs><rect x="1" y="1" width="62" height="62" rx="18" fill="url(#t)" stroke="rgba(255,255,255,.14)" stroke-width="1.5"/>'
  + '<circle cx="32" cy="32" r="13" fill="url(#c)"/><path d="M48.59 28.29 A17 17 0 1 1 35.71 15.41" fill="none" stroke="url(#r)" stroke-width="5" stroke-linecap="round"/>'
  + '<circle cx="44.02" cy="19.98" r="8" fill="url(#g)"/><circle cx="44.02" cy="19.98" r="3.6" fill="#fff"/></svg>',
).toString('base64')}`;

function clip(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export default async function Image({ params }: { params: Promise<{ token: string }> }) {
  const read = await getJoinCard(normalizeJoinToken((await params).token));
  const card = read.state === 'open' ? read.card : null;
  const gone = read.state === 'gone';

  const kicker = gone ? 'This link has expired' : "Door's open";
  const heading = card ? clip(card.roomName, 40) : gone ? "This door's been changed" : 'Come on in';
  const line = card ? liveLine(card) : gone ? 'Ask whoever sent it for a new one.' : 'Tap the link to come in.';
  const focus = card ? focusLine(card.focusEndsAt, DEFAULT_TIME_ZONE) : null;
  const lit = Boolean(card && card.people > 0);

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '72px 80px',
          background: `linear-gradient(160deg, ${RAISED} 0%, ${BG} 55%, ${BG_DEEP} 100%)`,
          color: TEXT,
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={MARK} width={64} height={64} alt="" />
          <div style={{ fontSize: 34, fontWeight: 600, letterSpacing: -0.5 }}>OmniLume</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 30, color: gone ? MUTED : ACCENT }}>
            <div style={{ width: 14, height: 14, borderRadius: 7, background: gone ? MUTED : lit ? OK : PURPLE }} />
            {kicker}
          </div>
          <div style={{ marginTop: 18, fontSize: 76, fontWeight: 700, lineHeight: 1.05, letterSpacing: -2 }}>{heading}</div>
          <div style={{ marginTop: 26, fontSize: 34, color: MUTED }}>{clip(line, 70)}</div>
          {focus && <div style={{ marginTop: 10, fontSize: 30, color: ACCENT }}>{focus}</div>}
        </div>
      </div>
    ),
    { ...size },
  );
}
