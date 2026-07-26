export function normalizeBriefTimezone(value?: string | null): string {
  const timezone = value?.trim() || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
    return timezone;
  } catch {
    return 'UTC';
  }
}

export function dailyBriefEditionTitleAt(generatedAt: number, timezone?: string | null): string {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: normalizeBriefTimezone(timezone),
    weekday: 'long',
  }).format(new Date(generatedAt));
  return `The ${weekday} Brief`;
}

export function dailyBriefDatelineAt(generatedAt: number, timezone?: string | null): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: normalizeBriefTimezone(timezone),
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date(generatedAt));
}
