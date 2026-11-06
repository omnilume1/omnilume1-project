const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const clamp = (v) => Math.max(0, Math.min(1, v));
const smooth = (p) => p * p * p * (p * (p * 6 - 15) + 10);
const outQ = (p) => 1 - Math.pow(1 - p, 4);
const outQuint = (p) => 1 - Math.pow(1 - p, 5);
const spring = (p) => (p <= 0 ? 0 : p >= 1 ? 1 : 1 - Math.exp(-6.5 * p) * Math.cos(8.5 * p));
const seg = (t, a, b) => smooth(clamp((t - a) / (b - a)));
const segO = (t, a, b) => outQuint(clamp((t - a) / (b - a)));
const lerp = (a, b, p) => a + (b - a) * p;
const center = (el, dx, dy) => { const r = el.getBoundingClientRect(); return [dx == null ? r.left + r.width / 2 : r.left + dx, dy == null ? r.top + r.height / 2 : r.top + dy]; };
const g = (sel, dx, dy) => () => center($(sel), dx, dy);
const stepAt = (list, t) => { let cur = list[0][1], prev = cur, at = -1; for (const [st, v] of list) if (t >= st) { prev = cur; cur = v; at = st; } return { cur, prev, at }; };

// Light stripes: diagonal bars whose lit segment drifts along the bar.
const palette = ['#5b3df5', '#8b6cff', '#b9a8ff', '#3a2399', '#c084fc', '#7c5cff'];
function buildStripes(id, n, seed, scale = 1) {
  const rot = document.querySelector(`#${id} .rot`); const bars = [];
  let r = seed; const rnd = () => (r = (r * 9301 + 49297) % 233280) / 233280;
  for (let i = 0; i < n; i++) {
    const el = document.createElement('div'); el.className = 'bar';
    const h = (30 + rnd() * 120) * scale, c1 = palette[Math.floor(rnd() * palette.length)], c2 = palette[Math.floor(rnd() * palette.length)];
    el.style.height = h + 'px'; el.style.top = (1300 - 700 * scale + rnd() * 1400 * scale) + 'px';
    el.style.background = `linear-gradient(90deg, transparent 18%, ${c1} 38%, ${c2} 52%, transparent 70%)`;
    el.style.filter = `blur(${(6 + rnd() * 18) * scale}px)`;
    rot.appendChild(el);
    bars.push({ el, o: .35 + rnd() * .5, s: .25 + rnd() * .35, p: rnd() * 6.28, x: (rnd() - .5) * 700 * scale });
  }
  return bars;
}
const SB = [buildStripes('stripesTop', 14, 7), buildStripes('stripesBottom', 14, 19), buildStripes('stripesCorner', 8, 3, .5)];
const tickStripes = (t) => SB.forEach((bars) => bars.forEach((b) => {
  b.el.style.transform = `translateX(${b.x + Math.sin(t * b.s + b.p) * 160}px)`;
  b.el.style.opacity = (b.o * (.7 + .3 * Math.sin(t * b.s * 1.7 + b.p))).toFixed(3);
}));

// The bottom stripes run behind the end of the community section and under the glass footer.
const footer = $('#footer');
const sbEl = $('#stripesBottom');
sbEl.style.top = (footer.offsetTop - 620) + 'px'; sbEl.style.height = (620 + footer.offsetHeight) + 'px';

const rooms = $$('.room');
const imgs = $$('.screens img');
const titles = ['gg sh · Room', 'gg sh · Study workspace', 'Home', 'OmniLume Music'];
const W = { main: $('#wMain'), music: $('#wMusic'), chat: $('#wChat') };
const tabs = [0, 1, 2, 3].map((i) => $('#tab' + i));
const cardStarts = [0, 4, 6, 8].map((i) => Math.min(i * 352, 10 * 352 - 16 - 1200));
const sentences = $$('#sayBig .s');
const views = $$('.nw-v');
const moreStates = [ // [sentence index, view, pill label, icon, caption]
  [0, 0, 'Focus timer', 'i-timer', 'One timer for the whole room, so breaks start together.'],
  [2, 1, 'Whiteboard', 'i-pen', 'One canvas for everyone in the room, drawn on live.'],
  [5, 2, 'Shared notes', 'i-notes', 'Notes and task lists the whole room edits together.'],
];
const topOf = (id, off) => { let el = $(id), y = 0; while (el && el.id !== 'page') { y += el.offsetTop; el = el.offsetParent; } return y + off; };

