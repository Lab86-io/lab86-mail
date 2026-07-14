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
