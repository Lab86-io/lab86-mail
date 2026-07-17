import { describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import schema from '../convex/schema';

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
};

describe('Albatross notification schema compatibility', () => {
  test('continues to validate legacy mail and event notification rows', async () => {
    const t = convexTest(schema, convexModules);
    const ids = await t.run(async (ctx) => {
      const base = {
        userId: 'legacy_user',
        title: 'Legacy notification',
        body: 'Existing durable notification',
        deepLink: '/albatross',
        status: 'delivered' as const,
        scheduledFor: 1,
        createdAt: 1,
        updatedAt: 1,
      };

      return Promise.all([
        ctx.db.insert('albatrossNotifications', {
          ...base,
          type: 'mail_message',
          entityKind: 'thread',
          entityId: 'thread_1',
          dedupeKey: 'legacy:mail',
        }),
        ctx.db.insert('albatrossNotifications', {
          ...base,
          type: 'event_suggestion',
          entityKind: 'suggestion',
          entityId: 'suggestion_1',
          dedupeKey: 'legacy:event',
        }),
      ]);
    });

    expect(ids).toHaveLength(2);
  });
});
