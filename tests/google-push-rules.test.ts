import { describe, expect, test } from 'bun:test';
import {
  anyGooglePushEnabled,
  GOOGLE_PUSH_ROUTES,
  gmailPushConfig,
  googlePushAddress,
  googlePushFlags,
} from '../lib/google/push/config';
import {
  CALENDAR_PUSH_FALLBACK_POLL_MS,
  calendarAccountPushHealthy,
  channelRenewDue,
  drivePageToken,
  GMAIL_HISTORY_TICK_MS,
  GMAIL_PUSH_FALLBACK_POLL_MS,
  GMAIL_PUSH_SILENCE_MS,
  GMAIL_WATCH_RENEW_AFTER_MS,
  type GooglePushTiming,
  gmailPollDue,
  gmailPushHealthy,
  gmailWatchDue,
  PUSH_EXPIRY_MARGIN_MS,
  PUSH_MESSAGE_WRITE_INTERVAL_MS,
  PUSH_PENDING_TIMEOUT_MS,
  PUSH_RENEW_BEFORE_MS,
  pushMessageWriteDue,
  pushRowLive,
  pushRowVerified,
  pushSpreadOffsetMs,
} from '../lib/google/push/rules';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const row = (overrides: Partial<GooglePushTiming> = {}): GooglePushTiming => ({
  status: 'active',
  requestedAt: NOW - HOUR,
  renewedAt: NOW - HOUR,
  expiration: NOW + 6 * DAY,
  lastMessageAt: NOW - HOUR + 1000,
  ...overrides,
});

describe('push flags and settings', () => {
  test('each flag is off unless it is exactly 1', () => {
    expect(googlePushFlags({})).toEqual({ gmail: false, calendar: false, drive: false });
    expect(
      googlePushFlags({
        LAB86_GOOGLE_GMAIL_PUSH: '1',
        LAB86_GOOGLE_CALENDAR_PUSH: 'true',
        LAB86_GOOGLE_DRIVE_PUSH: '1',
      }),
    ).toEqual({ gmail: true, calendar: false, drive: true });
    expect(anyGooglePushEnabled({ gmail: false, calendar: false, drive: false })).toBe(false);
    expect(anyGooglePushEnabled({ gmail: false, calendar: true, drive: false })).toBe(true);
  });

  test('the Gmail Pub/Sub settings need a valid topic, an audience, and a service account', () => {
    const env = {
      LAB86_GOOGLE_PUBSUB_TOPIC: ' projects/lab86-mail-production/topics/gmail-push ',
      LAB86_GOOGLE_PUBSUB_AUDIENCE: 'https://mail.lab86.io/api/google/push/gmail',
      LAB86_GOOGLE_PUBSUB_SERVICE_ACCOUNT: 'Gmail-Push-Invoker@lab86-mail-production.iam.gserviceaccount.com',
    };
    expect(gmailPushConfig(env)).toEqual({
      topic: 'projects/lab86-mail-production/topics/gmail-push',
      audience: 'https://mail.lab86.io/api/google/push/gmail',
      serviceAccount: 'gmail-push-invoker@lab86-mail-production.iam.gserviceaccount.com',
    });
    expect(gmailPushConfig({ ...env, LAB86_GOOGLE_PUBSUB_TOPIC: 'gmail-push' })).toBeNull();
    expect(gmailPushConfig({ ...env, LAB86_GOOGLE_PUBSUB_AUDIENCE: ' ' })).toBeNull();
    expect(gmailPushConfig({ ...env, LAB86_GOOGLE_PUBSUB_SERVICE_ACCOUNT: 'not-an-account' })).toBeNull();
    expect(gmailPushConfig({})).toBeNull();
  });

  test('a channel address is the HTTPS route of its kind, and null without HTTPS', () => {
    expect(GOOGLE_PUSH_ROUTES).toEqual({
      gmail: '/api/google/push/gmail',
      calendar: '/api/google/push/calendar',
      drive: '/api/google/push/drive',
    });
    expect(googlePushAddress('calendar', 'https://mail.lab86.io/')).toBe(
      'https://mail.lab86.io/api/google/push/calendar',
    );
    expect(googlePushAddress('drive', 'https://mail.lab86.io')).toBe(
      'https://mail.lab86.io/api/google/push/drive',
    );
    expect(googlePushAddress('drive', 'http://localhost:3000')).toBeNull();
    expect(googlePushAddress('drive', 'not a url')).toBeNull();
  });
});

