import { describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import schema from '../convex/schema';

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/albatrossNotifications.ts': () => import('../convex/albatrossNotifications'),
  '../convex/albatrossIntents.ts': () => import('../convex/albatrossIntents'),
  '../convex/albatrossWorkV2.ts': () => import('../convex/albatrossWorkV2'),
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

      await t.run(async (ctx) => {
        const preference = await ctx.db
          .query('albatrossNotificationPreferences')
          .withIndex('by_user', (q) => q.eq('userId', 'native_only_user'))
          .unique();
        if (!preference) throw new Error('Missing test preference.');
        await ctx.db.patch(preference._id, { inAppEnabled: true, updatedAt: Date.now() });
      });
      await t.mutation(api.albatrossNotifications.ensureCheckin, {
        internalSecret: 'native-push-secret',
        userId: 'native_only_user',
        localDate: '2026-07-24',
        timezone: 'UTC',
      });
      await t.mutation(api.albatrossNotifications.ensureCheckin, {
        internalSecret: 'native-push-secret',
        userId: 'native_only_user',
        localDate: '2026-07-24',
        timezone: 'UTC',
      });
      const restored = await t.run(async (ctx) => {
        const deliveries = await ctx.db
          .query('notificationDeliveries')
          .withIndex('by_user', (q) => q.eq('userId', 'native_only_user'))
          .collect();
        const notifications = await ctx.db
          .query('albatrossNotifications')
          .withIndex('by_user', (q) => q.eq('userId', 'native_only_user'))
          .collect();
        return { deliveries, notifications };
      });
      expect(restored.deliveries).toHaveLength(2);
      expect(restored.notifications.every((notification) => notification.status === 'delivered')).toBe(true);
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
      const workIds = await t.run(async (ctx) => {
        const ts = Date.parse('2026-07-24T12:00:00.000Z');
        return Promise.all(
          ['First reconciled work', 'Second reconciled work'].map((title) =>
            ctx.db.insert('albatrossIntents', {
              userId: 'reflection_user',
              rawText: title,
              source: 'text',
              title,
              status: 'ready',
              workState: 'active',
              agentState: 'idle',
              createdAt: ts,
              updatedAt: ts,
            }),
          ),
        );
      });
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
        completed: [{ kind: 'work', id: String(workIds[0]) }],
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
        completed: [{ kind: 'work', id: String(workIds[1]) }],
      });
      await t.mutation(api.albatrossNotifications.answerCheckin, {
        internalSecret: 'native-push-secret',
        userId: 'reflection_user',
        checkinId: created.checkin._id,
        promptKind: 'tomorrow',
        responseText: 'I will validate the production build.',
        completed: [],
      });
      await t.mutation(api.albatrossNotifications.answerCheckin, {
        internalSecret: 'native-push-secret',
        userId: 'reflection_user',
        checkinId: created.checkin._id,
        promptKind: 'tomorrow',
        responseText: '',
        completed: [{ kind: 'work', id: 'ignored_for_tomorrow' }],
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
      expect(state.row?.tomorrowIntentText).toBe('I will validate the production build.');
      expect(state.row?.reconciledChanges?.map((change) => change.id)).toEqual(workIds.map(String));
      expect(state.row?.reflectionReconcileStatus).toBe('pending');
      expect(state.row?.tomorrowPlanStatus).toBe('pending');
      expect(state.notification?.status).toBe('acted');
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });

  test('reconciles a unique free-form reflection match into durable source completion', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'native-push-secret';
    try {
      const t = convexTest(schema, convexModules);
      const workId = await t.run((ctx) => {
        // The unresolved Work predates the check-in day. It must still be in
        // the reconciliation corpus so free-form reflection can retire it.
        const ts = Date.parse('2026-05-01T12:00:00.000Z');
        return ctx.db.insert('albatrossIntents', {
          userId: 'freeform_reflection_user',
          rawText: 'Ship notification flow',
          source: 'text',
          title: 'Ship notification flow',
          status: 'ready',
          workState: 'active',
          agentState: 'idle',
          createdAt: ts,
          updatedAt: ts,
        });
      });
      const created = await t.mutation(api.albatrossNotifications.ensureCheckin, {
        internalSecret: 'native-push-secret',
        userId: 'freeform_reflection_user',
        localDate: '2026-07-25',
        timezone: 'UTC',
      });
      const result = await t.mutation(api.albatrossNotifications.answerCheckin, {
        internalSecret: 'native-push-secret',
        userId: 'freeform_reflection_user',
        checkinId: created.checkin._id,
        promptKind: 'reflection',
        responseText: 'I shipped the notification flow today.',
        completed: [],
      });
      expect(result.matchedByReflection).toEqual([{ kind: 'work', id: String(workId) }]);

      const state = await t.run(async (ctx) => ({
        work: await ctx.db.get(workId),
        checkin: await ctx.db.get(created.checkin._id),
      }));
      expect(state.work?.workState).toBe('done');
      expect(state.work?.status).toBe('done');
      expect(state.checkin?.reconciledChanges?.map((change) => change.id)).toEqual([String(workId)]);
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });

  test('keeps an older card that was recently updated inside the bounded reflection corpus', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'native-push-secret';
    try {
      const t = convexTest(schema, convexModules);
      const targetCardId = await t.run(async (ctx) => {
        const old = Date.parse('2026-05-01T12:00:00.000Z');
        const recent = Date.parse('2026-07-25T18:00:00.000Z');
        const boardId = await ctx.db.insert('boards', {
          ownerUserId: 'recent_card_user',
          title: 'Reflection candidates',
          createdAt: old,
          updatedAt: recent,
        });
        const columnId = await ctx.db.insert('boardColumns', {
          boardId,
          name: 'Doing',
          order: 0,
          createdAt: old,
          updatedAt: recent,
        });
        const target = await ctx.db.insert('cards', {
          boardId,
          columnId,
          userId: 'recent_card_user',
          title: 'Recently updated old task',
          order: 0,
          createdAt: old,
          updatedAt: recent,
        });
        for (let index = 0; index < 205; index += 1) {
          await ctx.db.insert('cards', {
            boardId,
            columnId,
            userId: 'recent_card_user',
            title: `Older noise ${index}`,
            order: index + 1,
            createdAt: old + index,
            updatedAt: old + index,
          });
        }
        return target;
      });

      const created = await t.mutation(api.albatrossNotifications.ensureCheckin, {
        internalSecret: 'native-push-secret',
        userId: 'recent_card_user',
        localDate: '2026-07-25',
        timezone: 'UTC',
      });
      expect(created.checkin.candidateItems).toContainEqual(
        expect.objectContaining({ kind: 'task', id: String(targetCardId) }),
      );
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

      await t.run(async (ctx) => {
        await ctx.db.insert('albatrossNotificationPreferences', {
          userId: 'brief_toggle_user',
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
      const hidden = await t.mutation(api.albatrossNotifications.queueBriefReady, {
        internalSecret: 'native-push-secret',
        userId: 'brief_toggle_user',
        reportId: 'report_hidden',
        localDate: '2026-07-24',
      });
      const hiddenState = await t.run(async (ctx) => {
        const notification = await ctx.db.get(hidden.notificationId!);
        const deliveries = await ctx.db
          .query('notificationDeliveries')
          .withIndex('by_notification', (q) => q.eq('notificationId', hidden.notificationId!))
          .collect();
        return { notification, deliveries };
      });
      expect(hiddenState.notification?.status).toBe('queued');
      expect(hiddenState.deliveries).toHaveLength(0);
      await t.run(async (ctx) => {
        const preference = await ctx.db
          .query('albatrossNotificationPreferences')
          .withIndex('by_user', (q) => q.eq('userId', 'brief_toggle_user'))
          .unique();
        if (!preference) throw new Error('Missing test preference.');
        await ctx.db.patch(preference._id, { inAppEnabled: true, updatedAt: Date.now() });
      });
      const restoredBrief = await t.mutation(api.albatrossNotifications.queueBriefReady, {
        internalSecret: 'native-push-secret',
        userId: 'brief_toggle_user',
        reportId: 'report_hidden',
        localDate: '2026-07-24',
      });
      const briefState = await t.run(async (ctx) => {
        const notification = await ctx.db.get(hidden.notificationId!);
        const deliveries = await ctx.db
          .query('notificationDeliveries')
          .withIndex('by_notification', (q) => q.eq('notificationId', hidden.notificationId!))
          .collect();
        return { notification, deliveries };
      });
      expect(restoredBrief).toMatchObject({ notificationId: hidden.notificationId, created: false });
      expect(briefState.notification?.status).toBe('delivered');
      expect(briefState.deliveries.filter((delivery) => delivery.channel === 'in_app')).toHaveLength(1);
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
        briefLocationEnabled: true,
        briefLocationLabel: 'Rochester, NY',
      });
      const resaved = await t.query(api.albatrossNotifications.mobilePreferences, {
        internalSecret: 'native-push-secret',
        userId: 'location_user',
      });
      expect(resaved.briefLatitude).toBe(43.15);
      expect(resaved.briefLongitude).toBe(-77.62);
      expect(resaved.briefLocationLabel).toBe('Rochester, NY');
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

  test('leases, retries, and completes independently saved check-in work', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'native-push-secret';
    try {
      const t = convexTest(schema, convexModules);
      const created = await t.mutation(api.albatrossNotifications.ensureCheckin, {
        internalSecret: 'native-push-secret',
        userId: 'background_checkin_user',
        localDate: '2026-08-15',
        timezone: 'America/New_York',
      });
      await t.mutation(api.albatrossNotifications.answerCheckin, {
        internalSecret: 'native-push-secret',
        userId: 'background_checkin_user',
        checkinId: created.checkin._id,
        promptKind: 'reflection',
        responseText: 'I finished the application.',
        completed: [],
      });
      await t.run((ctx) =>
        ctx.db.patch(created.checkin._id, {
          reconciledChanges: Array.from({ length: 125 }, (_, index) => ({
            kind: 'work',
            id: `history-${index}`,
          })),
        }),
      );
      await t.mutation(api.albatrossNotifications.answerCheckin, {
        internalSecret: 'native-push-secret',
        userId: 'background_checkin_user',
        checkinId: created.checkin._id,
        promptKind: 'reflection',
        responseText: 'I finished the application.',
        completed: [],
      });
      const boundedHistory = await t.run((ctx) => ctx.db.get(created.checkin._id));
      expect(boundedHistory?.reconciledChanges).toHaveLength(120);
      expect(boundedHistory?.reconciledChanges?.[0]?.id).toBe('history-5');
      await t.mutation(api.albatrossNotifications.answerCheckin, {
        internalSecret: 'native-push-secret',
        userId: 'background_checkin_user',
        checkinId: created.checkin._id,
        promptKind: 'tomorrow',
        responseText: 'Call the DMV.',
        completed: [],
      });

      const reflectionCandidates = await t.query(
        internal.albatrossNotifications.reflectionReconcileCandidates,
        {},
      );
      const tomorrowCandidates = await t.query(internal.albatrossNotifications.tomorrowPlanCandidates, {});
      expect(reflectionCandidates.map((row) => row._id)).toContain(created.checkin._id);
      expect(tomorrowCandidates.map((row) => row._id)).toContain(created.checkin._id);

      const reflectionClaim = await t.mutation(internal.albatrossNotifications.beginReflectionReconcile, {
        checkinId: created.checkin._id,
      });
      const tomorrowClaim = await t.mutation(internal.albatrossNotifications.beginTomorrowPlan, {
        checkinId: created.checkin._id,
      });
      expect(reflectionClaim?.responseText).toBe('I finished the application.');
      expect(tomorrowClaim?.tomorrowIntentText).toBe('Call the DMV.');
      expect(
        await t.mutation(internal.albatrossNotifications.beginReflectionReconcile, {
          checkinId: created.checkin._id,
        }),
      ).toBeNull();

      await t.mutation(api.albatrossNotifications.completeReflectionReconcile, {
        internalSecret: 'native-push-secret',
        userId: 'background_checkin_user',
        checkinId: created.checkin._id,
        completed: [],
      });
      const failed = await t.mutation(api.albatrossNotifications.failTomorrowPlan, {
        internalSecret: 'native-push-secret',
        userId: 'background_checkin_user',
        checkinId: created.checkin._id,
        error: 'Planner unavailable.',
      });
      expect(failed.retrying).toBe(true);
      const failedTomorrow = await t.run((ctx) => ctx.db.get(created.checkin._id));
      expect(Number(failedTomorrow?.tomorrowPlanNextAt) - Number(failedTomorrow?.updatedAt)).toBe(120_000);

      const workId = await t.run((ctx) =>
        ctx.db.insert('albatrossIntents', {
          userId: 'background_checkin_user',
          rawText: 'Call the DMV.',
          source: 'text',
          title: 'Call the DMV',
          status: 'ready',
          workState: 'active',
          agentState: 'idle',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
      await t.run((ctx) => ctx.db.patch(created.checkin._id, { tomorrowPlanNextAt: 0 }));
      expect(
        await t.mutation(internal.albatrossNotifications.beginTomorrowPlan, {
          checkinId: created.checkin._id,
        }),
      ).not.toBeNull();
      await t.mutation(api.albatrossNotifications.completeTomorrowPlan, {
        internalSecret: 'native-push-secret',
        userId: 'background_checkin_user',
        checkinId: created.checkin._id,
        workId,
        status: 'ready',
      });

      const releasable = await t.mutation(api.albatrossNotifications.ensureCheckin, {
        internalSecret: 'native-push-secret',
        userId: 'background_checkin_user',
        localDate: '2026-08-16',
        timezone: 'America/New_York',
      });
      for (const [promptKind, responseText] of [
        ['reflection', 'I finished another thing.'],
        ['tomorrow', 'Prepare the receipt.'],
      ] as const) {
        await t.mutation(api.albatrossNotifications.answerCheckin, {
          internalSecret: 'native-push-secret',
          userId: 'background_checkin_user',
          checkinId: releasable.checkin._id,
          promptKind,
          responseText,
          completed: [],
        });
      }
      await t.mutation(internal.albatrossNotifications.beginReflectionReconcile, {
        checkinId: releasable.checkin._id,
      });
      await t.mutation(internal.albatrossNotifications.beginTomorrowPlan, {
        checkinId: releasable.checkin._id,
      });
      await t.mutation(internal.albatrossNotifications.releaseReflectionReconcile, {
        checkinId: releasable.checkin._id,
      });
      await t.mutation(internal.albatrossNotifications.releaseTomorrowPlan, {
        checkinId: releasable.checkin._id,
      });
      const released = await t.run((ctx) => ctx.db.get(releasable.checkin._id));
      expect(released?.reflectionReconcileStatus).toBe('failed');
      expect(released?.tomorrowPlanStatus).toBe('failed');
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });

  test('dedupes conductor notices and leases new Work evidence', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'native-push-secret';
    try {
      const t = convexTest(schema, convexModules);
      const notice = {
        userId: 'conductor_user',
        workId: 'work-notice',
        title: 'That block passed',
        body: 'Choose what happens next.',
        dedupeKey: 'missed-move:work-notice:1',
      };
      const firstNotice = await t.mutation(internal.albatrossNotifications.queueWorkConductorNotice, notice);
      const secondNotice = await t.mutation(internal.albatrossNotifications.queueWorkConductorNotice, notice);
      expect(firstNotice.created).toBe(true);
      expect(secondNotice.created).toBe(false);

      const evidenceAt = Date.now() - 1_000;
      const workId = await t.run((ctx) =>
        ctx.db.insert('albatrossIntents', {
          userId: 'conductor_user',
          rawText: 'Renew passport',
          source: 'text',
          title: 'Renew passport',
          status: 'ready',
          workState: 'active',
          agentState: 'idle',
          lastEvidenceAt: evidenceAt,
          createdAt: evidenceAt - 1_000,
          updatedAt: evidenceAt,
        }),
      );
      const candidates = await t.query(internal.albatrossWorkV2.evidenceReconcileCandidates, {});
      expect(candidates.map((row) => row._id)).toContain(workId);
      const claim = await t.mutation(internal.albatrossWorkV2.beginEvidenceReconcile, { workId });
      expect(claim?.evidenceAt).toBe(evidenceAt);
      expect(await t.mutation(internal.albatrossWorkV2.beginEvidenceReconcile, { workId })).toBeNull();
      await t.mutation(api.albatrossWorkV2.completeEvidenceReconcile, {
        internalSecret: 'native-push-secret',
        userId: 'conductor_user',
        workId,
        evidenceAt,
      });
      await t.run((ctx) => ctx.db.patch(workId, { lastEvidenceAt: evidenceAt + 2_000 }));
      expect(await t.mutation(internal.albatrossWorkV2.beginEvidenceReconcile, { workId })).not.toBeNull();
      await t.mutation(internal.albatrossWorkV2.releaseEvidenceReconcile, { workId });
      const work = await t.run((ctx) => ctx.db.get(workId));
      expect(work?.evidenceReconcileClaimedAt).toBeUndefined();
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });

  test('updates the same tomorrow Work and reports whether its words changed', async () => {
    const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = 'native-push-secret';
    try {
      const t = convexTest(schema, convexModules);
      const first = await t.mutation(api.albatrossIntents.createIntent, {
        internalSecret: 'native-push-secret',
        userId: 'tomorrow_work_user',
        externalId: 'checkin:one:tomorrow',
        rawText: 'Call the DMV.',
        source: 'text',
        replaceRawText: true,
        returnMetadata: true,
      });
      if (typeof first === 'string') throw new Error('Expected create metadata.');
      expect(first.changed).toBe(true);
      const same = await t.mutation(api.albatrossIntents.createIntent, {
        internalSecret: 'native-push-secret',
        userId: 'tomorrow_work_user',
        externalId: 'checkin:one:tomorrow',
        rawText: 'Call the DMV.',
        source: 'text',
        replaceRawText: true,
        returnMetadata: true,
      });
      const changed = await t.mutation(api.albatrossIntents.createIntent, {
        internalSecret: 'native-push-secret',
        userId: 'tomorrow_work_user',
        externalId: 'checkin:one:tomorrow',
        rawText: 'Call the county clerk.',
        source: 'text',
        replaceRawText: true,
        returnMetadata: true,
      });
      if (typeof same === 'string' || typeof changed === 'string')
        throw new Error('Expected update metadata.');
      expect(same).toMatchObject({ workId: first.workId, changed: false });
      expect(changed).toMatchObject({ workId: first.workId, changed: true });
      const work = await t.run((ctx) => ctx.db.get(first.workId));
      expect(work?.rawText).toBe('Call the county clerk.');

      await t.run((ctx) =>
        ctx.db.patch(first.workId, {
          status: 'archived',
          workState: 'active',
          releaseReason: 'No longer needed.',
          releaseProposedBy: 'user',
          releasedAt: 10,
          reviewAt: 20,
        }),
      );
      await t.mutation(api.albatrossIntents.createIntent, {
        internalSecret: 'native-push-secret',
        userId: 'tomorrow_work_user',
        externalId: 'checkin:one:tomorrow',
        rawText: 'Revive the archived status.',
        source: 'text',
        replaceRawText: true,
      });
      let revived = await t.run((ctx) => ctx.db.get(first.workId));
      expect(revived).toMatchObject({ status: 'ready', workState: 'active' });
      expect(revived?.releaseReason).toBeUndefined();
      expect(revived?.releasedAt).toBeUndefined();

      await t.run((ctx) =>
        ctx.db.patch(first.workId, {
          status: 'ready',
          workState: 'archived',
          releaseReason: 'Archived separately.',
          releaseProposedBy: 'system',
          releasedAt: 30,
          reviewAt: 40,
        }),
      );
      await t.mutation(api.albatrossIntents.createIntent, {
        internalSecret: 'native-push-secret',
        userId: 'tomorrow_work_user',
        externalId: 'checkin:one:tomorrow',
        rawText: 'Revive the archived Work state.',
        source: 'text',
        replaceRawText: true,
      });
      revived = await t.run((ctx) => ctx.db.get(first.workId));
      expect(revived).toMatchObject({ status: 'ready', workState: 'active' });
      expect(revived?.releaseProposedBy).toBeUndefined();
      expect(revived?.reviewAt).toBeUndefined();
    } finally {
      if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
    }
  });
});
