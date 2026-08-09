export function shortFrom(value: string | null | undefined): string {
  const raw = String(value || '');
  const stripped = raw.replace(/<.*?>/g, '').replaceAll('"', '').trim();
  if (stripped) return stripped;
  // An address-only header ("<ada@example.test>") strips to nothing; the bare
  // address still beats raw angle brackets in the UI.
  return emailFromHeader(raw) || raw.trim();
}

// Pulls the bare email out of a header value like `"Tori" <tori@example.com>`,
// or returns a lowercase email if the value is already bare. Returns null when
// nothing email-shaped is present.
export function emailFromHeader(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const angle = raw.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/);
  if (angle) return angle[1].toLowerCase();
  const plain = raw.match(/[\w.+-]+@[\w.-]+\.[\w.-]+/);
  return plain ? plain[0].toLowerCase() : null;
}

export function fromInitials(value: string | null | undefined): string {
  const clean = shortFrom(value || '?').trim();
  const parts = clean.split(/[\s@<>]+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

// Provider snippets (Gmail especially) usually open with the subject
// verbatim, so "subject — snippet" would say everything twice. Walk the two
// strings together, tolerant of whitespace and case differences, and return
// the snippet with any leading subject echo (plus separator punctuation)
// removed. A snippet that is only the subject dedupes to ''.
export function dedupeSnippet(
  subject: string | null | undefined,
  snippet: string | null | undefined,
): string {
  const snip = String(snippet || '').trim();
  const subj = String(subject || '').trim();
  if (!snip || !subj) return snip;
  let i = 0;
  let j = 0;
  while (j < subj.length) {
    if (/\s/.test(subj[j])) {
      j += 1;
      continue;
    }
    while (i < snip.length && /\s/.test(snip[i])) i += 1;
    if (i >= snip.length || snip[i].toLowerCase() !== subj[j].toLowerCase()) return snip;
    i += 1;
    j += 1;
  }
  // The match must end on a word boundary: "Orderly dispatched" does not echo
  // the subject "Order".
  if (i < snip.length && /[\p{L}\p{N}]/u.test(snip[i])) return snip;
  return snip.slice(i).replace(/^[\s ]*[-–—:·|]*[\s ]*/, '');
}

// The category-tab badge only earns pixels while it is a real number; a
// saturated counter ("99+") says nothing. Null means "render no badge".
export function unreadBadgeLabel(unread: number | null | undefined): string | null {
  if (!unread || unread <= 0) return null;
  if (unread >= 100) return null;
  return String(Math.floor(unread));
}

export function fromColor(value: string | null | undefined): string {
  const str = String(value || '').toLowerCase();
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) | 0;
  const index = (Math.abs(hash) % 5) + 1;
  return `var(--color-avatar-${index})`;
}

// Tableau-10 categorical palette — the same opaque, distinguishable set the
// calendar assigns per calendar (calendars.colorIndex). Shared so per-account
// rails and calendar events draw colour from one system.
export const TABLEAU10 = [
  '#4E79A7',
  '#F28E2B',
  '#E15759',
  '#76B7B2',
  '#59A14E',
  '#EDC948',
  '#B07AA1',
  '#FF9DA7',
  '#9C755F',
  '#BAB0AC',
] as const;

// Deterministic categorical colour for a stable key (account id, label, …),
// drawn from the same palette the calendar uses so colours line up across
// surfaces.
export function categoricalColor(value: string | null | undefined): string {
  const str = String(value || '').toLowerCase();
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) | 0;
  return TABLEAU10[Math.abs(hash) % TABLEAU10.length];
}

export function dateToEpoch(value: number | string | null | undefined): number {
  if (value == null) return 0;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  if (Number.isFinite(Number(value))) {
    const n = Number(value);
    return n < 1e12 ? n * 1000 : n;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatDate(value: number | string | null | undefined): string {
  if (!value) return '';
  const epoch = typeof value === 'number' ? value : dateToEpoch(value);
  if (!epoch) return '';
  const date = new Date(epoch);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
  if (date.getFullYear() === now.getFullYear())
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: '2-digit' }).format(date);
}

// Day bucket for the editorial date headers: Today / Yesterday / weekday for
// the last week / month (with year once it isn't this year). Weekday labels
// carry the absolute date so the header and the row pills speak one grammar.
export function inboxDateGroupLabel(ts: number, now: Date = new Date()): string {
  if (!ts) return 'Undated';
  const date = new Date(ts);
  // Calendar arithmetic, not fixed 24h steps: daylight-saving days are 23 or
  // 25 hours long and would otherwise shift the buckets.
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayStart = (base: Date, offsetDays: number) => {
    const day = startOfDay(base);
    day.setDate(day.getDate() + offsetDays);
    return day.getTime();
  };
  const that = startOfDay(date).getTime();
  if (that >= dayStart(now, 0) && that < dayStart(now, 1)) return 'Today';
  if (that >= dayStart(now, -1) && that < dayStart(now, 0)) return 'Yesterday';
  if (that >= dayStart(now, -6) && that < dayStart(now, 1)) {
    const weekday = date.toLocaleDateString(undefined, { weekday: 'long' });
    const day = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `${weekday} · ${day}`;
  }
  if (date.getFullYear() === now.getFullYear()) return date.toLocaleDateString(undefined, { month: 'long' });
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function gmailUrlFor(account: string, threadIdOrMessageId: string): string {
  const u = encodeURIComponent(account);
  const id = encodeURIComponent(threadIdOrMessageId);
  return `https://mail.google.com/mail/u/${u}/#all/${id}`;
}

export function stripEmoji(value: string) {
  return String(value || '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