describe('row health', () => {
  test('a live row is active and has more than the margin left', () => {
    expect(pushRowLive(row(), NOW)).toBe(true);
    expect(pushRowLive(row({ status: 'pending' }), NOW)).toBe(false);
    expect(pushRowLive(row({ expiration: undefined }), NOW)).toBe(false);
    expect(pushRowLive(row({ expiration: NOW + PUSH_EXPIRY_MARGIN_MS }), NOW)).toBe(false);
    expect(pushRowLive(row({ expiration: NOW + PUSH_EXPIRY_MARGIN_MS + 1 }), NOW)).toBe(true);
  });

  test('a verified row has a message after its last watch call', () => {
    expect(pushRowVerified(row())).toBe(true);
    expect(pushRowVerified(row({ lastMessageAt: undefined }))).toBe(false);
    expect(pushRowVerified(row({ lastMessageAt: NOW - 2 * HOUR }))).toBe(false);
  });

  test('Gmail push is healthy only with a live, verified watch and a recent push', () => {
    expect(gmailPushHealthy(row(), NOW)).toBe(true);
    expect(gmailPushHealthy(null, NOW)).toBe(false);
    expect(gmailPushHealthy(row({ expiration: NOW - 1 }), NOW)).toBe(false);
    expect(gmailPushHealthy(row({ lastMessageAt: undefined }), NOW)).toBe(false);
    // A renewal moved the request time, and no push came after it yet.
    expect(gmailPushHealthy(row({ requestedAt: NOW - 1000 }), NOW)).toBe(false);
    // No push for longer than the silence limit: the path is broken.
    const quiet = row({
      requestedAt: NOW - GMAIL_PUSH_SILENCE_MS - 2000,
      lastMessageAt: NOW - GMAIL_PUSH_SILENCE_MS - 1000,
    });
    expect(gmailPushHealthy(quiet, NOW)).toBe(false);
  });

  test('a Gmail watch is due when missing, failed and past its wait, stuck, ending soon, or a day old', () => {
    expect(gmailWatchDue(null, NOW)).toBe(true);
    expect(gmailWatchDue(row(), NOW)).toBe(false);
    expect(gmailWatchDue(row({ status: 'failed', retryAfter: NOW + 1 }), NOW)).toBe(false);
    expect(gmailWatchDue(row({ status: 'failed', retryAfter: NOW }), NOW)).toBe(true);
    expect(gmailWatchDue(row({ status: 'failed', retryAfter: undefined }), NOW)).toBe(true);
    expect(gmailWatchDue(row({ status: 'pending', requestedAt: NOW - 1000 }), NOW)).toBe(false);
    expect(gmailWatchDue(row({ status: 'pending', requestedAt: NOW - PUSH_PENDING_TIMEOUT_MS }), NOW)).toBe(
      true,
    );
    expect(gmailWatchDue(row({ expiration: NOW + PUSH_RENEW_BEFORE_MS }), NOW)).toBe(true);
    expect(gmailWatchDue(row({ renewedAt: NOW - GMAIL_WATCH_RENEW_AFTER_MS }), NOW)).toBe(true);
    expect(
      gmailWatchDue(row({ renewedAt: undefined, requestedAt: NOW - GMAIL_WATCH_RENEW_AFTER_MS }), NOW),
    ).toBe(true);
  });

  test('a channel is due when missing, failed and past its wait, stuck, or ending within two days', () => {
    expect(channelRenewDue(undefined, NOW)).toBe(true);
    expect(channelRenewDue(row(), NOW)).toBe(false);
    expect(channelRenewDue(row({ expiration: NOW + PUSH_RENEW_BEFORE_MS }), NOW)).toBe(true);
    expect(channelRenewDue(row({ expiration: undefined }), NOW)).toBe(true);
    expect(channelRenewDue(row({ status: 'failed', retryAfter: NOW + HOUR }), NOW)).toBe(false);
    expect(channelRenewDue(row({ status: 'failed', retryAfter: NOW - 1 }), NOW)).toBe(true);
    expect(channelRenewDue(row({ status: 'pending', requestedAt: NOW - 1000 }), NOW)).toBe(false);
    expect(channelRenewDue(row({ status: 'pending', requestedAt: NOW - PUSH_PENDING_TIMEOUT_MS }), NOW)).toBe(
      true,
    );
  });

  test('a calendar account is healthy when each calendar has a live, verified channel or cannot be watched', () => {
    const rows = [
      { ...row(), calendarId: 'primary@example.com' },
      { ...row({ status: 'failed', unsupported: true }), calendarId: 'holidays' },
    ];
    expect(calendarAccountPushHealthy(['primary@example.com', 'holidays'], rows, NOW)).toBe(true);
    expect(calendarAccountPushHealthy([], rows, NOW)).toBe(false);
    expect(calendarAccountPushHealthy(['primary@example.com', 'team'], rows, NOW)).toBe(false);
    // A channel with no sync message yet does not count.
    const unverified = [{ ...row({ lastMessageAt: undefined }), calendarId: 'primary@example.com' }];
    expect(calendarAccountPushHealthy(['primary@example.com'], unverified, NOW)).toBe(false);
  });

  test('a message time goes to Convex for the first message after a call, then every few minutes', () => {
    expect(pushMessageWriteDue(row({ lastMessageAt: undefined }), NOW)).toBe(true);
    expect(pushMessageWriteDue(row({ lastMessageAt: NOW - 1000 }), NOW)).toBe(false);
    expect(pushMessageWriteDue(row({ lastMessageAt: NOW - PUSH_MESSAGE_WRITE_INTERVAL_MS }), NOW)).toBe(true);
  });
});

