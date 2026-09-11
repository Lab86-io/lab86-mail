import { describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/albatrossNotifications.ts': () => import('../convex/albatrossNotifications'),
};

describe('notification read state at the mutation boundary', () => {
  for (const status of ['acted', 'dismissed', 'expired', 'read'] as const) {
    test(`late reads do not downgrade ${status} or rewrite its timestamps`, async () => {
      const t = convexTest(schema, modules);
      const notificationId = await t.run((ctx) =>
        ctx.db.insert('albatrossNotifications', {
          userId: 'notification_user',
          type: 'work_question',
          title: 'Question',
          body: 'What next?',
          deepLink: '/?view=albatrosses',
          dedupeKey: status,
          status,
          readAt: 12,
          actedAt: status === 'acted' ? 13 : undefined,
          scheduledFor: 1,
          createdAt: 1,
          updatedAt: 14,
        }),
      );
      await t
        .withIdentity({ subject: 'notification_user' })
        .mutation(api.albatrossNotifications.markNotification, { notificationId, status: 'read' });
      const result = await t.run((ctx) => ctx.db.get(notificationId));
      expect(result?.status).toBe(status);
      expect(result?.readAt).toBe(12);
      expect(result?.updatedAt).toBe(14);
    });
  }

  test('reading clears unread only, never records an acted timestamp', async () => {
    const t = convexTest(schema, modules);
    const notificationId = await t.run((ctx) =>
      ctx.db.insert('albatrossNotifications', {
        userId: 'notification_user',
        type: 'approval',
        title: 'Approval',
        body: 'Review this',
        deepLink: '/?view=albatrosses',
        dedupeKey: 'approval',
        status: 'delivered',
        scheduledFor: 1,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    const user = t.withIdentity({ subject: 'notification_user' });
    await user.mutation(api.albatrossNotifications.markNotification, { notificationId, status: 'read' });
    const first = await t.run((ctx) => ctx.db.get(notificationId));
    expect(first?.status).toBe('read');
    expect(first?.readAt).toBeGreaterThan(1);
    expect(first?.actedAt).toBeUndefined();
    await user.mutation(api.albatrossNotifications.markNotification, { notificationId, status: 'read' });
    expect((await t.run((ctx) => ctx.db.get(notificationId)))?.readAt).toBe(first?.readAt);
  });

  test('foreign and unauthenticated callers cannot mark another account notification', async () => {
    const t = convexTest(schema, modules);
    const notificationId = await t.run((ctx) =>
      ctx.db.insert('albatrossNotifications', {
        userId: 'notification_user',
        type: 'brief_ready',
        title: 'Brief',
        body: 'Ready',
        deepLink: '/?view=today',
        dedupeKey: 'brief',
        status: 'delivered',
        scheduledFor: 1,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    await expect(
      t
        .withIdentity({ subject: 'stranger' })
        .mutation(api.albatrossNotifications.markNotification, { notificationId, status: 'read' }),
    ).rejects.toThrow('Notification not found');
    await expect(
      t.mutation(api.albatrossNotifications.markNotification, { notificationId, status: 'read' }),
    ).rejects.toThrow('Not authenticated');
    expect((await t.run((ctx) => ctx.db.get(notificationId)))?.status).toBe('delivered');
  });
});
