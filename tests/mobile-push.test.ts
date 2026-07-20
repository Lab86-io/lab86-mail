import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { APNsDeliveryError, apnsHost, buildAPNsPayload } from '../lib/notifications/apns';
import { mayContainCalendarEvent, parseInlineEventCandidate } from '../lib/mail/suggestion-detectors';
import {
  isAPNsDeviceToken,
  parseMobileDeviceRegistration,
  parseMobileDeviceRevocation,
} from '../lib/notifications/mobile-device';
import {
  nativePushDisabledReason,
  parseMobileNotificationPreferences,
} from '../lib/notifications/mobile-preferences';

const TOKEN = 'AB'.repeat(32);

describe('native mobile device inputs', () => {
  test('normalizes a complete iOS registration', () => {
    expect(
      parseMobileDeviceRegistration({
        platform: 'ios',
        token: ` ${TOKEN} `,
        deviceId: ' 3B3C3896-CE50-42F1-BF09-4E768A66E81B ',
        environment: 'development',
        appVersion: ' 1.0.0 ',
      }),
    ).toEqual({
      platform: 'ios',
      token: TOKEN.toLowerCase(),
      deviceId: '3B3C3896-CE50-42F1-BF09-4E768A66E81B',
      environment: 'development',
      appVersion: '1.0.0',
    });
  });

  test('rejects malformed and non-iOS registrations', () => {
    expect(isAPNsDeviceToken(TOKEN)).toBe(true);
    expect(isAPNsDeviceToken('not-a-token')).toBe(false);
    expect(() =>
      parseMobileDeviceRegistration({
        platform: 'android',
        token: TOKEN,
        deviceId: 'device-1',
        environment: 'production',
      }),
    ).toThrow(/Only iOS/);
    expect(() =>
      parseMobileDeviceRegistration({
        platform: 'ios',
        token: 'abc',
        deviceId: 'device-1',
        environment: 'production',
      }),
    ).toThrow(/APNs device token/);
  });

  test('revocation requires and validates one stable device selector', () => {
    expect(parseMobileDeviceRevocation({ deviceId: 'device.123' })).toEqual({ deviceId: 'device.123' });
    expect(parseMobileDeviceRevocation({ token: TOKEN })).toEqual({ token: TOKEN.toLowerCase() });
    expect(() => parseMobileDeviceRevocation({})).toThrow(/token or deviceId/);
  });
});

describe('APNs delivery contract', () => {
  test('routes development and production tokens to the correct Apple host', () => {
    expect(apnsHost('development')).toBe('api.sandbox.push.apple.com');
    expect(apnsHost('production')).toBe('api.push.apple.com');
  });

  test('builds a visible check-in notification with a native deep link', () => {
    const payload = buildAPNsPayload({
      id: 'notice-1',
      userId: 'user-1',
      title: 'What did you get done today?',
      body: 'Three things may have moved.',
      deepLink: '/?checkin=checkin_123',
    });
    expect(payload).toEqual({
      aps: {
        alert: {
          title: 'What did you get done today?',
          body: 'Three things may have moved.',
        },
        sound: 'default',
        category: 'LAB86_CHECKIN',
        'thread-id': 'albatross.notice-1',
        'content-available': 1,
      },
      notificationId: 'notice-1',
      route: '/checkin?id=checkin_123',
    });
  });

  test('includes an actionable suggestion id without exposing mail content as custom data', () => {
    const payload = buildAPNsPayload({
      id: 'notice-2',
      userId: 'user-1',
      title: 'Add “Design review” to your calendar?',
      body: 'Ari sent a concrete meeting time.',
      deepLink: '/mail/thread?account=acct&thread=thr&suggestion=suggestion_1',
    });
    expect(payload.suggestionId).toBe('suggestion_1');
    expect(payload.route).toContain('/mail/thread');
    expect(payload.aps.category).toBe('LAB86_COMMITMENT');
    expect(JSON.stringify(payload)).not.toContain('user-1');
  });

  test('makes ordinary new mail actionable without exposing message bodies as custom data', () => {
    const payload = buildAPNsPayload({
      id: 'notice-3',
      userId: 'user-1',
      title: 'Ari',
      body: 'Project review',
      deepLink: '/mail/thread?account=acct&thread=thr&message=msg',
    });
    expect(payload.aps.category).toBe('LAB86_MAIL');
    expect(payload.accountId).toBe('acct');
    expect(payload.threadId).toBe('thr');
    expect(payload.messageId).toBe('msg');
    expect(payload).not.toHaveProperty('messageBody');
  });

  test('distinguishes expired device responses from transient APNs failures', () => {
    expect(new APNsDeliveryError('gone', 410, 'Unregistered').invalidToken).toBe(true);
    expect(new APNsDeliveryError('busy', 503, 'ServiceUnavailable').invalidToken).toBe(false);
  });

  test('schema and account deletion keep the native token lifecycle complete', () => {
    const schema = readFileSync(path.join(process.cwd(), 'convex/schema.ts'), 'utf8');
    const accounts = readFileSync(path.join(process.cwd(), 'convex/accounts.ts'), 'utf8');
    expect(schema).toContain('mobilePushDevices: defineTable(');
    expect(schema).toContain("v.literal('native_push')");
    expect(schema).toContain("v.literal('mail_message')");
    expect(accounts).toContain("'mobilePushDevices'");
  });
});

