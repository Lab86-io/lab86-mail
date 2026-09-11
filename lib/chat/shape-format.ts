// Display formatting for shape cards (docs/chat-agentic-pass.md, section 3).
// Pure functions so the cards stay thin and the rules are testable.

const DAY_MS = 24 * 60 * 60 * 1000;

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function timeOf(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function dayOf(date: Date, now: Date): string {
  if (sameDay(date, now)) return 'Today';
  if (sameDay(date, new Date(now.getTime() + DAY_MS))) return 'Tomorrow';
  if (sameDay(date, new Date(now.getTime() - DAY_MS))) return 'Yesterday';
  const withYear = date.getFullYear() !== now.getFullYear();
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
  });
}

/** "Today 2:00–2:30 PM", "Tue, Sep 15 9:00 AM–Wed, Sep 16 5:00 PM", "Today, all day". */
export function formatEventSpan(
  startIso?: string,
  endIso?: string,
  allDay?: boolean,
  now: Date = new Date(),
): string {
  if (!startIso) return '';
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return '';
  const end = endIso ? new Date(endIso) : null;
  const startDay = dayOf(start, now);
  if (allDay) {
    if (end && !sameDay(start, end) && end.getTime() - start.getTime() > DAY_MS) {
      return `${startDay}–${dayOf(end, now)}, all day`;
    }
    return `${startDay}, all day`;
  }
  if (!end || Number.isNaN(end.getTime())) return `${startDay} ${timeOf(start)}`;
  if (sameDay(start, end)) return `${startDay} ${timeOf(start)}–${timeOf(end)}`;
  return `${startDay} ${timeOf(start)}–${dayOf(end, now)} ${timeOf(end)}`;
}

/** "Due today", "Due tomorrow", "Due Tue, Sep 15", "Overdue 3d". */
export function formatDue(dueIso?: string, now: Date = new Date()): string {
  if (!dueIso) return '';
  const due = new Date(dueIso);
  if (Number.isNaN(due.getTime())) return '';
  const days = Math.floor((startOfDay(due).getTime() - startOfDay(now).getTime()) / DAY_MS);
  if (days < 0) return `Overdue ${-days}d`;
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  return `Due ${due.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`;
}

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/** "Sep 15" for this year, "Sep 15, 2025" for another, "" for nothing. */
export function formatShortDate(iso?: string, now: Date = new Date()): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  if (sameDay(date, now)) return timeOf(date);
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
}

/** Join the first `limit` names and count the rest: "Ann, Bo, Cy +3". */
export function joinWithMore(items: string[], limit = 3): string {
  const clean = items.map((item) => item.trim()).filter(Boolean);
  if (clean.length <= limit) return clean.join(', ');
  return `${clean.slice(0, limit).join(', ')} +${clean.length - limit}`;
}

/** "Google Doc" from a Google MIME type, else the kind or the MIME subtype. */
export function fileKindLabel(kind?: string, mimeType?: string): string {
  if (kind) return kind;
  const mime = (mimeType || '').toLowerCase();
  if (mime.includes('google-apps.document')) return 'Google Doc';
  if (mime.includes('google-apps.spreadsheet')) return 'Google Sheet';
  if (mime.includes('google-apps.presentation')) return 'Google Slides';
  if (mime.includes('pdf')) return 'PDF';
  const subtype = mime.split('/')[1];
  return subtype ? subtype.replace(/^vnd\./, '').replace(/[.+-]/g, ' ') : '';
}

/** "3 of 8 steps" for a progress pair. */
export function formatProgress(progress?: { done: number; total: number }): string {
  if (!progress?.total) return '';
  return `${progress.done} of ${progress.total} steps`;
}

/** The host of a URL, without "www.", for source rows. */
export function hostOf(url?: string): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Format a count with thin separators: 12,480. */
export function formatCount(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString() : '0';
}

/** Receipt target entries worth showing: short scalar values only. */
export function receiptTargetEntries(target?: Record<string, unknown>, limit = 4): Array<[string, string]> {
  if (!target) return [];
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(target)) {
    if (value == null || value === '') continue;
    if (typeof value === 'object') continue;
    const text = String(value);
    if (text.length > 80) continue;
    entries.push([key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase(), text]);
    if (entries.length >= limit) break;
  }
  return entries;
}
