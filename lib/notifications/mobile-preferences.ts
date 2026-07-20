export interface MobileNotificationPreferences {
  nativePushEnabled: boolean;
  newMailPushEnabled: boolean;
  eventSuggestionPushEnabled: boolean;
  eveningCheckinEnabled: boolean;
  timezone: string;
}

export function parseMobileNotificationPreferences(value: unknown): MobileNotificationPreferences {
  const body = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  for (const key of [
    'nativePushEnabled',
    'newMailPushEnabled',
    'eventSuggestionPushEnabled',
    'eveningCheckinEnabled',
  ] as const) {
    if (typeof body[key] !== 'boolean') throw new Error(`${key} must be a boolean.`);
  }
  const timezone = String(body.timezone || '').trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error('timezone must be a valid IANA timezone.');
  }
  return {
    nativePushEnabled: body.nativePushEnabled as boolean,
    newMailPushEnabled: body.newMailPushEnabled as boolean,
    eventSuggestionPushEnabled: body.eventSuggestionPushEnabled as boolean,
    eveningCheckinEnabled: body.eveningCheckinEnabled as boolean,
    timezone,
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
  return null;
}
