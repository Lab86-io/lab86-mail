export interface NotificationPreferences {
  _id?: string;
  userId?: string;
  timezone: string;
  eveningCheckinEnabled: boolean;
  eveningCheckinLocalTime: string;
  inAppEnabled: boolean;
  webPushEnabled: boolean;
  emailFallbackEnabled: boolean;
  emailFallbackDelayMinutes: number;
}

export function notificationPreferenceInput(preferences: NotificationPreferences) {
  return {
    timezone: preferences.timezone,
    eveningCheckinEnabled: preferences.eveningCheckinEnabled,
    eveningCheckinLocalTime: preferences.eveningCheckinLocalTime,
    inAppEnabled: preferences.inAppEnabled,
    webPushEnabled: preferences.webPushEnabled,
    emailFallbackEnabled: preferences.emailFallbackEnabled,
    emailFallbackDelayMinutes: preferences.emailFallbackDelayMinutes,
  };
}

export type NotificationPreferenceInput = ReturnType<typeof notificationPreferenceInput>;

/**
 * The form's first state. With no saved row, the device zone is the zone the
 * page shows, and `seed` is the input that saves it at once. Settings says
 * "Everything here is saved", and the check-in, the brief, and quiet hours
 * then all read that one saved zone.
 */
export function initialNotificationForm(
  remote: NotificationPreferences,
  deviceTimezone: string,
): { form: NotificationPreferences; seed: NotificationPreferenceInput | null } {
  if (remote._id) return { form: remote, seed: null };
  const form = { ...remote, timezone: deviceTimezone || remote.timezone };
  return { form, seed: notificationPreferenceInput(form) };
}

/** "America/New York" for "America/New_York". */
export function timeZoneLabel(zone: string) {
  return zone.replaceAll('_', ' ');
}
