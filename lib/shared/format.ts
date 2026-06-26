export function shortFrom(value: string | null | undefined): string {
  return (
    String(value || '')
      .replace(/<.*?>/g, '')
      .replaceAll('"', '')
      .trim() || String(value || '')
  );
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
