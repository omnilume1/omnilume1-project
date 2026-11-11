import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { Suspense, type CSSProperties, type ReactNode } from 'react';
import { OmniIcon, type OmniIconName } from '@/components/ui/OmniIcon';
import { OmniMark } from '@/components/ui/OmniMarkSprite';
import OmniIntro from '@/components/ui/OmniIntro';
import LandingAccount from '@/components/landing/LandingAccount';
import { ACCOUNT_HINT_SCRIPT } from '@/lib/session-hint';
import HeroDesk, { AlbumArt } from '@/components/landing/HeroDesk';
import FeatureCards from '@/components/landing/FeatureCards';
import WhatElse from '@/components/landing/WhatElse';
import SketchPad from '@/components/landing/SketchPad';
import LandingMotion from '@/components/landing/LandingMotion';
import Stripes from '@/components/landing/Stripes';
import styles from './landing.module.css';

// Plays the drawn-mark intro once per tab session; runs before first paint.
// It also tags /?v=b (the second headline) without reading searchParams, so the page stays static.
const INTRO_ONCE = "try{if(/[?&]v=b(?:&|$)/.test(location.search))document.documentElement.dataset.lp='b';if(sessionStorage.getItem('ol-intro'))document.documentElement.dataset.introSeen='';else sessionStorage.setItem('ol-intro','1')}catch(e){}";

const d = (seconds: number) => ({ ['--d' as string]: `${seconds}s` }) as CSSProperties;

function Card({ icon, name, desc, tint, glow, children, visAlign }: { icon: OmniIconName; name: string; desc: string; tint: string; glow: string; children: ReactNode; visAlign?: 'start' }) {
  return (
    <article className={`${styles.fcard} glow`} data-card style={{ ['--tint' as string]: tint, ['--glow' as string]: glow }}>
      <div className={styles.fhead}><span className={styles.ftile}><OmniIcon name={icon} size={20} /></span><span className={styles.fname}>{name}</span><span className={styles.fgo} aria-hidden="true"><OmniIcon name="chevronRight" size={16} /></span></div>
      <p className={styles.fdesc}>{desc}</p>
      <div className={styles.fsep} />
      <div className={`${styles.fvis} ${visAlign === 'start' ? styles.fvisStart : ''}`} aria-hidden="true">{children}</div>
    </article>
  );
}

const THUMBS = [
  { src: '/landing/study.jpg', label: 'Start a focus session' },
  { src: '/landing/room.jpg', label: 'Talk with the room' },
  { src: '/landing/home.jpg', label: 'Your home, rooms and friends' },
  { src: '/landing/music.jpg', label: 'OmniLume Music' },
  { src: '/landing/explore.jpg', label: 'Find your next room' },
];

export const metadata: Metadata = { title: 'OmniLume · Your hostel room, wherever everyone is', description: 'A room your friend group keeps open. Study, watch, play music or just talk, all in one place. One link in your WhatsApp group, nothing to install.' };

