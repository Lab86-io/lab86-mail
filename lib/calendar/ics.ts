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
  // IANA zone of DTSTART when the file names one, so a write keeps it.
  timezone?: string;
}

export interface ParseIcsOptions {
  // The user's IANA zone. Floating times (no Z and no TZID) and zones that
  // cannot be read are placed in it.
  timezone?: string;
}

export function parseIcsEvents(ics: string, options: ParseIcsOptions = {}): ParsedIcsEvent[] {
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
        const parsed = toEvent(current, options.timezone);
        if (parsed) events.push(parsed);
      }
      current = null;
      continue;
    }
    if (!current) continue;
    // Outlook quotes parameter values that hold a colon, for example
    // TZID="(UTC-05:00) Eastern Time (US & Canada)". Split outside quotes.
    const colon = indexOutsideQuotes(line, ':');
    if (colon < 0) continue;
    const [nameAndParams, value] = [line.slice(0, colon), line.slice(colon + 1)];
    const [name, ...paramParts] = splitOutsideQuotes(nameAndParams, ';');
    const params: Record<string, string> = {};
    for (const part of paramParts) {
      const eq = part.indexOf('=');
      if (eq > 0) params[part.slice(0, eq).toUpperCase()] = unquote(part.slice(eq + 1));
    }
    current[name.toUpperCase()] = { params, value };
  }
  return events;
}

function toEvent(
  props: Record<string, { params: Record<string, string>; value: string }>,
  userTimezone: string | undefined,
): ParsedIcsEvent | null {
  const start = parseIcsDate(props.DTSTART, userTimezone);
  if (!start) return null;
  const end = parseIcsDate(props.DTEND, userTimezone);
  const allDay = Boolean(props.DTSTART?.params.VALUE === 'DATE');
  const timezone = allDay ? undefined : ianaZone(props.DTSTART?.params.TZID);
  return {
    ...(timezone ? { timezone } : {}),
    title: unescapeText(props.SUMMARY?.value || '(untitled event)'),
    startAt: start,
    endAt: end ?? start + (allDay ? 86_400_000 : 60 * 60_000),
    allDay,
    location: props.LOCATION?.value ? unescapeText(props.LOCATION.value) : undefined,
    description: props.DESCRIPTION?.value ? unescapeText(props.DESCRIPTION.value) : undefined,
  };
}

function parseIcsDate(
  prop: { params: Record<string, string>; value: string } | undefined,
  userTimezone: string | undefined,
): number | null {
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
  const tzid = prop.params.TZID;
  const zone = ianaZone(tzid);
  if (zone) return parseIsoInTimezone(iso, zone, 'ics');
  // An Outlook name with an unknown place still carries its UTC offset.
  const offset = utcOffsetFromLabel(tzid);
  if (offset !== null) return Date.parse(`${iso}Z`) - offset;
  // A floating time, or a zone that cannot be read, is the user's wall clock.
  return parseIsoInTimezone(iso, isValidZone(userTimezone) ? userTimezone : 'UTC', 'ics');
}

