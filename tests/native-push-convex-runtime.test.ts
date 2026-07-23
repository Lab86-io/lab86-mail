import { describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import schema from '../convex/schema';

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/albatrossNotifications.ts': () => import('../convex/albatrossNotifications'),
  '../convex/accounts.ts': () => import('../convex/accounts'),
};

describe('native push Convex receipts', () => {
  test('persists one notification/device receipt and returns it through delivery context', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'native-push-secret';
    try {
      const t = convexTest(schema, convexModules);
      const ts = Date.now();
      const token = 'aa'.repeat(32);
      const expiredToken = 'bb'.repeat(32);
      const failedToken = 'cc'.repeat(32);
      const notificationId = await t.run(async (ctx) => {
        const id = await ctx.db.insert('albatrossNotifications', {
          userId: 'push_user',
          type: 'mail_message',
          title: 'Ari',
          body: 'Planning',
          deepLink: '/mail/thread?thread=thread_1',
          dedupeKey: 'mail:thread_1',
          status: 'queued',
          scheduledFor: ts,
          createdAt: ts,
          updatedAt: ts,
        });
        for (const [deviceToken, deviceId] of [
          [token, 'device_1'],
          [expiredToken, 'device_2'],
          [failedToken, 'device_3'],
        ]) {
          await ctx.db.insert('mobilePushDevices', {
            userId: 'push_user',
            platform: 'ios',
            token: deviceToken,
            deviceId,
            environment: 'production',
            status: 'active',
            createdAt: ts,
            updatedAt: ts,
          });
        }
        return id;
      });

      await t.mutation(api.albatrossNotifications.recordNativeDeviceDelivery, {
        internalSecret: 'native-push-secret',
        userId: 'push_user',
        notificationId,
        token,
        status: 'delivered',
        providerId: 'apns_1',
      });

      const context = await t.query(api.albatrossNotifications.nativeDeliveryContext, {
        internalSecret: 'native-push-secret',
        userId: 'push_user',
        notificationId,
      });
      expect(context?.nativeDeviceDeliveries).toHaveLength(1);
      expect(context?.nativeDeviceDeliveries[0]).toMatchObject({
        token,
        status: 'delivered',
        attemptCount: 1,
        providerId: 'apns_1',
      });
      const [device] = await t.run((ctx) =>
        ctx.db
          .query('mobilePushDevices')
          .withIndex('by_token', (q) => q.eq('token', token))
          .collect(),
      );
      expect(device.lastDeliveredAt).toBeGreaterThanOrEqual(ts);

      await expect(
        t.mutation(api.albatrossNotifications.recordNativeDeviceDelivery, {
          internalSecret: 'native-push-secret',
          userId: 'other_user',
          notificationId,
          token,
          status: 'expired',
        }),
      ).rejects.toThrow('Notification not found.');
      expect(await t.run((ctx) => ctx.db.query('nativePushDeliveries').collect())).toHaveLength(1);

      await t.mutation(api.albatrossNotifications.recordNativeDeviceDelivery, {
        internalSecret: 'native-push-secret',
        userId: 'push_user',
        notificationId,
        token: expiredToken,
        status: 'expired',
        error: 'Unregistered',
      });
      await t.mutation(api.albatrossNotifications.recordNativeDeviceDelivery, {
        internalSecret: 'native-push-secret',
        userId: 'push_user',
        notificationId,
        token: failedToken,
        status: 'failed',
        error: 'ServiceUnavailable',
      });
      const devices = await t.run((ctx) => ctx.db.query('mobilePushDevices').collect());
      expect(devices.find((row) => row.token === expiredToken)?.status).toBe('expired');
      expect(devices.find((row) => row.token === failedToken)?.status).toBe('active');
      expect(await t.run((ctx) => ctx.db.query('nativePushDeliveries').collect())).toHaveLength(3);
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });

  test('purges one user receipt set in bounded batches without touching another user', async () => {
    const t = convexTest(schema, convexModules);
    const ts = Date.now();
    await t.run(async (ctx) => {
      for (let index = 0; index < 251; index += 1) {
        const notificationId = await ctx.db.insert('albatrossNotifications', {
          userId: 'purge_user',
          type: 'mail_message',
          title: 'Mail',
          body: 'Update',
          deepLink: `/mail/thread?thread=${index}`,
          dedupeKey: `mail:${index}`,
          status: 'queued',
          scheduledFor: ts,
          createdAt: ts,
          updatedAt: ts,
        });
        await ctx.db.insert('nativePushDeliveries', {
          userId: 'purge_user',
          notificationId,
          token: `${index}`.padStart(64, '0'),
          status: 'delivered',
          attemptCount: 1,
          createdAt: ts,
          updatedAt: ts,
        });
      }
      const otherNotificationId = await ctx.db.insert('albatrossNotifications', {
        userId: 'other_user',
        type: 'mail_message',
        title: 'Other mail',
        body: 'Update',
        deepLink: '/mail/thread?thread=other',
        dedupeKey: 'mail:other',
        status: 'queued',
        scheduledFor: ts,
        createdAt: ts,
        updatedAt: ts,
      });
      await ctx.db.insert('nativePushDeliveries', {
        userId: 'other_user',
        notificationId: otherNotificationId,
        token: 'ff'.repeat(32),
        status: 'delivered',
        attemptCount: 1,
        createdAt: ts,
        updatedAt: ts,
      });
    });

    expect(await t.mutation(internal.accounts.purgeUserDataBatch, { userId: 'purge_user' })).toEqual({
      deleted: 250,
    });
    let receipts = await t.run((ctx) => ctx.db.query('nativePushDeliveries').collect());
    expect(receipts.filter((receipt) => receipt.userId === 'purge_user')).toHaveLength(1);
    expect(receipts.filter((receipt) => receipt.userId === 'other_user')).toHaveLength(1);

    expect(await t.mutation(internal.accounts.purgeUserDataBatch, { userId: 'purge_user' })).toEqual({
      deleted: 1,
    });
    receipts = await t.run((ctx) => ctx.db.query('nativePushDeliveries').collect());
    expect(receipts.map((receipt) => receipt.userId)).toEqual(['other_user']);
  });
});
