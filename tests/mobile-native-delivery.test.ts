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
    nativeDeviceDeliveries: [],
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
      {
        userId: 'user-1',
        notificationId: 'notice-1',
        token: devices[0].token,
        status: 'delivered',
        providerId: 'apns-1',
        error: undefined,
      },
      {
        userId: 'user-1',
        notificationId: 'notice-1',
        token: devices[1].token,
        status: 'delivered',
        providerId: 'apns-2',
        error: undefined,
      },
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
      {
        userId: 'user-1',
        notificationId: 'notice-1',
        token: devices[0].token,
        status: 'expired',
        providerId: undefined,
        error: 'APNs rejected the notification: Unregistered.',
      },
      {
        userId: 'user-1',
        notificationId: 'notice-1',
        token: devices[1].token,
        status: 'delivered',
        providerId: 'apns-ok',
        error: undefined,
      },
      expect.objectContaining({
        channel: 'native_push',
        status: 'sent',
        providerId: 'apns-ok',
        error: undefined,
      }),
    ]);
  });

  test('a partial transient failure retries only the unresolved device', async () => {
    const devices = [
      { token: 'aa'.repeat(32), environment: 'production' as const },
      { token: 'bb'.repeat(32), environment: 'production' as const },
    ];
    const receipts: Array<{ token: string; status: 'delivered' | 'expired' | 'failed' }> = [];
    const sends: string[] = [];
    let secondDeviceAttempt = 0;
    const { deps } = makeDependencies({
      query: async () =>
        context({
          mobileDevices: devices,
          deliveries: [{ channel: 'native_push', status: 'failed' }],
          nativeDeviceDeliveries: receipts,
        }),
      mutate: async (_fn: unknown, args: Record<string, unknown>) => {
        if (typeof args.token === 'string' && typeof args.status === 'string') {
          const existing = receipts.find((receipt) => receipt.token === args.token);
          const status = args.status as 'delivered' | 'expired' | 'failed';
          if (existing) existing.status = status;
          else receipts.push({ token: args.token, status });
        }
        return null;
      },
      send: async (_envelope: unknown, device: { token: string }) => {
        sends.push(device.token);
        if (device.token === devices[1].token && secondDeviceAttempt++ === 0) {
          throw new APNsDeliveryError(
            'APNs rejected the notification: ServiceUnavailable.',
            503,
            'ServiceUnavailable',
          );
        }
        return { providerId: `apns-${sends.length}` };
      },
    });

    expect(await dispatchNativeNotification('user-1', 'notice-1', deps)).toEqual({
      sent: 1,
      failed: 1,
    });
    expect(await dispatchNativeNotification('user-1', 'notice-1', deps)).toEqual({
      sent: 1,
      failed: 0,
    });
    expect(sends).toEqual([devices[0].token, devices[1].token, devices[1].token]);
  });

  test('a device-state persistence failure is reported without aborting the remaining fanout', async () => {
    const devices = [
      { token: 'aa'.repeat(32), environment: 'production' as const },
      { token: 'bb'.repeat(32), environment: 'production' as const },
    ];
    const mutations: Array<Record<string, unknown>> = [];
    const { deps, sends } = makeDependencies({
      query: async () => context({ mobileDevices: devices }),
      mutate: async (_fn: unknown, args: Record<string, unknown>) => {
        if (args.token === devices[0].token) throw new Error('device write unavailable');
        mutations.push(args);
        return null;
      },
    });

    const result = await dispatchNativeNotification('user-1', 'notice-1', deps);

    expect(result).toEqual({ sent: 1, failed: 1 });
    expect(sends).toEqual(devices);
    expect(mutations).toEqual([
      {
        userId: 'user-1',
        notificationId: 'notice-1',
        token: devices[1].token,
        status: 'delivered',
        providerId: 'apns-2',
        error: undefined,
      },
      expect.objectContaining({
        channel: 'native_push',
        status: 'failed',
        error: 'Could not persist delivered device receipt: device write unavailable',
      }),
    ]);
  });

  test('an invalid-token persistence failure remains retryable instead of escaping the dispatch', async () => {
    const mutations: Array<Record<string, unknown>> = [];
    const { deps } = makeDependencies({
      mutate: async (_fn: unknown, args: Record<string, unknown>) => {
        if (args.status === 'expired') throw new Error('device expiry unavailable');
        mutations.push(args);
        return null;
      },
    });
    deps.send = async () => {
      throw new APNsDeliveryError('APNs rejected the notification: Unregistered.', 410, 'Unregistered');
    };

    const result = await dispatchNativeNotification('user-1', 'notice-1', deps);

    expect(result).toEqual({ sent: 0, failed: 1 });
    expect(mutations).toEqual([
      expect.objectContaining({
        channel: 'native_push',
        status: 'failed',
        error: expect.stringContaining('Could not persist expired device receipt: device expiry unavailable'),
      }),
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
        token: 'aa'.repeat(32),
        status: 'failed',
        providerId: undefined,
        error: 'APNs rejected the notification: ServiceUnavailable.',
      },
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

  test('all expired devices produce a failed aggregate rather than a false sent state', async () => {
    const { deps, mutations } = makeDependencies();
    deps.send = async () => {
      throw new APNsDeliveryError('APNs rejected the notification: Unregistered.', 410, 'Unregistered');
    };

    const result = await dispatchNativeNotification('user-1', 'notice-1', deps);

    expect(result).toEqual({ sent: 0, failed: 1 });
    expect(mutations).toEqual([
      expect.objectContaining({ token: 'aa'.repeat(32), status: 'expired' }),
      expect.objectContaining({
        channel: 'native_push',
        status: 'failed',
        error: 'APNs rejected the notification: Unregistered.',
      }),
    ]);
  });

  test('a retry with only expired receipts keeps the aggregate failed without resending', async () => {
    const token = 'aa'.repeat(32);
    const { deps, mutations, sends } = makeDependencies({
      query: async () =>
        context({
          nativeDeviceDeliveries: [{ token, status: 'expired' }],
        }),
    });

    const result = await dispatchNativeNotification('user-1', 'notice-1', deps);

    expect(result).toEqual({ sent: 0, failed: 1 });
    expect(sends).toEqual([]);
    expect(mutations).toEqual([
      {
        userId: 'user-1',
        notificationId: 'notice-1',
        channel: 'native_push',
        status: 'failed',
        error: 'All registered devices are expired.',
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
    expect(mutations).toEqual([
      expect.objectContaining({ token: 'aa'.repeat(32), status: 'failed', error: 'socket hang up' }),
      expect.objectContaining({ channel: 'native_push', status: 'failed', error: 'socket hang up' }),
    ]);
  });
});