describe('mail event suggestion safety gate', () => {
  const message = {
    providerMessageId: 'message-1',
    providerThreadId: 'thread-1',
    subject: 'Design review Tuesday',
    from: 'Ari <ari@example.test>',
    receivedAt: Date.parse('2026-07-15T12:00:00Z'),
    snippet: 'Let’s meet Tuesday at 3pm for the design review.',
  };

  test('prefilters explicit events and rejects cancellations or vague mail', () => {
    expect(mayContainCalendarEvent(message)).toBe(true);
    expect(mayContainCalendarEvent({ ...message, snippet: 'The Tuesday meeting was cancelled.' })).toBe(
      false,
    );
    expect(
      mayContainCalendarEvent({ ...message, subject: 'July newsletter', snippet: 'Here are updates.' }),
    ).toBe(false);
  });

  test('accepts only confident, bounded, future model output', () => {
    const now = Date.parse('2026-07-15T12:00:00Z');
    expect(
      parseInlineEventCandidate(
        JSON.stringify({
          isEvent: true,
          confidence: 0.94,
          title: 'Design review',
          startIso: '2026-07-21T15:00:00-04:00',
          endIso: '2026-07-21T15:30:00-04:00',
          allDay: false,
          location: 'Studio',
          reason: 'The sender confirmed a concrete date and time.',
        }),
        now,
      ),
    ).toMatchObject({ title: 'Design review', confidence: 0.94, location: 'Studio' });
    expect(
      parseInlineEventCandidate(
        JSON.stringify({
          isEvent: true,
          confidence: 0.6,
          title: 'Maybe meet',
          startIso: '2026-07-21T15:00:00-04:00',
          endIso: '2026-07-21T15:30:00-04:00',
          reason: 'Vague.',
        }),
        now,
      ),
    ).toBeNull();
  });
});

describe('mobile notification preferences', () => {
  test('validates the complete account-level native preference contract', () => {
    expect(
      parseMobileNotificationPreferences({
        nativePushEnabled: true,
        newMailPushEnabled: false,
        eventSuggestionPushEnabled: true,
        eveningCheckinEnabled: false,
        timezone: 'America/New_York',
      }),
    ).toMatchObject({ newMailPushEnabled: false, timezone: 'America/New_York' });
    expect(() =>
      parseMobileNotificationPreferences({
        nativePushEnabled: true,
        newMailPushEnabled: true,
        eventSuggestionPushEnabled: true,
        eveningCheckinEnabled: true,
        timezone: 'not/a-zone',
      }),
    ).toThrow(/timezone/);
  });

  test('suppresses only the notification classes the user disabled', () => {
    expect(nativePushDisabledReason('mail_message', { newMailPushEnabled: false })).toBe('new_mail_disabled');
    expect(nativePushDisabledReason('event_suggestion', { eventSuggestionPushEnabled: false })).toBe(
      'event_suggestions_disabled',
    );
    expect(nativePushDisabledReason('daily_checkin', { newMailPushEnabled: false })).toBeNull();
    expect(nativePushDisabledReason('daily_checkin', { nativePushEnabled: false })).toBe(
      'native_push_disabled',
    );
  });
});
