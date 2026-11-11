// A one-hour calendar event for a scheduled room. Pure: the caller passes `now`
// (DTSTAMP) so the output is deterministic. Lines end in CRLF (RFC 5545).

const pad = (value: number) => String(value).padStart(2, '0');

/** 20261112T093000Z */
function icsUtc(date: Date) {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

/** RFC 5545 TEXT escaping: backslash, semicolon, comma and newlines. */
function icsText(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}

export function buildRoomIcs({ title, start, url, now }: { title: string; start: Date; url: string; now: Date }) {
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//OmniLume//Room//EN',
    'BEGIN:VEVENT',
    `UID:${icsUtc(start)}-${url.replace(/[^a-z0-9]+/gi, '-')}@omnilume`,
    `DTSTAMP:${icsUtc(now)}`,
    `DTSTART:${icsUtc(start)}`,
    `DTEND:${icsUtc(end)}`,
    `SUMMARY:${icsText(title)}`,
    `URL:${icsText(url)}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}
