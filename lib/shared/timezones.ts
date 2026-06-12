// Wall-clock parsing for tool inputs. An ISO string WITH a Z or ±hh:mm offset
// is absolute and parses directly. A naive string ("2026-06-12T14:30:00") is
// somebody's wall clock — interpreting it as UTC is how "2:30" becomes 10:30
// on a real calendar — so it's resolved in the supplied IANA timezone.

const OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

export function parseIsoInTimezone(value: string, timezone: string | undefined, field: string): number {
  const trimmed = value.trim();
  if (OFFSET_RE.test(trimmed)) {
    const parsed = Date.parse(trimmed);
    if (!Number.isFinite(parsed)) throw new Error(`Invalid ISO timestamp for ${field}: ${value}`);
    return parsed;
  }
  const tz = timezone || 'UTC';
  // Treat the naive string's components as wall time in `tz`. Two passes
  // handle DST: the first guess assumes the offset at the UTC reading of the
  // wall time, the second corrects it with the offset at the guessed instant.
  const asUtc = Date.parse(`${trimmed}${trimmed.includes('T') ? '' : 'T00:00:00'}Z`);
  if (!Number.isFinite(asUtc)) throw new Error(`Invalid ISO timestamp for ${field}: ${value}`);
  let epoch = asUtc - timezoneOffsetMs(asUtc, tz);
  epoch = asUtc - timezoneOffsetMs(epoch, tz);
  return epoch;
}

// Wall-clock reading of an instant in `tz` (for business-hours checks etc.).
export function wallClockInTimezone(
  epochMs: number,
  timezone: string | undefined,
): { hour: number; minute: number; weekday: number } {
  const tz = timezone || 'UTC';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(new Date(epochMs));
  const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: weekdays.indexOf(get('weekday')),
  };
}

// Offset of `tz` from UTC at `epochMs`, in ms (positive east of UTC).
function timezoneOffsetMs(epochMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(epochMs));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  // hourCycle h23 quirk: midnight can render as "24".
  const hour = get('hour') % 24;
  const wallAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return wallAsUtc - epochMs;
}
