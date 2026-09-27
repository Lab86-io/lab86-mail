import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { internal } from '../convex/_generated/api';
import { RETENTION_BATCH, WEBHOOK_EVENT_RETENTION_MS } from '../convex/retention';
import schema from '../convex/schema';

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/retention.ts': () => import('../convex/retention'),
  '../convex/mailOneTimeCodes.ts': () => import('../convex/mailOneTimeCodes'),
};

const DAY = 86_400_000;
const START = new Date('2026-09-01T00:00:00Z').getTime();

beforeEach(() => setSystemTime(new Date(START)));
afterEach(() => setSystemTime());

function code(overrides: Record<string, unknown>) {
  return {
    userId: 'u',
    accountId: 'a',
    providerMessageId: `m${Math.random()}`,
    providerThreadId: 't',
    code: '123456',
    label: 'Sign-in code',
    issuer: 'Example',
    serviceIdentifiers: ['example.com'],
    confidence: 1,
    receivedAt: START,
    expiresAt: START,
    status: 'active' as const,
    createdAt: START,
    updatedAt: START,
    ...overrides,
  } as any;
}

describe('retention sweep', () => {
  test('removes only rows past their retention and keeps live rows', async () => {
    const t = convexTest(schema, modules);
    // Rows written "now" (START); the sweep runs 15 days later.
    await t.run(async (ctx) => {
      for (const status of ['processed', 'received', 'error'] as const) {
        await ctx.db.insert('mailWebhookEvents', {
          eventId: `old-${status}`,
          type: 'message.created',
          payload: { big: 'payload' },
          status,
          receivedAt: START,
        });
      }
      await ctx.db.insert('rateLimits', {
        userId: 'u',
        key: 'old',
        windowStart: START,
        count: 1,
        expiresAt: START + 60_000,
        updatedAt: START,
      });
      await ctx.db.insert('nylasOAuthStates', {
        state: 'old',
        userId: 'u',
        provider: 'google',
        createdAt: START,
        expiresAt: START + 600_000,
      });
      await ctx.db.insert('mcpOAuthStates', {
        userId: 'u',
        state: 'old',
        server: 'linear',
        payloadEncrypted: 'x',
        expiresAt: START + 600_000,
        createdAt: START,
      });
      await ctx.db.insert('cloudFileOAuthStates', {
        userId: 'u',
        state: 'old',
        provider: 'google_drive',
        expiresAt: START + 600_000,
        createdAt: START,
      });
      await ctx.db.insert('cloudFileOAuthCompletions', {
        userId: 'u',
        completionToken: 'old',
        provider: 'google_drive',
        authorizationCodeEncrypted: 'x',
        expiresAt: START + 600_000,
        createdAt: START,
      });
      await ctx.db.insert('mailOneTimeCodes', code({ code: 'dead', expiresAt: START + 60_000 }));
    });

    const later = START + WEBHOOK_EVENT_RETENTION_MS + DAY;
    setSystemTime(new Date(later));
    await t.run(async (ctx) => {
      await ctx.db.insert('mailWebhookEvents', {
        eventId: 'fresh-processed',
        type: 'message.created',
        payload: {},
        status: 'processed',
        receivedAt: later,
      });
      await ctx.db.insert('rateLimits', {
        userId: 'u',
        key: 'live',
        windowStart: later,
        count: 1,
        expiresAt: later + 60_000,
        updatedAt: later,
      });
      await ctx.db.insert('mcpOAuthStates', {
        userId: 'u',
        state: 'live',
        server: 'linear',
        payloadEncrypted: 'x',
        expiresAt: later + 600_000,
        createdAt: later,
      });
      // Lapsed an hour ago: flipped to expired, kept for a day.
      await ctx.db.insert('mailOneTimeCodes', code({ code: 'lapsed', expiresAt: later - 3_600_000 }));
      await ctx.db.insert('mailOneTimeCodes', code({ code: 'live', expiresAt: later + 600_000 }));
    });

    const result = await t.mutation(internal.retention.sweep, {});
    expect(result.more).toBe(false);
    expect(result.counts).toMatchObject({
      mailOneTimeCodes: 1,
      mailOneTimeCodesExpired: 1,
      mailWebhookEvents: 1,
      rateLimits: 1,
      nylasOAuthStates: 1,
      mcpOAuthStates: 1,
      cloudFileOAuthStates: 1,
      cloudFileOAuthCompletions: 1,
    });

    await t.run(async (ctx) => {
      const events = await ctx.db.query('mailWebhookEvents').collect();
      expect(events.map((row) => row.eventId).sort()).toEqual([
        'fresh-processed',
        'old-error',
        'old-received',
      ]);
      expect((await ctx.db.query('rateLimits').collect()).map((row) => row.key)).toEqual(['live']);
      expect(await ctx.db.query('nylasOAuthStates').collect()).toHaveLength(0);
      expect((await ctx.db.query('mcpOAuthStates').collect()).map((row) => row.state)).toEqual(['live']);
      expect(await ctx.db.query('cloudFileOAuthStates').collect()).toHaveLength(0);
      expect(await ctx.db.query('cloudFileOAuthCompletions').collect()).toHaveLength(0);
      const codes = await ctx.db.query('mailOneTimeCodes').collect();
      expect(codes.map((row) => [row.code, row.status]).sort()).toEqual([
        ['lapsed', 'expired'],
        ['live', 'active'],
      ]);
    });
  });

  test('a full batch schedules another pass until the backlog drains', async () => {
    const t = convexTest(schema, modules);
    const total = RETENTION_BATCH.rateLimits + 5;
    await t.run(async (ctx) => {
      for (let i = 0; i < total; i++) {
        await ctx.db.insert('rateLimits', {
          userId: 'u',
          key: `k${i}`,
          windowStart: START,
          count: 1,
          expiresAt: START - 1,
          updatedAt: START,
        });
      }
    });
    const first = await t.mutation(internal.retention.sweep, {});
    expect(first.more).toBe(true);
    expect(first.counts.rateLimits).toBe(RETENTION_BATCH.rateLimits);
    const second = await t.mutation(internal.retention.sweep, {});
    expect(second.more).toBe(false);
    expect(second.counts.rateLimits).toBe(5);
    await t.run(async (ctx) => expect(await ctx.db.query('rateLimits').collect()).toHaveLength(0));
  });
});
