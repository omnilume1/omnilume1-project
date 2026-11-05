export type LyricLine = { ms: number; text: string };
export type ParsedLyrics = { synced: boolean; lines: LyricLine[] };

const STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const MAX_LINES = 2000;
const MAX_LINE_CHARS = 500;

/**
 * LRC (`[mm:ss.xx]` stamps, several per line allowed, `[offset:±ms]`) or plain text.
 * Lines without a stamp are dropped once any stamp exists; metadata tags are ignored.
 */
export function parseLyrics(source: string | null | undefined): ParsedLyrics {
  const text = (source ?? '').replace(/\r\n?/g, '\n');
  const offset = Number(text.match(/^\[offset:\s*([+-]?\d+)\]/im)?.[1] ?? 0);
  const synced: LyricLine[] = [];
  const plain: LyricLine[] = [];

  for (const raw of text.split('\n')) {
    if (synced.length + plain.length >= MAX_LINES) break;
    const stamps = [...raw.matchAll(STAMP)];
    const body = raw.replace(STAMP, '').trim().slice(0, MAX_LINE_CHARS);
    if (stamps.length === 0) {
      if (body && !/^\[[a-z]+:.*\]$/i.test(body)) plain.push({ ms: 0, text: body });
      continue;
    }
    for (const [, min, sec, frac = '0'] of stamps) {
      // "5" = 500 ms, "05" = 50 ms, "005" = 5 ms.
      const fraction = Number(frac.padEnd(3, '0'));
      const ms = (Number(min) * 60 + Number(sec)) * 1000 + fraction - offset;
      synced.push({ ms: Math.max(0, ms), text: body });
    }
  }

  if (synced.length > 0) return { synced: true, lines: synced.sort((a, b) => a.ms - b.ms) };
  return { synced: false, lines: plain };
}

const pad = (value: number, size = 2) => String(value).padStart(size, '0');

/** Embedded synchronised lyrics (ms timestamps) → LRC text for storage. */
export function toLrc(lines: { text: string; timestamp?: number }[]): string {
  return lines
    .filter((line) => typeof line.timestamp === 'number' && line.timestamp >= 0)
    .map((line) => {
      const ms = Math.round(line.timestamp!);
      return `[${pad(Math.floor(ms / 60000))}:${pad(Math.floor(ms / 1000) % 60)}.${pad(Math.floor((ms % 1000) / 10))}]${line.text.trim()}`;
    })
    .join('\n');
}
