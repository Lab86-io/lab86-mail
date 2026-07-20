import { describe, expect, test } from 'bun:test';
import { APNsDeliveryError } from '../lib/notifications/apns';
import { dispatchNativeNotification } from '../lib/notifications/native-delivery';

const notification = {
  _id: 'notice-1',
  userId: 'user-1',
  title: 'What did you get done today?',
  body: 'Three things may have moved.',
  deepLink: '/?checkin=checkin_1',
  type: 'daily_checkin',
};

function context(overrides: Record<string, unknown> = {}) {
  return {
    notification,
    mobileDevices: [{ token: 'aa'.repeat(32), environment: 'production' as const }],
    deliveries: [],
    preference: null,
    ...overrides,
  };
}

function makeDependencies(overrides: Record<string, unknown> = {}) {
  const mutations: Array<Record<string, unknown>> = [];
  const sends: Array<Record<string, unknown>> = [];
  const deps = {
    query: async () => context(),
    mutate: async (_fn: unknown, args: Record<string, unknown>) => {
      mutations.push(args);
      return null;
    },
    send: async (_envelope: unknown, device: Record<string, unknown>) => {
      sends.push(device);
      return { providerId: `apns-${sends.length}` };
    },
    ...overrides,
  } as any;
  return { deps, mutations, sends };
}

describe('dispatchNativeNotification', () => {
  test('skips silently when the notification no longer exists', async () => {
    const { deps, mutations } = makeDependencies({ query: async () => null });

    const result = await dispatchNativeNotification('user-1', 'notice-1', deps);

    expect(result).toEqual({ sent: 0, failed: 0, skipped: 'not_found' });
    expect(mutations).toEqual([]);
  });

  test('honors the user preference gate before touching any device', async () => {
    const { deps, mutations, sends } = makeDependencies({
      query: async () =>
        context({
          notification: { ...notification, type: 'mail_message' },
          preference: { newMailPushEnabled: false },
        }),
    });

    const result = await dispatchNativeNotification('user-1', 'notice-1', deps);

    expect(result).toEqual({ sent: 0, failed: 0, skipped: 'new_mail_disabled' });
    expect(sends).toEqual([]);
    expect(mutations).toEqual([]);
  });

  test('a global native-push opt-out suppresses every notification class', async () => {
    const { deps } = makeDependencies({
      query: async () => context({ preference: { nativePushEnabled: false } }),
    });

    expect(await dispatchNativeNotification('user-1', 'notice-1', deps)).toEqual({
      sent: 0,
      failed: 0,
      skipped: 'native_push_disabled',
    });
  });

  test('never double-sends a notification that already has a sent native delivery', async () => {
    const { deps, sends } = makeDependencies({
      query: async () =>
        context({
          deliveries: [
            { channel: 'email', status: 'sent' },
            { channel: 'native_push', status: 'sent' },
          ],
        }),
    });

    expect(await dispatchNativeNotification('user-1', 'notice-1', deps)).toEqual({
      sent: 0,
      failed: 0,
      skipped: 'already_sent',
    });
    expect(sends).toEqual([]);
  });

  test('a failed prior native delivery does not block a retry', async () => {
    const { deps } = makeDependencies({
      query: async () => context({ deliveries: [{ channel: 'native_push', status: 'failed' }] }),
    });

    expect(await dispatchNativeNotification('user-1', 'notice-1', deps)).toEqual({ sent: 1, failed: 0 });
  });

  test('skips users with no registered devices', async () => {
    const { deps } = makeDependencies({ query: async () => context({ mobileDevices: [] }) });

    expect(await dispatchNativeNotification('user-1', 'notice-1', deps)).toEqual({
      sent: 0,
      failed: 0,
      skipped: 'no_devices',
    });
  });

  test('fans out to every device and records one sent delivery with joined provider ids', async () => {
    const devices = [
      { token: 'aa'.repeat(32), environment: 'production' as const },
      { token: 'bb'.repeat(32), environment: 'development' as const },
    ];
    const envelopes: Array<Record<string, unknown>> = [];
    const { deps, mutations, sends } = makeDependencies({
      query: async () => context({ mobileDevices: devices }),
    });
    deps.send = async (envelope: Record<string, unknown>, device: Record<string, unknown>) => {
      envelopes.push(envelope);
      sends.push(device);
      return { providerId: `apns-${sends.length}` };
    };

    const result = await dispatchNativeNotification('user-1', 'notice-1', deps);

    expect(result).toEqual({ sent: 2, failed: 0 });
    expect(sends).toEqual(devices);
    expect(envelopes[0]).toEqual({
      id: 'notice-1',
      userId: 'user-1',
      title: notification.title,
      body: notification.body,
      deepLink: notification.deepLink,
    });
    expect(mutations).toEqual([
      { token: devices[0].token, status: 'delivered' },
      { token: devices[1].token, status: 'delivered' },
      {
        userId: 'user-1',
        notificationId: 'notice-1',
        channel: 'native_push',
        status: 'sent',
        providerId: 'apns-1,apns-2',
        error: undefined,
      },
    ]);
  });

  test('prunes expired tokens on unregistered-device rejections while other devices still deliver', async () => {
    const devices = [
      { token: 'aa'.repeat(32), environment: 'production' as const },
      { token: 'bb'.repeat(32), environment: 'production' as const },
    ];
    const { deps, mutations } = makeDependencies({
      query: async () => context({ mobileDevices: devices }),
    });
    deps.send = async (_envelope: unknown, device: { token: string }) => {
      if (device.token === devices[0].token) {
        throw new APNsDeliveryError('APNs rejected the notification: Unregistered.', 410, 'Unregistered');
      }
      return { providerId: 'apns-ok' };
    };

    const result = await dispatchNativeNotification('user-1', 'notice-1', deps);

    expect(result).toEqual({ sent: 1, failed: 1 });
    expect(mutations).toEqual([
      { token: devices[0].token, status: 'expired' },
      { token: devices[1].token, status: 'delivered' },
      expect.objectContaining({ channel: 'native_push', status: 'sent', providerId: 'apns-ok' }),
    ]);
  });

  test('transient APNs failures record a failed delivery without pruning the token', async () => {
    const { deps, mutations } = makeDependencies();
    deps.send = async () => {
      throw new APNsDeliveryError(
        'APNs rejected the notification: ServiceUnavailable.',
        503,
        'ServiceUnavailable',
      );
    };

    const result = await dispatchNativeNotification('user-1', 'notice-1', deps);

    expect(result).toEqual({ sent: 0, failed: 1 });
    expect(mutations).toEqual([
      {
        userId: 'user-1',
        notificationId: 'notice-1',
        channel: 'native_push',
        status: 'failed',
        providerId: undefined,
        error: 'APNs rejected the notification: ServiceUnavailable.',
      },
    ]);
  });

  test('non-Error rejections are stringified into the recorded failure', async () => {
    const { deps, mutations } = makeDependencies();
    deps.send = async () => {
      throw 'socket hang up';
    };

    const result = await dispatchNativeNotification('user-1', 'notice-1', deps);

    expect(result).toEqual({ sent: 0, failed: 1 });
    expect(mutations[0]).toMatchObject({ status: 'failed', error: 'socket hang up' });
  });
});
