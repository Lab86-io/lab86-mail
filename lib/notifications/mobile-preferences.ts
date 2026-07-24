export interface MobileNotificationPreferences {
  nativePushEnabled: boolean;
  newMailPushEnabled: boolean;
  eventSuggestionPushEnabled: boolean;
  morningBriefEnabled: boolean;
  eveningCheckinEnabled: boolean;
  eveningCheckinLocalTime: string;
  inAppEnabled: boolean;
  emailFallbackEnabled: boolean;
  emailFallbackDelayMinutes: number;
  timezone: string;
  briefLocationEnabled: boolean;
  briefLatitude?: number;
  briefLongitude?: number;
  briefLocationLabel?: string;
  briefLocationAccuracy?: number;
  briefLocationUpdatedAt?: number;
}

export function parseMobileNotificationPreferences(value: unknown): MobileNotificationPreferences {
  const body = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  for (const key of [
    'nativePushEnabled',
    'newMailPushEnabled',
    'eventSuggestionPushEnabled',
    'eveningCheckinEnabled',
    'inAppEnabled',
    'emailFallbackEnabled',
  ] as const) {
    if (typeof body[key] !== 'boolean') throw new Error(`${key} must be a boolean.`);
  }
  const morningBriefEnabled = body.morningBriefEnabled === undefined ? true : body.morningBriefEnabled;
  if (typeof morningBriefEnabled !== 'boolean') {
    throw new Error('morningBriefEnabled must be a boolean.');
  }
  const briefLocationEnabled = body.briefLocationEnabled === undefined ? false : body.briefLocationEnabled;
  if (typeof briefLocationEnabled !== 'boolean') {
    throw new Error('briefLocationEnabled must be a boolean.');
  }
  const eveningCheckinLocalTime = String(body.eveningCheckinLocalTime || '').trim();
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(eveningCheckinLocalTime)) {
    throw new Error('eveningCheckinLocalTime must be HH:MM.');
  }
  const emailFallbackDelayMinutes = Number(body.emailFallbackDelayMinutes);
  if (
    !Number.isFinite(emailFallbackDelayMinutes) ||
    emailFallbackDelayMinutes < 15 ||
    emailFallbackDelayMinutes > 1440
  ) {
    throw new Error('emailFallbackDelayMinutes must be between 15 and 1440.');
  }
  const timezone = String(body.timezone || '').trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error('timezone must be a valid IANA timezone.');
  }
  const briefLatitude =
    body.briefLatitude === undefined || body.briefLatitude === null ? undefined : Number(body.briefLatitude);
  const briefLongitude =
    body.briefLongitude === undefined || body.briefLongitude === null
      ? undefined
      : Number(body.briefLongitude);
  if (
    briefLatitude !== undefined &&
    (!Number.isFinite(briefLatitude) || briefLatitude < -90 || briefLatitude > 90)
  ) {
    throw new Error('briefLatitude must be between -90 and 90.');
  }
  if (
    briefLongitude !== undefined &&
    (!Number.isFinite(briefLongitude) || briefLongitude < -180 || briefLongitude > 180)
  ) {
    throw new Error('briefLongitude must be between -180 and 180.');
  }
  if (briefLocationEnabled && (briefLatitude === undefined || briefLongitude === undefined)) {
    throw new Error('A valid latitude and longitude are required when brief location is enabled.');
  }
  const briefLocationLabel =
    String(body.briefLocationLabel || '')
      .trim()
      .slice(0, 120) || undefined;
  const rawAccuracy =
    body.briefLocationAccuracy === undefined || body.briefLocationAccuracy === null
      ? undefined
      : Number(body.briefLocationAccuracy);
  const briefLocationAccuracy =
    rawAccuracy !== undefined && Number.isFinite(rawAccuracy)
      ? Math.min(100_000, Math.max(0, rawAccuracy))
      : undefined;
  const rawUpdatedAt =
    body.briefLocationUpdatedAt === undefined || body.briefLocationUpdatedAt === null
      ? undefined
      : Number(body.briefLocationUpdatedAt);
  const briefLocationUpdatedAt =
    rawUpdatedAt !== undefined && Number.isFinite(rawUpdatedAt)
      ? Math.max(0, Math.round(rawUpdatedAt))
      : undefined;
  return {
    nativePushEnabled: body.nativePushEnabled as boolean,
    newMailPushEnabled: body.newMailPushEnabled as boolean,
    eventSuggestionPushEnabled: body.eventSuggestionPushEnabled as boolean,
    morningBriefEnabled,
    eveningCheckinEnabled: body.eveningCheckinEnabled as boolean,
    eveningCheckinLocalTime,
    inAppEnabled: body.inAppEnabled as boolean,
    emailFallbackEnabled: body.emailFallbackEnabled as boolean,
    emailFallbackDelayMinutes: Math.round(emailFallbackDelayMinutes),
    timezone,
    briefLocationEnabled,
    briefLatitude,
    briefLongitude,
    briefLocationLabel,
    briefLocationAccuracy,
    briefLocationUpdatedAt,
  };
}

export function nativePushDisabledReason(
  notificationType: string,
  preference: Partial<MobileNotificationPreferences> | null | undefined,
) {
  if (preference?.nativePushEnabled === false) return 'native_push_disabled' as const;
  if (notificationType === 'mail_message' && preference?.newMailPushEnabled === false) {
    return 'new_mail_disabled' as const;
  }
  if (notificationType === 'event_suggestion' && preference?.eventSuggestionPushEnabled === false) {
    return 'event_suggestions_disabled' as const;
  }
  if (notificationType === 'brief_ready' && preference?.morningBriefEnabled === false) {
    return 'morning_brief_disabled' as const;
  }
  return null;
}
