// Unparseable dates degrade the same way in both tiers: the structured
// compiler drops the clause via the null-returning epoch helpers below, and
// the local matcher's ±Infinity sentinels make the comparison always-true —
// i.e. the filter is ignored rather than matching nothing.
export function startOfDayMs(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return Number.NEGATIVE_INFINITY;
  date.setUTCHours(0, 0, 0, 0);
  return date.valueOf();
}

export function endOfDayMs(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return Number.POSITIVE_INFINITY;
  date.setUTCHours(23, 59, 59, 999);
  return date.valueOf();
}

// Nylas structured filters take Unix timestamps in SECONDS; returns null for
// unparseable dates so callers can drop the clause instead of sending NaN.
export function epochSecondsForDayStart(value: string) {
  const ms = startOfDayMs(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export function epochSecondsForDayEnd(value: string) {
  const ms = endOfDayMs(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}
