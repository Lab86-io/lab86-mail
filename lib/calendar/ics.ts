import { parseIsoInTimezone } from '@/lib/shared/timezones';

// Minimal ICS (RFC 5545) event extraction — enough for invitation/ticket
// attachments. Full grammar support is out of scope; unknown components are
// ignored and a malformed file just yields zero events.

export interface ParsedIcsEvent {
  title: string;
  startAt: number;
  endAt: number;
  allDay: boolean;
  location?: string;
  description?: string;
}

export function parseIcsEvents(ics: string): ParsedIcsEvent[] {
  // Unfold continuation lines (CRLF followed by space/tab).
  const unfolded = ics.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);
  const events: ParsedIcsEvent[] = [];
  let current: Record<string, { params: Record<string, string>; value: string }> | null = null;

  for (const line of lines) {
    if (/^BEGIN:VEVENT/i.test(line)) {
      current = {};
      continue;
    }
    if (/^END:VEVENT/i.test(line)) {
      if (current) {
        const parsed = toEvent(current);
        if (parsed) events.push(parsed);
      }
      current = null;
      continue;
    }
    if (!current) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const [nameAndParams, value] = [line.slice(0, colon), line.slice(colon + 1)];
    const [name, ...paramParts] = nameAndParams.split(';');
    const params: Record<string, string> = {};
    for (const part of paramParts) {
      const eq = part.indexOf('=');
      if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
    }
    current[name.toUpperCase()] = { params, value };
  }
  return events;
}

function toEvent(
  props: Record<string, { params: Record<string, string>; value: string }>,
): ParsedIcsEvent | null {
  const start = parseIcsDate(props.DTSTART);
  if (!start) return null;
  const end = parseIcsDate(props.DTEND);
  const allDay = Boolean(props.DTSTART?.params.VALUE === 'DATE');
  return {
    title: unescapeText(props.SUMMARY?.value || '(untitled event)'),
    startAt: start,
    endAt: end ?? start + (allDay ? 86_400_000 : 60 * 60_000),
    allDay,
    location: props.LOCATION?.value ? unescapeText(props.LOCATION.value) : undefined,
    description: props.DESCRIPTION?.value ? unescapeText(props.DESCRIPTION.value) : undefined,
  };
}

function parseIcsDate(prop?: { params: Record<string, string>; value: string }): number | null {
  if (!prop) return null;
  const value = prop.value.trim();
  // All-day date: 20260612
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (dateOnly || prop.params.VALUE === 'DATE') {
    const match = dateOnly || /^(\d{4})(\d{2})(\d{2})/.exec(value);
    if (!match) return null;
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }
  // Datetime: 20260612T193000(Z?)
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!dt) return null;
  const iso = `${dt[1]}-${dt[2]}-${dt[3]}T${dt[4]}:${dt[5]}:${dt[6]}`;
  if (dt[7] === 'Z') return Date.parse(`${iso}Z`);
  // TZID-qualified wall time, else float time treated as the TZID/UTC.
  const tz = prop.params.TZID;
  try {
    return parseIsoInTimezone(iso, tz, 'ics');
  } catch {
    return Date.parse(`${iso}Z`);
  }
}

function unescapeText(value: string): string {
  return value.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\').trim();
}
