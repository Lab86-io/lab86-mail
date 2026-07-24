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
  test('creates exactly two daily alignment prompts and completes after both replies', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'native-push-secret';
    try {
      const t = convexTest(schema, convexModules);
      const first = await t.mutation(api.albatrossNotifications.ensureCheckin, {
        internalSecret: 'native-push-secret',
        userId: 'alignment_user',
        localDate: '2026-07-24',
        timezone: 'America/New_York',
      });
      expect(first.notificationIds).toHaveLength(2);
      const notifications = await t.run((ctx) =>
        ctx.db
          .query('albatrossNotifications')
          .withIndex('by_user', (q) => q.eq('userId', 'alignment_user'))
          .collect(),
      );
      expect(notifications.map((row) => row.title).sort()).toEqual([
        'What did you get done today?',
        'What do you want to get done tomorrow?',
      ]);
      expect(notifications.some((row) => row.deepLink.endsWith('prompt=reflection'))).toBe(true);
      expect(notifications.some((row) => row.deepLink.endsWith('prompt=tomorrow'))).toBe(true);

      const reflection = await t.mutation(api.albatrossNotifications.answerCheckin, {
        internalSecret: 'native-push-secret',
        userId: 'alignment_user',
        checkinId: first.checkin._id,
        promptKind: 'reflection',
        responseText: 'Shipped the notification flow.',
        completed: [],
      });
      expect(reflection.status).toBe('open');
      const tomorrow = await t.mutation(api.albatrossNotifications.answerCheckin, {
        internalSecret: 'native-push-secret',
        userId: 'alignment_user',
        checkinId: first.checkin._id,
        promptKind: 'tomorrow',
        responseText: 'Test APNs on the production phone.',
        completed: [],
      });
      expect(tomorrow.status).toBe('answered');

      const repeated = await t.mutation(api.albatrossNotifications.ensureCheckin, {
        internalSecret: 'native-push-secret',
        userId: 'alignment_user',
        localDate: '2026-07-24',
        timezone: 'America/New_York',
      });
      expect(repeated.notificationIds).toHaveLength(2);
      expect(
        await t.run((ctx) =>
          ctx.db
            .query('albatrossNotifications')
            .withIndex('by_user', (q) => q.eq('userId', 'alignment_user'))
            .collect(),
        ),
      ).toHaveLength(2);
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });

  test('keeps native alignment prompts queueable while honoring disabled in-app delivery', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'native-push-secret';
    try {
      const t = convexTest(schema, convexModules);
      const ts = Date.now();
      await t.run(async (ctx) => {
        await ctx.db.insert('albatrossNotificationPreferences', {
          userId: 'native_only_user',
          timezone: 'UTC',
          eveningCheckinEnabled: true,
          eveningCheckinLocalTime: '19:00',
          inAppEnabled: false,
          webPushEnabled: false,
          nativePushEnabled: true,
          morningBriefEnabled: true,
          emailFallbackEnabled: false,
          emailFallbackDelayMinutes: 90,
          createdAt: ts,
          updatedAt: ts,
        });
      });

      const checkin = await t.mutation(api.albatrossNotifications.ensureCheckin, {
        internalSecret: 'native-push-secret',
        userId: 'native_only_user',
        localDate: '2026-07-24',
        timezone: 'UTC',
      });
      expect(checkin.notificationIds).toHaveLength(2);
      expect(
        await t.run((ctx) =>
          ctx.db
            .query('notificationDeliveries')
            .withIndex('by_user', (q) => q.eq('userId', 'native_only_user'))
            .collect(),
        ),
      ).toHaveLength(0);
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });

  test('preserves an earlier reflection on completion-only updates and acts the direct dedupe row', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'native-push-secret';
    try {
      const t = convexTest(schema, convexModules);
      const created = await t.mutation(api.albatrossNotifications.ensureCheckin, {
        internalSecret: 'native-push-secret',
        userId: 'reflection_user',
        localDate: '2026-07-24',
        timezone: 'UTC',
      });
      await t.mutation(api.albatrossNotifications.answerCheckin, {
        internalSecret: 'native-push-secret',
        userId: 'reflection_user',
        checkinId: created.checkin._id,
        promptKind: 'reflection',
        responseText: 'I shipped the first pass.',
        completed: [],
      });
      await t.run(async (ctx) => {
        for (let index = 0; index < 25; index += 1) {
          await ctx.db.insert('albatrossNotifications', {
            userId: 'reflection_user',
            type: 'agent_error',
            title: `Later ${index}`,
            body: 'Noise after the check-in notification.',
            deepLink: '/activity',
            dedupeKey: `later:${index}`,
            status: 'queued',
            scheduledFor: Date.now(),
            createdAt: Date.now() + index,
            updatedAt: Date.now() + index,
          });
        }
      });
      await t.mutation(api.albatrossNotifications.answerCheckin, {
        internalSecret: 'native-push-secret',
        userId: 'reflection_user',
        checkinId: created.checkin._id,
        promptKind: 'reflection',
        responseText: '',
        completed: [{ kind: 'work', id: 'missing_work' }],
      });

      const state = await t.run(async (ctx) => {
        const row = await ctx.db.get(created.checkin._id);
        const notification = await ctx.db
          .query('albatrossNotifications')
          .withIndex('by_user_dedupe', (q) =>
            q.eq('userId', 'reflection_user').eq('dedupeKey', 'daily-checkin:2026-07-24:reflection'),
          )
          .unique();
        return { row, notification };
      });
      expect(state.row?.responseText).toBe('I shipped the first pass.');
      expect(state.notification?.status).toBe('acted');
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });

  test('queues one deduplicated brief-ready notification unless the morning preference is disabled', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'native-push-secret';
    try {
      const t = convexTest(schema, convexModules);
      const ts = Date.now();
      await t.run(async (ctx) => {
        await ctx.db.insert('albatrossNotificationPreferences', {
          userId: 'disabled_brief_user',
          timezone: 'UTC',
          eveningCheckinEnabled: true,
          eveningCheckinLocalTime: '19:00',
          inAppEnabled: true,
          webPushEnabled: false,
          nativePushEnabled: true,
          morningBriefEnabled: false,
          emailFallbackEnabled: false,
          emailFallbackDelayMinutes: 90,
          createdAt: ts,
          updatedAt: ts,
        });
      });
      expect(
        await t.mutation(api.albatrossNotifications.queueBriefReady, {
          internalSecret: 'native-push-secret',
          userId: 'disabled_brief_user',
          reportId: 'report_disabled',
          localDate: '2026-07-24',
        }),
      ).toMatchObject({ notificationId: null, created: false, skipped: 'disabled' });

      const created = await t.mutation(api.albatrossNotifications.queueBriefReady, {
        internalSecret: 'native-push-secret',
        userId: 'enabled_brief_user',
        reportId: 'report_1',
        localDate: '2026-07-24',
      });
      const duplicate = await t.mutation(api.albatrossNotifications.queueBriefReady, {
        internalSecret: 'native-push-secret',
        userId: 'enabled_brief_user',
        reportId: 'report_2',
        localDate: '2026-07-24',
      });
      expect(created.created).toBe(true);
      expect(duplicate).toMatchObject({ notificationId: created.notificationId, created: false });
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });

  test('removes stored brief coordinates when location sharing is disabled', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'native-push-secret';
    try {
      const t = convexTest(schema, convexModules);
      const base = {
        internalSecret: 'native-push-secret',
        userId: 'location_user',
        nativePushEnabled: true,
        newMailPushEnabled: true,
        eventSuggestionPushEnabled: true,
        morningBriefEnabled: true,
        eveningCheckinEnabled: true,
        eveningCheckinLocalTime: '19:00',
        inAppEnabled: true,
        emailFallbackEnabled: false,
        emailFallbackDelayMinutes: 90,
        timezone: 'America/New_York',
      };
      await t.mutation(api.albatrossNotifications.saveMobilePreferences, {
        ...base,
        briefLocationEnabled: true,
        briefLatitude: 43.15,
        briefLongitude: -77.62,
        briefLocationLabel: 'Rochester, New York',
      });
      await t.mutation(api.albatrossNotifications.saveMobilePreferences, {
        ...base,
        briefLocationEnabled: false,
      });
      const preferences = await t.query(api.albatrossNotifications.mobilePreferences, {
        internalSecret: 'native-push-secret',
        userId: 'location_user',
      });
      expect(preferences.briefLocationEnabled).toBe(false);
      expect(preferences.briefLatitude).toBeUndefined();
      expect(preferences.briefLongitude).toBeUndefined();
      expect(preferences.briefLocationLabel).toBeUndefined();
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });

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
