import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { internal } from '../convex/_generated/api';
import {
  RETENTION_BATCH,
  WEBHOOK_EVENT_RETENTION_MS,
  WEBHOOK_EVENT_TTL_MS,
  WEBHOOK_SLIM_BATCH,
} from '../convex/retention';
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
      await ctx.db.insert('oauthCompletions', {
        userId: 'u',
        kind: 'mail',
        tokenHash: 'old',
        payloadEncrypted: 'x',
        expiresAt: START + 300_000,
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
      oauthCompletions: 1,
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
      expect(await ctx.db.query('oauthCompletions').collect()).toHaveLength(0);
      const codes = await ctx.db.query('mailOneTimeCodes').collect();
      expect(codes.map((row) => [row.code, row.status]).sort()).toEqual([
        ['lapsed', 'expired'],
        ['live', 'active'],
      ]);
    });
  });

  test('error and received webhook rows leave after their own TTL (M5)', async () => {
    const t = convexTest(schema, modules);
    const insert = (eventId: string, status: 'processed' | 'received' | 'error') =>
      t.run((ctx) =>
        ctx.db.insert('mailWebhookEvents', {
          eventId,
          type: 'message.updated',
          payload: {},
          status,
          receivedAt: Date.now(),
        }),
      );
    for (const status of ['received', 'error'] as const) await insert(`old-${status}`, status);
    await insert('old-processed', 'processed');
    const ids = async () =>
      t.run(async (ctx) =>
        (await ctx.db.query('mailWebhookEvents').collect()).map((row) => row.eventId).sort(),
      );

    // Past the processed TTL, before their own: only the processed row goes.
    expect(WEBHOOK_EVENT_TTL_MS.processed).toBeLessThan(WEBHOOK_EVENT_TTL_MS.error);
    expect(WEBHOOK_EVENT_TTL_MS.processed).toBeLessThan(WEBHOOK_EVENT_TTL_MS.received);
    setSystemTime(new Date(START + WEBHOOK_EVENT_TTL_MS.processed + DAY));
    expect((await t.mutation(internal.retention.sweep, {})).counts.mailWebhookEvents).toBe(1);
    expect(await ids()).toEqual(['old-error', 'old-received']);

    // A newer error row of the same kind stays after the old rows go.
    await insert('new-error', 'error');
    setSystemTime(new Date(START + WEBHOOK_EVENT_TTL_MS.error + DAY));
    const result = await t.mutation(internal.retention.sweep, {});
    expect(result.counts.mailWebhookEvents).toBe(2);
    expect(await ids()).toEqual(['new-error']);
  });

  test('slimWebhookPayloads cuts old payloads to ids, page by page', async () => {
    const t = convexTest(schema, modules);
    const body = 'x'.repeat(5_000);
    await t.run(async (ctx) => {
      for (let i = 0; i < WEBHOOK_SLIM_BATCH + 2; i++)
        await ctx.db.insert('mailWebhookEvents', {
          eventId: `e${i}`,
          type: 'message.updated',
          payload: {
            id: `e${i}`,
            type: 'message.updated',
            data: { object: { id: `m${i}`, grant_id: 'g1', thread_id: 't1', body } },
          },
          status: 'error',
          receivedAt: START,
        });
      await ctx.db.insert('mailWebhookEvents', {
        eventId: 'done',
        type: 'message.created',
        payload: { id: 'done', data: { object: { id: 'm', body } } },
        status: 'processed',
        receivedAt: START,
      });
    });
    const dry = await t.mutation(internal.retention.slimWebhookPayloads, { dryRun: true });
    expect(dry).toMatchObject({ status: 'error', scanned: WEBHOOK_SLIM_BATCH, slimmed: WEBHOOK_SLIM_BATCH });
    expect(dry.bytesAfter).toBeLessThan(dry.bytesBefore / 20);
    await t.run(async (ctx) => {
      const rows = await ctx.db.query('mailWebhookEvents').collect();
      expect(rows.every((row) => JSON.stringify(row.payload).includes(body))).toBe(true);
    });

    const first = await t.mutation(internal.retention.slimWebhookPayloads, {});
    expect(first).toMatchObject({ slimmed: WEBHOOK_SLIM_BATCH, isDone: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishAllScheduledFunctions(() => undefined);
    await t.run(async (ctx) => {
      const rows = await ctx.db.query('mailWebhookEvents').collect();
      const errors = rows.filter((row) => row.status === 'error');
      expect(errors.every((row) => !JSON.stringify(row.payload).includes(body))).toBe(true);
      expect(errors[0].payload).toMatchObject({
        stored: 'ids',
        data: { object: { id: 'm0', grant_id: 'g1', thread_id: 't1' } },
      });
      // Other statuses wait for their own run.
      expect(JSON.stringify(rows.find((row) => row.eventId === 'done')?.payload)).toContain(body);
    });
    const again = await t.mutation(internal.retention.slimWebhookPayloads, {});
    expect(again).toMatchObject({ slimmed: 0 });
    const processed = await t.mutation(internal.retention.slimWebhookPayloads, { status: 'processed' });
    expect(processed).toMatchObject({ slimmed: 1, isDone: true });
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