// Static: no per-request work, so the CDN serves it. Member links go to app pages, where the proxy
// sends anyone without a finished profile to setup and anyone signed out to sign in.
export default function Home() {
  return (
    <div className={styles.page} data-landing>
      <script dangerouslySetInnerHTML={{ __html: INTRO_ONCE + ACCOUNT_HINT_SCRIPT }} />
      <div className={styles.intro} aria-hidden="true"><OmniIntro /></div>
      <LandingMotion />

      <Stripes count={14} seed={7} className={styles.stripesTop} />

      <div className={styles.wrap}>
        <header className={styles.nav}>
          <Link href="/" className={styles.logo} aria-label="OmniLume home"><OmniMark size={28} />OmniLume</Link>
          <nav className={styles.navLinks} aria-label="Site">
            <Link href="/explore">Explore</Link>
            <a href="#how">How it works</a>
          </nav>
          <div className={styles.navRight}>
            <Link href="/login" className={`${styles.navLink} ${styles.guestOnly}`}>Sign in</Link>
            <LandingAccount />
            <Link href="/login" className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSm} ${styles.guestOnly}`}>Get started</Link>
            <Link href="/home" className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSm} ${styles.memberOnly}`}>Go to your space</Link>
          </div>
        </header>

        <main>
          <div className={styles.heroHead}>
            <h1 className={styles.h1}><span className={styles.hA}>Your hostel room, wherever everyone is.</span><span className={styles.hB}>Hang out like you&apos;re in the same room.</span></h1>
            <div>
              <p className={styles.lede}>OmniLume is a room your friend group keeps open. Study, watch, play music or just talk, all in one place. One link in your WhatsApp group, nothing to install.</p>
              <div className={styles.actions}>
                <Link href="/login?next=/create-room" className={`${styles.btn} ${styles.btnPrimary} ${styles.guestOnly}`}>Open your room <OmniIcon name="arrow" size={16} /></Link>
                <Link href="/home" className={`${styles.btn} ${styles.btnPrimary} ${styles.memberOnly}`}>Go to your space <OmniIcon name="arrow" size={16} /></Link>
                <a href="#how" className={`${styles.btn} ${styles.btnSecondary}`}>How it works</a>
              </div>
              <p className={styles.assure}>Pin one link in your WhatsApp group. That&apos;s your room.</p>
              <p className={styles.assure}>Free · in your browser · one link for the whole group</p>
            </div>
          </div>

          <div className={styles.deskWrap}>
            {/* Each Suspense boundary hydrates as its own task, so no single long task blocks input. */}
            <Suspense><HeroDesk /></Suspense>
            <div className={`${styles.caption} mono`}><span>Live preview. Drag a window, or pick another page</span><span>Real OmniLume screens</span></div>
          </div>

          <section id="how" className={styles.how} aria-labelledby="how-title" data-reveal>
            <h2 id="how-title" className={styles.say}>How it works<span>One link in your WhatsApp group. No app, no bots, no call cut-off, no ads. Rooms can self-destruct.</span></h2>
            <ol className={styles.steps}>
              <li><span className={`${styles.stepNo} mono`}>1</span><h3>Create a room</h3><p>Name it, pick how long it lasts and choose who can join.</p></li>
              <li><span className={`${styles.stepNo} mono`}>2</span><h3>Share the link</h3><p>Friends tap the link and they&apos;re in.</p></li>
              <li><span className={`${styles.stepNo} mono`}>3</span><h3>Start together</h3><p>Run the focus timer, play a video or queue a song. Everyone stays in sync.</p></li>
            </ol>
          </section>
        </main>
      </div>

      {/* 1. Every feature gets its own card */}
      <Suspense>
      <section id="cards" className={`${styles.wrap} ${styles.cards}`} aria-label="Features">
        <FeatureCards heading={<h2 className={styles.say}>There is a room for that.<span>Every tool your group needs, already inside the room.</span></h2>}>
          <Card icon="timer" name="Focus timer" desc="Run one Pomodoro timer for the whole room, so breaks start together." tint="#2a2160" glow="rgba(124,92,255,.32)">
            <div className={styles.vstack}><span className={`${styles.bigTime} mono`} data-clock="1498">24:58</span><div className={styles.circles}><span className={`${styles.circ} ${styles.c1}`} /><span className={`${styles.circ} ${styles.c2}`} /><span className={`${styles.circ} ${styles.c3}`} /><span className={`${styles.circ} ${styles.c4}`}><OmniIcon name="check" size={16} /></span></div><span className={styles.vsmall}>Round 2 of 4 · break at 9:46 pm</span></div>
          </Card>
          <Card icon="notes" name="Shared notes" desc="Write notes together while the session runs. They stay with the room." tint="#16244f" glow="rgba(70,120,255,.3)">
            <div className={styles.flow}><span>Torque  τ = Iα   Angular momentum</span><span>Solid disc  I = ½MR²   Thin ring</span><span>Rolling  v = ωR   Kinetic energy</span><span>Chapter 7 quiz on Friday   Past paper</span><span>Moment of inertia   Parallel axis</span><span>Ask Riya about Q6   Flashcards</span><span>Work–energy theorem   Power</span></div>
          </Card>
          <Card icon="pen" name="Whiteboard" desc="Sketch ideas together on one canvas that everyone can draw on." tint="#2c2016" glow="rgba(255,170,80,.22)">
            <svg width="290" height="250" viewBox="0 0 290 250" fill="none" strokeLinecap="round" strokeLinejoin="round">
              <g fill="rgba(255,255,255,.12)"><circle cx="20" cy="20" r="1.5" /><circle cx="60" cy="20" r="1.5" /><circle cx="100" cy="20" r="1.5" /><circle cx="140" cy="20" r="1.5" /><circle cx="180" cy="20" r="1.5" /><circle cx="220" cy="20" r="1.5" /><circle cx="260" cy="20" r="1.5" /><circle cx="20" cy="230" r="1.5" /><circle cx="140" cy="230" r="1.5" /><circle cx="260" cy="230" r="1.5" /></g>
              <circle cx="92" cy="110" r="52" stroke="#ffd08a" strokeWidth="3" /><path d="M92 110 L140 86" stroke="#ffd08a" strokeWidth="3" /><path d="M40 110 C 60 170 140 180 160 140" stroke="#fff" strokeOpacity=".75" strokeWidth="2.5" strokeDasharray="1 7" />
              <path d="M168 70 C 200 50 240 60 250 96 C 258 128 226 150 196 150" stroke="#b9a8ff" strokeWidth="3" /><path d="M196 150 l10 -9 m-10 9 l12 5" stroke="#b9a8ff" strokeWidth="3" />
              <text x="176" y="188" fill="#fff" fillOpacity=".8" fontFamily="inherit" fontSize="15">ω = v / R</text>
              <g transform="translate(150 84)"><path d="M0 0 L0 15 L4 11 L7 18 L9 17 L6 10 L12 10 Z" fill="#ff8fb3" /><rect x="12" y="14" width="40" height="18" rx="5" fill="#ff8fb3" /><text x="18" y="27" fill="#17141f" fontFamily="inherit" fontSize="11">Riya</text></g>
              <g className={styles.wbDev}><path d="M0 0 L0 15 L4 11 L7 18 L9 17 L6 10 L12 10 Z" fill="#6fe3e8" /><rect x="12" y="14" width="36" height="18" rx="5" fill="#6fe3e8" /><text x="18" y="27" fill="#17141f" fontFamily="inherit" fontSize="11">Dev</text></g>
            </svg>
          </Card>
          <Card icon="file" name="PDFs and files" desc="Drop in PDFs, media and files, and read them side by side in the room." tint="#2b1624" glow="rgba(255,110,150,.24)">
            <div className={styles.paper} style={{ transform: 'translate(-40px,-6px) rotate(-7deg)', opacity: 0.75 }}><i /><i /><i className={styles.s} /><i /><i /><i className={styles.s} /></div>
            <div className={styles.paper} style={{ transform: 'translate(30px,10px) rotate(4deg)' }}><i style={{ height: 10, width: '70%', background: '#9b8fb8' }} /><i /><i className={styles.hl} /><i className={`${styles.hl} ${styles.s}`} /><i /><i /><i className={styles.s} /><i /><i className={styles.s} /></div>
          </Card>
          <Card icon="tv" name="Watch together" desc="Play, pause and seek reach everyone in the room at the same moment." tint="#2c1a1c" glow="rgba(255,130,90,.26)">
            <div style={{ width: '100%' }}>
              <div className={styles.film}><svg viewBox="0 0 536 301"><defs><linearGradient id="lp-fs" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#2d2a5a" /><stop offset=".55" stopColor="#c77b6a" /><stop offset=".72" stopColor="#f1b77e" /></linearGradient></defs><rect width="536" height="301" fill="url(#lp-fs)" /><circle cx="330" cy="196" r="34" fill="#ffe2b0" /><rect y="196" width="536" height="105" fill="#2a2446" /><path d="M120 200 L190 200 L176 210 L130 210 Z" fill="#120f1f" /><path d="M152 200 L152 150 L178 196 Z" fill="#120f1f" /></svg></div>
              <div className={styles.miniBar}><OmniIcon name="pause" size={16} /><span className="mono">42:18</span><span className={styles.track}><b style={{ width: '39%' }} /></span><span>In sync · 7</span></div>
            </div>
          </Card>
          <Card icon="music" name="Listen together" desc="Hear the same song at the same second as your friends." tint="#10301d" glow="rgba(60,200,120,.34)">
            <div className={styles.vstack} style={{ gap: 0 }}><div className={styles.artLg}><AlbumArt /></div><div className={styles.spControls}><OmniIcon name="prev" size={22} /><span className={styles.spPlay}><OmniIcon name="play" size={18} /></span><OmniIcon name="next" size={22} /></div></div>
          </Card>
          <Card icon="upload" name="Your uploads" desc="Upload music, build playlists and keep your listening history." tint="#221838" glow="rgba(160,120,255,.3)" visAlign="start">
            <div className={styles.tracks}>
              {[['Slow Tide', '3:28', '#e09a7b,#2a3d6b'], ['Paper Lanterns', '4:02', '#7bc8e0,#3a2b55'], ['Night Bus', '2:51', '#c9a6ff,#1c1630'], ['Window Seat', '3:44', '#9be0a8,#2a3d6b'], ['Late Library', '5:10', '#ffd08a,#3a2b55']].map(([title, time, colors], index) => (
                <div key={title} className={styles.trk} style={index === 4 ? { opacity: 0.5 } : undefined}><span className={styles.sq} style={{ background: `linear-gradient(135deg,${colors})` }} />{title}<span className="mono">{time}</span></div>
              ))}
            </div>
          </Card>
          <Card icon="mic" name="Voice" desc="Talk while you watch or study, right inside the room." tint="#132a2e" glow="rgba(80,200,220,.24)">
            <div className={styles.voice}>
              <div className={styles.speaking}><span className={styles.av}>AK</span><span className={styles.levels}><b /><b /><b /><b /><b /></span>Aarav</div>
              <div><span className={styles.av}>MR</span><span className={`${styles.levels} ${styles.quiet}`}><b /><b /><b /></span>Mei</div>
              <div className={styles.speaking}><span className={styles.av}>RS</span><span className={styles.levels}><b /><b /><b /><b /><b /></span>Riya</div>
            </div>
          </Card>
          <Card icon="lock" name="Private messages" desc="End-to-end encrypted chats that only you and your friend can read." tint="#1b1a46" glow="rgba(110,100,255,.32)">
            <div className={styles.bubbles}><span className={styles.e2e}><OmniIcon name="lock" size={12} />Encrypted on your device</span><div className={`${styles.bubble} ${styles.them}`}>Are you in the study room tonight</div><div className={`${styles.bubble} ${styles.me}`}>Yes, 9 pm. Bring the past paper</div><div className={`${styles.bubble} ${styles.them}`}>Saving you a seat</div></div>
          </Card>
          <Card icon="users" name="Friends" desc="See who is around and what they are listening to, then join them." tint="#2a1530" glow="rgba(255,90,200,.24)">
            <div className={styles.friends}>
              <div className={styles.fr}><span className={styles.av}>AG</span><div>Aditya Gupta<small>Listening to Slow Tide</small></div><span className={styles.on} /></div>
              <div className={styles.fr}><span className={styles.av}>LR</span><div>Lakshya Rawat<small>In Physics revision</small></div><span className={styles.on} /></div>
              <div className={styles.fr} style={{ opacity: 0.6 }}><span className={styles.av}>U1</span><div>user1<small>Last seen 2 h ago</small></div></div>
            </div>
          </Card>
          <Card icon="lock" name="Private by default" desc="No ads, no third-party tracking, encrypted DMs, rooms that self-destruct." tint="#1b1a46" glow="rgba(110,100,255,.32)">
            <div className={styles.bubbles}><span className={styles.e2e}><OmniIcon name="lock" size={12} />Encrypted on your device</span></div>
          </Card>
        </FeatureCards>
      </section>
      </Suspense>

      {/* 3. What else can OmniLume do */}
      <Suspense>
      <section id="more" className={`${styles.wrap} ${styles.more}`} aria-label="What else OmniLume does">
        <WhatElse>
          <div data-reveal>
            <p className={styles.sayBig}><b>What else can OmniLume do?</b><br />
              <span role="button" tabIndex={0} className={`${styles.s} ${styles.pick} ${styles.s0}`} data-state-to="0">It runs a focus timer.</span>{' '}
              <span className={styles.s}>Syncs a film for everyone.</span>{' '}
              <span role="button" tabIndex={0} className={`${styles.s} ${styles.pick} ${styles.s1}`} data-state-to="1">Shares a whiteboard.</span>{' '}
              <span className={styles.s}>Plays the same song for the room.</span>{' '}
              <span className={styles.s}>Keeps private chats encrypted.</span>{' '}
              <span role="button" tabIndex={0} className={`${styles.s} ${styles.pick} ${styles.s2}`} data-state-to="2">Holds your notes and PDFs.</span>{' '}
              <span className={styles.s}>Opens a voice channel.</span>{' '}
              <span className={styles.s}>Shows what friends are listening to.</span>{' '}
              <span className={styles.s}>And much more.</span>
            </p>
            <span className={`${styles.pill} glass`} aria-live="polite">
              <span className={styles.v0}><OmniIcon name="timer" size={16} />Focus timer</span>
              <span className={styles.v1}><OmniIcon name="pen" size={16} />Whiteboard</span>
              <span className={styles.v2}><OmniIcon name="notes" size={16} />Shared notes</span>
            </span>
            <p className={styles.pillCap}>
              <span className={styles.v0}>One timer for the whole room, so breaks start together.</span>
              <span className={styles.v1}>One canvas for everyone in the room, drawn on live.</span>
              <span className={styles.v2}>Notes the whole room edits together.</span>
              {' '}<a href="#cards">Learn more</a>
            </p>
            <p className={styles.pillCap}>AI? Not yet. When it comes it&apos;s off by default, never reads your DMs, and the room shows when it&apos;s on.</p>
          </div>
          <div className={styles.stage2} data-reveal style={d(0.2)} aria-hidden="true">
            <div className={styles.corner}><Stripes count={8} seed={3} scale={0.5} className={styles.stripesCorner} /></div>
            <div className={styles.nw}>
              <div className={styles.nwTitle}><span className={styles.v0}>Focus timer</span><span className={styles.v1}>Whiteboard</span><span className={styles.v2}>Shared notes</span></div>
              <div className={`${styles.nwV} ${styles.v0}`}><h4>Physics revision</h4><p>Round 2 of 4. Break starts for everyone at 9:46 pm.</p><hr /><div className={`${styles.nwTimer} mono`} data-clock="1122">18:42</div><div className={styles.track} style={{ marginTop: 20 }}><b style={{ width: '62%', background: '#8f7be8' }} /></div><div className={styles.tl} style={{ marginTop: 18 }}><span className={styles.av}>RS</span><span className={styles.av} style={{ marginLeft: -8 }}>DV</span><span className={styles.av} style={{ marginLeft: -8 }}>NP</span>4 studying</div></div>
              <div className={`${styles.nwV} ${styles.v1}`}><h4>Whiteboard</h4><p>Riya and Dev are drawing.</p><hr /><div className={styles.board}><svg width="384" height="230" viewBox="0 0 384 230" fill="none" strokeLinecap="round"><circle cx="110" cy="110" r="70" stroke="#ffd08a" strokeWidth="3" /><path d="M110 110 L172 78" stroke="#ffd08a" strokeWidth="3" /><path d="M220 60 C 270 40 330 60 340 110 C 350 150 300 180 260 176" stroke="#b9a8ff" strokeWidth="3" /><text x="230" y="214" fill="#fff" fillOpacity=".8" fontFamily="inherit" fontSize="16">ω = v / R</text></svg><SketchPad /></div></div>
              <div className={`${styles.nwV} ${styles.v2}`}><h4>Shared notes</h4><p>Go through <span className={styles.link}>chapter 7</span> before the quiz on Friday and add anything unclear to the board.</p></div>
            </div>
          </div>
        </WhatElse>
      </section>
      </Suspense>

      {/* 4. Community + core features reel */}
      <Suspense>
      <section id="loop" className={`${styles.wrap} ${styles.loop}`} aria-label="Community">
        <h2 className={`${styles.say} ${styles.center}`} data-reveal>Find your people.<span>Join a public room or start your own, then invite your friends.</span></h2>
        <div className={styles.loopCards} data-reveal style={d(0.2)}>
          <Link href="/explore" className={`${styles.lc} glass glow`}><div className={styles.lcH}><OmniIcon name="globe" size={20} />Explore rooms<small className="mono">public · invite · code</small></div><p>Search public rooms by name or topic, or join with an invite link from a friend.</p><b>Explore →</b></Link>
          <Link href="/create-room" className={`${styles.lc} glass glow`}><div className={styles.lcH}><OmniIcon name="plus" size={20} />Create a room<small className="mono">permanent or temporary</small></div><p>Pick a lifespan, choose who can join and share the link. You are the host.</p><b>Create →</b></Link>
        </div>
        <div className={styles.thumbsWrap} data-reveal style={d(0.45)}>
          <div className={styles.thumbs} data-anim>
            {[...THUMBS, ...THUMBS].map((thumb, index) => (
              <div key={index} className={styles.th} aria-hidden={index >= THUMBS.length}>
                <div className={styles.im}><Image src={thumb.src} alt={index < THUMBS.length ? thumb.label : ''} width={260} height={162} sizes="260px" /></div>
                <p>{thumb.label}</p>
              </div>
            ))}
          </div>
        </div>
        <p className={styles.loopFoot} data-reveal style={d(0.6)}>Real screens from OmniLume. Everything here works today.</p>
      </section>
      </Suspense>

      <Suspense>
      <div className={styles.footArea}>
        <Stripes count={14} seed={19} className={styles.stripesBottom} />
        <footer className={styles.footer}>
          <div className={styles.wrap}>
            <div className={styles.foot} data-reveal>
              <div><h3>Product</h3><Link href="/explore">Rooms</Link><Link href="/explore">Explore</Link><Link href="/music">Music</Link><Link href="/messages">Messages</Link></div>
              <div><h3>Core features</h3><Link href="/watch-together">Watch together</Link><Link href="/study-together">Study together</Link><a href="#cards">Whiteboard</a><Link href="/listen-together">Listen together</Link><a href="#cards">Voice</a></div>
              <div><h3>Account</h3><Link href="/login">Sign in</Link><Link href="/login">Create account</Link><Link href="/forgot-password">Forgot password</Link></div>
              <div><h3>OmniLume</h3><a href="#more">About</a><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link><Link href="/copyright">Copyright</Link></div>
            </div>
            <div className={styles.footBottom} data-reveal style={d(0.2)}><span className={styles.logo}><OmniMark size={44} />OmniLume</span><span>© {new Date().getFullYear()} OmniLume</span></div>
          </div>
        </footer>
      </div>
      </Suspense>
    </div>
  );
}