// ---- Timeline (seconds) ----
const HAND = 55.8; // "Create account" opens the app: the page fades out and the mark draws again
const T = {
  switches: [[0, 0], [5.2, 1], [7.0, 2], [8.8, 3], [10.6, 0]],
  tabs: [[0, 0], [24.4, 1], [26.2, 2], [28.0, 3]],
  more: [[0, 0], [43.2, 1], [45.4, 2]],
  clicks: [5.1, 6.9, 8.7, 10.5, 12.15, 14.75, 17.0, 24.3, 26.1, 27.9, 55.45],
  holds: [[12.15, 14.05], [14.75, 16.45]],
};
const scrollKeys = () => [
  [0, 0], [21.0, 0], [22.8, topOf('#cards', 60)],
  [29.4, topOf('#cards', 60)], [31.2, topOf('#ai', 0)],
  [36.4, topOf('#ai', 0)], [37.8, topOf('#aiRow', -560)],
  [39.6, topOf('#aiRow', -560)], [41.2, topOf('#more', 40)],
  [47.6, topOf('#more', 40)], [49.4, topOf('#loop', 40)],
  [52.6, topOf('#loop', 40)], [54.2, $('#page').offsetHeight - 900],
];
const scrollAt = (t) => { const k = scrollKeys(); for (let i = 0; i < k.length - 1; i++) if (t < k[i + 1][0]) return lerp(k[i][1], k[i + 1][1], seg(t, k[i][0], k[i + 1][0])); return k[k.length - 1][1]; };

const wp = [
  [3.9, () => [1180, 880]],
  [5.0, () => center(rooms[1], 70)], [6.8, () => center(rooms[2], 50)], [8.6, () => center(rooms[3], 50)], [10.4, () => center(rooms[0], 50)],
  [12.0, () => center($('#barChat'))], [14.0, () => center($('#barChat'))],
  [14.7, () => center($('#barMusic'))], [16.4, () => center($('#barMusic'))],
  [16.9, () => center($('#barMain'), 260)], [22.9, () => [900, 760]],
  [24.2, () => center(tabs[1])], [26.0, () => center(tabs[2])], [27.8, () => center(tabs[3])], [29.4, () => center(tabs[3])],
  [54.0, () => [1080, 560]], [55.3, g('#ftCreate', 52)], [57, g('#ftCreate', 52)],
];
const chips = [[0, ''], [3.0, 'Landing page'], [22.9, 'Every feature gets a card'], [31.4, 'AI features · planned'], [41.4, 'What else it can do'], [49.6, 'Community and real screens'], [54.4, 'Create an account to go inside'], [HAND, '']];
const REVEAL = [
  ['#cards .split-head', 21.7], ['#cardRow', 21.95],
  ['#ai .kicker', 30.2], ['#ai h2', 30.32], ['#ai .sub', 30.44], ['#aiFrame', 30.6],
  ['#aiRow', 37.1], ['#ai .soon', 37.3],
  ['#more .more-grid > div:first-child', 40.3], ['#more .stage2', 40.5],
  ['#loop > .say', 48.5], ['#loop .loop-cards', 48.7], ['#loop .thumbs-wrap', 48.95], ['#loop .loop-foot', 49.1],
  ['footer .foot', 53.2], ['footer .foot-bottom', 53.4],
].map(([s, a]) => [$(s), a]);

const HOV = $$('.hv, .btn'); HOV.forEach((el) => { el._h = 0; });
const GLASS = $$('.glass');
let lastT = null;

