import { localDateKey, localMinuteOfDay, parseClockMinutes } from './local-time';

export type RoutineCadence = 'daily' | 'weekly' | 'weekdays' | 'custom';

export interface RoutineScheduleLike {
  cadence: RoutineCadence;
  daysOfWeek?: number[];
  localTime: string;
  timezone: string;
  quietHoursStart?: string;
  quietHoursEnd?: string;
}

function safeTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    return 'UTC';
  }
}

export function localDayOfWeek(timezone: string, at = new Date()) {
  try {
    const short = new Intl.DateTimeFormat('en-US', {
      timeZone: safeTimezone(timezone),
      weekday: 'short',
    }).format(at);
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(short);
  } catch {
    return at.getUTCDay();
  }
}

export function routineRunsOnDay(schedule: RoutineScheduleLike, at = new Date()) {
  const day = localDayOfWeek(schedule.timezone, at);
  if (schedule.cadence === 'daily') return true;
  if (schedule.cadence === 'weekdays') return day >= 1 && day <= 5;
  const selected = [...new Set(schedule.daysOfWeek || [])].filter(
    (value) => Number.isInteger(value) && value >= 0 && value <= 6,
  );
  if (schedule.cadence === 'weekly') return selected.length ? selected.includes(day) : day === 0;
  return selected.includes(day);
}

export function routineRunKey(routineId: string, timezone: string, at = new Date()) {
  return `${routineId}:${localDateKey(timezone, at)}`;
}

/**
 * Find the next scheduler tick at or after the routine's local wall-clock time.
 * Walking by minutes is intentionally boring and DST-safe: this runs only when
 * a routine is created, changed, or materialized, never in a hot render path.
 */
export function nextRoutineRunAt(schedule: RoutineScheduleLike, after = Date.now()) {
  const timezone = safeTimezone(schedule.timezone);
  const targetMinute = parseClockMinutes(schedule.localTime, 19 * 60);
  const suppliedDays = schedule.daysOfWeek || [];
  if (
    schedule.cadence === 'custom' &&
    (suppliedDays.length === 0 || suppliedDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6))
  ) {
    return null;
  }
  const start = Math.ceil(after / 60_000) * 60_000;
  for (let offset = 0; offset <= 9 * 24 * 60; offset += 1) {
    const candidate = new Date(start + offset * 60_000);
    if (!routineRunsOnDay({ ...schedule, timezone }, candidate)) continue;
    if (localMinuteOfDay(timezone, candidate) === targetMinute) return candidate.getTime();
  }
  return null;
}

export function routineIsDue(
  schedule: RoutineScheduleLike & { status: string; consent: string; nextRunAt: number },
  at = Date.now(),
) {
  return schedule.status === 'active' && schedule.consent === 'enabled' && schedule.nextRunAt <= at;
}

export function routineIsInQuietHours(schedule: RoutineScheduleLike, at: number | Date) {
  if (!schedule.quietHoursStart || !schedule.quietHoursEnd) return false;
  const start = parseClockMinutes(schedule.quietHoursStart, -1);
  const end = parseClockMinutes(schedule.quietHoursEnd, -1);
  if (start < 0 || end < 0 || start === end) return false;
  const minute = localMinuteOfDay(schedule.timezone, at instanceof Date ? at : new Date(at));
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function describeRoutineCadence(schedule: RoutineScheduleLike) {
  const time = schedule.localTime;
  if (schedule.cadence === 'daily') return `Daily at ${time}`;
  if (schedule.cadence === 'weekdays') return `Weekdays at ${time}`;
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = (schedule.daysOfWeek || [])
    .filter((day) => day >= 0 && day <= 6)
    .map((day) => names[day])
    .join(', ');
  return `${days || 'Scheduled'} at ${time}`;
}