describe('Gmail poll back-off', () => {
  test('the spread offset is stable and stays in its span', () => {
    expect(pushSpreadOffsetMs('a', 0)).toBe(0);
    expect(pushSpreadOffsetMs('user:acct', 1000)).toBe(pushSpreadOffsetMs('user:acct', 1000));
    for (const key of ['a', 'b', 'user_1:acct_1', 'user_2:acct_9']) {
      const offset = pushSpreadOffsetMs(key, 900_000);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(900_000);
    }
  });

  test('a mailbox without healthy push is read on each tick', () => {
    for (let tick = 0; tick < 20; tick += 1) {
      expect(gmailPollDue({ now: NOW + tick * GMAIL_HISTORY_TICK_MS, key: 'u:a', healthy: false })).toBe(
        true,
      );
    }
  });

  test('a mailbox with healthy push is read once in each 15-minute period', () => {
    for (const key of ['u1:a1', 'u2:a2', 'u3:a3']) {
      const due: number[] = [];
      // Two hours of 2-minute ticks at an arbitrary start.
      for (let t = NOW + 12_345; t < NOW + 12_345 + 2 * HOUR; t += GMAIL_HISTORY_TICK_MS) {
        if (gmailPollDue({ now: t, key, healthy: true })) due.push(t);
      }
      expect(due.length).toBeGreaterThanOrEqual(7);
      expect(due.length).toBeLessThanOrEqual(9);
      for (let i = 1; i < due.length; i += 1) {
        const gap = due[i] - due[i - 1];
        expect(gap).toBeGreaterThanOrEqual(GMAIL_PUSH_FALLBACK_POLL_MS - GMAIL_HISTORY_TICK_MS);
        expect(gap).toBeLessThanOrEqual(GMAIL_PUSH_FALLBACK_POLL_MS + GMAIL_HISTORY_TICK_MS);
      }
    }
  });

  test('a fallback period not longer than the tick reads on each tick', () => {
    expect(gmailPollDue({ now: NOW, key: 'u:a', healthy: true, periodMs: 60_000, tickMs: 120_000 })).toBe(
      true,
    );
  });

  test('the calendar fallback poll is one hour', () => {
    expect(CALENDAR_PUSH_FALLBACK_POLL_MS).toBe(HOUR);
  });
});

describe('Drive page token', () => {
  test('reads the token of a changes or backfill cursor, also inside next and resume', () => {
    expect(drivePageToken({ phase: 'changes', token: 't1' })).toBe('t1');
    expect(drivePageToken({ phase: 'backfill', token: 't2', generation: 'g', page: 'p' })).toBe('t2');
    expect(drivePageToken({ pending: [{}], next: { phase: 'changes', token: 't3' } })).toBe('t3');
    expect(drivePageToken({ phase: 'reconcile', resume: { phase: 'changes', token: 't4' } })).toBe('t4');
    expect(drivePageToken({ phase: 'reconcile', resume: { next: { phase: 'changes', token: 't5' } } })).toBe(
      't5',
    );
  });

  test('a cursor without a Drive token gives nothing', () => {
    expect(drivePageToken(null)).toBeUndefined();
    expect(drivePageToken(undefined)).toBeUndefined();
    expect(drivePageToken({ url: 'https://graph.microsoft.com/v1.0/me/drive/root/delta' })).toBeUndefined();
    expect(drivePageToken({ phase: 'changes', token: '' })).toBeUndefined();
    expect(drivePageToken({ phase: 'other', token: 'x' })).toBeUndefined();
  });
});