window.render = (t) => {
  const dt = lastT == null ? 1 : Math.abs(t - lastT); lastT = t;
  const k = dt > .2 ? 1 : 1 - Math.exp(-dt * 14);
  tickStripes(t);
  $('#o1').style.transform = `translate(${Math.sin(t * .12) * 60}px, ${Math.cos(t * .1) * 40}px)`;
  $('#o2').style.transform = `translate(${Math.cos(t * .09) * 70}px, ${Math.sin(t * .11) * 50}px)`;
  $('#o3').style.transform = `translate(${Math.sin(t * .08 + 1) * 90}px, ${Math.cos(t * .12) * 30}px)`;

  // Intro and hand-off: the mark draws itself (again at the end, as the app opens).
  const li = t < 30 ? t : Math.max(0, t - HAND);
  $('#inTile').style.opacity = segO(li, 0, .5);
  $('#inRing').setAttribute('stroke-dashoffset', (1 - seg(li, .25, 1.25)).toFixed(4));
  $('#inRing').style.opacity = li > .26 ? 1 : 0; // a zero-length dash still draws its round cap
  $('#inCore').style.opacity = segO(li, .8, 1.5);
  $('#inDot').style.transform = `scale(${spring(clamp((li - 1.05) / .7))})`;
  const iw = segO(li, 1.2, 1.9); $('#inWord').style.opacity = iw; $('#inWord').style.transform = `translateY(${(1 - iw) * 12}px)`;
  const it = segO(li, 1.45, 2.1); $('#inTag').style.opacity = it; $('#inTag').style.transform = `translateY(${(1 - it) * 10}px)`;
  const io = t < 30 ? 1 - seg(t, 2.2, 2.8) : seg(t, HAND - .1, HAND + .3); $('#intro').style.opacity = io; $('#intro').style.transform = `scale(${1 + .04 * (1 - io)})`;
  const out = seg(t, HAND - .15, HAND + .45);
  const camIn = segO(t, 2.3, 3.0);
  $('#cam').style.opacity = camIn * (1 - out);
  const rise = segO(t, 2.6, 3.7);
  $('#heroHead').style.opacity = rise; $('#heroHead').style.transform = `translateY(${(1 - rise) * 14}px)`;
  const deskIn = segO(t, 3.0, 4.2);
  $('#desk').style.opacity = deskIn; $('#desk').style.transform = `translateY(${(1 - deskIn) * 22}px) scale(${.985 + .015 * deskIn})`;
  for (const [el, a] of REVEAL) { const p = outQuint(clamp((t - a) / .8)); el.style.opacity = p; el.style.translate = `0 ${((1 - p) * 22).toFixed(2)}px`; }

  // Desk windows: dragged windows lift while held.
  const pc = seg(t, 12.4, 14.0), pm = seg(t, 14.9, 16.4);
  const p = { main: [32, 40], chat: [lerp(868, 40, pc), lerp(72, 372, pc)], music: [lerp(904, 600, pm), lerp(372, 404, pm)] };
  const lifted = { main: false, chat: t >= 12.2 && t < 14.05, music: t >= 14.8 && t < 16.45 };
  const z = { main: t >= 17.05 ? 9 : 2, chat: t >= 12.2 ? 5 : 4, music: t >= 14.8 ? 6 : 3 };
  for (const key of Object.keys(W)) {
    const el = W[key]; el.style.left = p[key][0] + 'px'; el.style.top = p[key][1] + 'px'; el.style.zIndex = z[key];
    el.style.scale = lifted[key] ? '1.015' : '';
    el.style.boxShadow = lifted[key] ? 'inset 0 1px 0 rgba(255,255,255,.14), 0 40px 90px rgba(8,5,18,.55)' : '';
  }
  const sw = stepAt(T.switches, t); const a = clamp((t - sw.at) / .45);
  imgs.forEach((img, i) => { img.style.opacity = i === sw.cur ? (sw.at <= 0 ? 1 : smooth(a)) : i === sw.prev ? 1 : 0; img.style.zIndex = i === sw.cur ? 2 : 1; img.style.transform = i === sw.cur && sw.at > 0 ? `scale(${1.02 - .02 * outQuint(a)})` : ''; });
  rooms.forEach((r) => r.classList.toggle('is-active', Number(r.dataset.i) === sw.cur));
  $('#mainTitle').textContent = titles[sw.cur];
  const secs = 112 + Math.floor(t);
  $('#musicProg').style.width = ((112 + t) / 208 * 100).toFixed(2) + '%';
  $('#musicTime').textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

  // Feature cards: the tab highlight slides, then the rail follows.
  const tb = stepAt(T.tabs, t); const tp = outQuint(clamp((t - tb.at) / .5));
  tabs.forEach((el, i) => el.classList.toggle('is-active', i === tb.cur));
  const A0 = tabs[tb.prev], A1 = tabs[tb.cur];
  $('#tabHi').style.left = lerp(A0.offsetLeft, A1.offsetLeft, tp) + 'px'; $('#tabHi').style.width = lerp(A0.offsetWidth, A1.offsetWidth, tp) + 'px';
  $('#cardRow').style.transform = `translateX(${-lerp(cardStarts[tb.prev], cardStarts[tb.cur], outQuint(clamp((t - tb.at - .05) / .9)))}px)`;
  const left = 1498 - Math.floor(t); $('#cardTimer').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  $$('#flow span').forEach((s, i) => { s.style.opacity = (.35 + .65 * (.5 + .5 * Math.sin(t * 1.4 - i * .9))).toFixed(2); });
  $$('#lv1 b, #lv2 b').forEach((b, i) => { b.style.height = (4 + Math.abs(Math.sin(t * 7 + i * 1.3)) * 14).toFixed(1) + 'px'; });
  $('#wbDev').setAttribute('transform', `translate(${200 + Math.sin(t * 1.2) * 30} ${118 + Math.cos(t * 1.2) * 18})`);

  // AI section: the agent works through its steps.
  [['#st1', 32.0], ['#st2', 32.8], ['#st3', 33.6]].forEach(([id, at]) => { const o = segO(t, at, at + .5); $(id).style.opacity = o; $(id).style.transform = `translateY(${(1 - o) * 8}px)`; });
  const an = segO(t, 34.4, 35.0); $('#ans').style.opacity = an; $('#ans').style.transform = `translateY(${(1 - an) * 8}px)`;
  $$('#flashes .flash').forEach((f, i) => { const s = spring(clamp((t - 35.0 - i * .12) / .7)); f.style.opacity = clamp((t - 35.0 - i * .12) / .25); f.style.transform = `translateY(${(1 - s) * 12}px) scale(${.96 + .04 * s})`; });
  const q = 'Catch me up on the film club chat'; $('#quickText').textContent = q.slice(0, Math.round(q.length * clamp((t - 37.6) / 1.6))) || ' ';

  // What else: the highlighted sentence and the window change together.
  const ms = stepAt(T.more, t); const st = moreStates[ms.cur];
  const sa = smooth(clamp((t - ms.at) / .5));
  sentences.forEach((s, i) => { const on = i === st[0] ? (ms.at <= 0 ? 1 : sa) : i === moreStates[ms.prev][0] && ms.at > 0 ? 1 - sa : 0; s.style.color = `color-mix(in srgb, var(--text) ${Math.round(on * 100)}%, var(--dim))`; });
  const va = clamp((t - ms.at) / .45);
  views.forEach((v, i) => { const o = i === st[1] ? (ms.at <= 0 ? 1 : smooth(va)) : i === moreStates[ms.prev][1] ? 1 - smooth(va) : 0; v.style.opacity = o; v.style.transform = i === st[1] && ms.at > 0 ? `translateY(${(1 - outQuint(va)) * 10}px)` : ''; });
  $('#nwTitle').textContent = st[2]; $('#pillName').textContent = st[2];
  $('#pillIcon').innerHTML = `<use href="#${st[3]}"/>`; $('#pillCap').innerHTML = `${st[4]} <u>Learn more</u>`;
  const nwl = 1122 - Math.floor(t); $('#nwTimer').textContent = `${Math.floor(nwl / 60)}:${String(nwl % 60).padStart(2, '0')}`;

  // Community reel drifts.
  $('#thumbs').style.transform = `translateX(${-((t * 40) % (5 * 292))}px)`;

  // Camera.
  const zoom = 1 + 0.55 * (seg(t, 17.6, 18.9) - seg(t, 19.8, 20.8));
  const ox = 120 + 32 + 200 + 360, oy = 320 + 40 + 40 + 220;
  $('#page').style.transform = `translateY(${-scrollAt(t)}px)`;
  $('#cam').style.transform = `translate(${ox}px, ${oy}px) scale(${zoom * (1 - .02 * out)}) translate(${-ox}px, ${-oy}px)`;

  // Section label chip.
  const ch = stepAt(chips, t); const chip = $('#chipSec');
  chip.textContent = ch.cur; const co = ch.cur ? segO(t, ch.at, ch.at + .45) * (1 - seg(t, ch.at + 3.2, ch.at + 3.6)) : 0;
  chip.style.opacity = co; chip.style.transform = `translateY(${(1 - co) * 6}px)`;

  // Cursor: eased, slightly curved path; press dips, held drags stay pressed.
  let i = 0; while (i < wp.length - 2 && t >= wp[i + 1][0]) i++;
  const A = wp[i][1](), B = wp[i + 1][1](), qq = smooth(clamp((t - wp[i][0]) / (wp[i + 1][0] - wp[i][0])));
  const ddx = B[0] - A[0], ddy = B[1] - A[1], len = Math.hypot(ddx, ddy) || 1, arc = Math.sin(Math.PI * qq) * Math.min(34, len * .07);
  const cx = lerp(A[0], B[0], qq) - ddy / len * arc, cy = lerp(A[1], B[1], qq) + ddx / len * arc;
  const lc = T.clicks.filter((c) => t >= c).pop();
  const held = T.holds.some(([s, e]) => t >= s && t < e);
  const pressK = held ? 1 : lc != null && t - lc < .3 ? (t - lc < .08 ? (t - lc) / .08 : 1 - outQ((t - lc - .08) / .22)) : 0;
  const curO = Math.max(seg(t, 3.7, 4.1) * (1 - seg(t, 17.2, 17.5)), seg(t, 23.0, 23.4) * (1 - seg(t, 28.8, 29.2)), seg(t, 54.3, 54.7) * (1 - seg(t, HAND, HAND + .3)));
  $('#cursor').style.opacity = curO;
  $('#cursor').style.transform = `translate(${cx - 2}px, ${cy - 2}px) scale(${1 - .12 * pressK})`;
  const rp = lc == null ? 1 : clamp((t - lc) / .45);
  $('#ring').style.opacity = rp < 1 ? (1 - outQ(rp)) * .9 : 0;
  $('#ring').style.transform = `translate(${cx}px, ${cy}px) scale(${.4 + outQ(rp)})`;

  // Hover and press feedback, eased frame to frame.
  const cursorOn = curO > .5;
  for (const el of HOV) {
    let over = false; if (cursorOn) { const r = el.getBoundingClientRect(); over = cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom; }
    el._h += ((over ? 1 : 0) - el._h) * k; el.style.setProperty('--h', el._h.toFixed(3));
    el.style.scale = over && pressK > 0 && !held ? (1 - .035 * pressK).toFixed(4) : '';
  }
  // Pointer light on glass.
  for (const el of GLASS) {
    if (!cursorOn) { el.style.setProperty('--mx', '-999px'); continue; }
    const r = el.getBoundingClientRect(); el.style.setProperty('--mx', (cx - r.left) + 'px'); el.style.setProperty('--my', (cy - r.top) + 'px');
  }
};
window.DURATION = HAND + 2.1; // ends on the drawn mark, matching the app video at 2.1 s
render(0);
