export const CALENDAR_CORPUS_SEARCH_TEXT_MAX_CHARS = 16_000;

export interface CalendarEventSearchTextInput {
  title?: string | null;
  description?: string | null;
  location?: string | null;
  status?: string | null;
  calendarName?: string | null;
  participants?: unknown[] | null;
  organizer?: unknown;
  conferencing?: unknown;
  recurrence?: string[] | null;
  htmlLink?: string | null;
  icalUid?: string | null;
}

export function normalizeCalendarCorpusText(
  value: unknown,
  maxChars = CALENDAR_CORPUS_SEARCH_TEXT_MAX_CHARS,
) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

export function buildCalendarEventSearchText(input: CalendarEventSearchTextInput) {
  const parts = [
    input.title,
    input.description,
    input.location,
    input.status,
    input.calendarName,
    input.htmlLink,
    input.icalUid,
    ...(input.recurrence || []),
    ...textFromUnknown(input.organizer),
    ...textFromUnknown(input.conferencing),
    ...(input.participants || []).flatMap(textFromUnknown),
  ];
  return normalizeCalendarCorpusText(parts.filter(Boolean).join('\n'));
}

export function calendarYearMonthFromTimestamp(ts: unknown, fallback = Date.now()) {
  const value = Number(ts);
  const fallbackValue = Number.isFinite(fallback) && fallback > 0 ? fallback : Date.now();
  const date = new Date(Number.isFinite(value) && value > 0 ? value : fallbackValue);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Keep this extractor in sync with the Convex-local copy in
// convex/calendarData.ts. Convex functions are bundled separately, so the
// database-side query helpers keep a pure local copy instead of importing from
// app/runtime modules.
function textFromUnknown(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }
  if (Array.isArray(value)) return value.flatMap(textFromUnknown);
  if (typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  return [
    record.name,
    record.email,
    record.title,
    record.phone,
    record.url,
    record.link,
    record.status,
    record.comment,
  ]
    .filter((item): item is string | number | boolean =>
      ['string', 'number', 'boolean'].includes(typeof item),
    )
    .map(String);
}