// Windows zone names (CLDR windowsZones, territory 001) and the Outlook
// display names that Exchange writes into TZID. The common zones only.
const WINDOWS_ZONES: Record<string, string> = {
  'dateline standard time': 'Etc/GMT+12',
  'hawaiian standard time': 'Pacific/Honolulu',
  'alaskan standard time': 'America/Anchorage',
  'pacific standard time': 'America/Los_Angeles',
  'pacific time (us & canada)': 'America/Los_Angeles',
  'us mountain standard time': 'America/Phoenix',
  arizona: 'America/Phoenix',
  'mountain standard time': 'America/Denver',
  'mountain time (us & canada)': 'America/Denver',
  'central standard time': 'America/Chicago',
  'central time (us & canada)': 'America/Chicago',
  'canada central standard time': 'America/Regina',
  'central standard time (mexico)': 'America/Mexico_City',
  'eastern standard time': 'America/New_York',
  'eastern time (us & canada)': 'America/New_York',
  'us eastern standard time': 'America/Indiana/Indianapolis',
  'atlantic standard time': 'America/Halifax',
  'atlantic time (canada)': 'America/Halifax',
  'newfoundland standard time': 'America/St_Johns',
  'sa pacific standard time': 'America/Bogota',
  'e. south america standard time': 'America/Sao_Paulo',
  'argentina standard time': 'America/Argentina/Buenos_Aires',
  utc: 'UTC',
  'coordinated universal time': 'UTC',
  'gmt standard time': 'Europe/London',
  'dublin, edinburgh, lisbon, london': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'w. europe standard time': 'Europe/Berlin',
  'amsterdam, berlin, bern, rome, stockholm, vienna': 'Europe/Berlin',
  'central europe standard time': 'Europe/Budapest',
  'belgrade, bratislava, budapest, ljubljana, prague': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw',
  'sarajevo, skopje, warsaw, zagreb': 'Europe/Warsaw',
  'romance standard time': 'Europe/Paris',
  'brussels, copenhagen, madrid, paris': 'Europe/Paris',
  'gtb standard time': 'Europe/Bucharest',
  'fle standard time': 'Europe/Kiev',
  'israel standard time': 'Asia/Jerusalem',
  'south africa standard time': 'Africa/Johannesburg',
  'egypt standard time': 'Africa/Cairo',
  'w. central africa standard time': 'Africa/Lagos',
  'e. africa standard time': 'Africa/Nairobi',
  'russian standard time': 'Europe/Moscow',
  'turkey standard time': 'Europe/Istanbul',
  'arabian standard time': 'Asia/Dubai',
  'pakistan standard time': 'Asia/Karachi',
  'india standard time': 'Asia/Kolkata',
  'chennai, kolkata, mumbai, new delhi': 'Asia/Kolkata',
  'se asia standard time': 'Asia/Bangkok',
  'china standard time': 'Asia/Shanghai',
  'singapore standard time': 'Asia/Singapore',
  'taipei standard time': 'Asia/Taipei',
  'tokyo standard time': 'Asia/Tokyo',
  'korea standard time': 'Asia/Seoul',
  'w. australia standard time': 'Australia/Perth',
  'cen. australia standard time': 'Australia/Adelaide',
  'e. australia standard time': 'Australia/Brisbane',
  'aus eastern standard time': 'Australia/Sydney',
  'new zealand standard time': 'Pacific/Auckland',
};

const OFFSET_LABEL_RE = /^\((?:UTC|GMT)(?:([+-])(\d{1,2}):?(\d{2}))?\)\s*/i;

// Resolves a TZID to an IANA zone: an IANA name as-is, else a Windows or
// Outlook name. Returns undefined when the zone cannot be read.
export function ianaZone(tzid: string | undefined): string | undefined {
  const raw = unquote(String(tzid || '')).trim();
  if (!raw) return undefined;
  // Some producers prefix a path, for example "/freeassociation.sourceforge.net/America/New_York".
  const candidates = [raw, raw.replace(/^\/.*?\/(?=[A-Za-z]+\/[A-Za-z_]+)/, '')];
  for (const candidate of candidates) if (isValidZone(candidate)) return candidate;
  const name = raw.replace(OFFSET_LABEL_RE, '').trim().toLowerCase();
  return WINDOWS_ZONES[name] ?? WINDOWS_ZONES[raw.toLowerCase()];
}

// "(UTC-05:00) Some Place" → -5 h in ms. Null when there is no offset label.
function utcOffsetFromLabel(tzid: string | undefined): number | null {
  const match = OFFSET_LABEL_RE.exec(String(tzid || '').trim());
  if (!match) return null;
  if (!match[1]) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3])) * 60_000;
}

function isValidZone(zone: string | undefined): zone is string {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function indexOutsideQuotes(value: string, needle: string): number {
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"') quoted = !quoted;
    else if (char === needle && !quoted) return index;
  }
  return -1;
}

function splitOutsideQuotes(value: string, separator: string): string[] {
  const parts: string[] = [];
  let rest = value;
  for (
    let index = indexOutsideQuotes(rest, separator);
    index >= 0;
    index = indexOutsideQuotes(rest, separator)
  ) {
    parts.push(rest.slice(0, index));
    rest = rest.slice(index + 1);
  }
  parts.push(rest);
  return parts;
}

function unescapeText(value: string): string {
  return value.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\').trim();
}
