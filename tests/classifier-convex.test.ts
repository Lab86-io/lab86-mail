import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import schema from '../convex/schema';

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/classifier.ts': () => import('../convex/classifier'),
};
const secret = 'synthetic-classifier-test';
let previous: string | undefined;
beforeAll(() => {
  previous = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = secret;
});
afterAll(() => {
  if (previous === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previous;
});
const ref = (api as any).classifier;
const DAY = 86_400_000;

async function seedThread(t: ReturnType<typeof convexTest>, id: string, lastDate: number, extra: any = {}) {
  await t.run(async (ctx) => {
    await ctx.db.insert('mailCorpusThreads', {
      userId: 'owner',
      accountId: 'a',
      grantId: 'g',
      provider: 'google',
      providerThreadId: id,
      subject: id,
      fromAddress: 'maya@example.test',
      lastDate,
      snippet: '',
      labels: ['INBOX'],
      unread: false,
      yearMonth: '2026-09',
      createdAt: 0,
      updatedAt: 0,
      jev: { purpose: 'conversation' },
      jevStatus: 'accepted',
      ...extra,
    } as any);
  });
}

describe('deployment classifier selection', () => {
  test('select validates the catalog id and the optimistic revision', async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(ref.selection, { internalSecret: secret })).toEqual({
      classifierId: null,
      revision: 0,
    });
    await expect(
      t.mutation(ref.select, { internalSecret: secret, classifierId: 'nope', revision: 0, updatedBy: 'op' }),
    ).rejects.toThrow('UNKNOWN_CLASSIFIER');
    const saved = await t.mutation(ref.select, {
      internalSecret: secret,
      classifierId: 'tev1-4b',
      revision: 0,
      updatedBy: 'op',
    });
    expect(saved).toMatchObject({ classifierId: 'tev1-4b', requeued: true });
    expect(await t.query(ref.selection, { internalSecret: secret })).toEqual({
      classifierId: 'tev1-4b',
      revision: saved.revision,
    });
    await expect(
      t.mutation(ref.select, {
        internalSecret: secret,
        classifierId: 'jev-1.13',
        revision: 0,
        updatedBy: 'op',
      }),
    ).rejects.toThrow('CLASSIFIER_SETTINGS_CONFLICT');
    const same = await t.mutation(ref.select, {
      internalSecret: secret,
      classifierId: 'tev1-4b',
      revision: saved.revision,
      updatedBy: 'op',
    });
    expect(same.requeued).toBe(false);
    await expect(t.query(ref.selection, { internalSecret: 'wrong' })).rejects.toThrow();
  });

  test('a switch requeues recent and open-obligation threads but keeps their current results', async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert('users', {
        clerkUserId: 'owner',
        email: 'o@example.test',
        createdAt: 0,
        updatedAt: 0,
      });
    });
    await seedThread(t, 'recent', now - DAY, { jevAttempts: 3, jevRetryAt: now + DAY });
    await seedThread(t, 'old-open-reply', now - 90 * DAY, { jevNeedsReply: true });
    await seedThread(t, 'old-quiet', now - 90 * DAY);
    await t.mutation((internal as any).classifier.requeueAfterSwitch, { since: now });
    const rows = await t.run((ctx) => ctx.db.query('mailCorpusThreads').collect());
    const byId = Object.fromEntries(rows.map((row: any) => [row.providerThreadId, row]));
    for (const id of ['recent', 'old-open-reply']) {
      expect(byId[id]).toMatchObject({ llmPending: true, jevStatus: 'pending', jevAttempts: 0 });
      expect(byId[id].jevRetryAt).toBeUndefined();
      expect(byId[id].jev).toEqual({ purpose: 'conversation' });
    }
    expect(byId['old-quiet'].llmPending).toBeUndefined();
    expect(byId['old-quiet'].jevStatus).toBe('accepted');
  });
});
