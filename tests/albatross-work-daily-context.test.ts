import { describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';

const convexModules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/albatrossWork.ts': () => import('../convex/albatrossWork'),
};

const SECRET = 'albatross-work-daily-context-secret';

async function withSecret<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.LAB86_CONVEX_INTERNAL_SECRET;
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
    else process.env.LAB86_CONVEX_INTERNAL_SECRET = previous;
  }
}

function checkinRow(userId: string, overrides: Record<string, any> = {}) {
  const ts = Date.now();
  return {
    userId,
    localDate: '2026-08-15',
    timezone: 'America/New_York',
    status: 'answered' as const,
    candidateItems: [],
    conversationId: `checkin_${userId}_20260815`,
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

function intentRow(userId: string, title: string, overrides: Record<string, any> = {}) {
  const ts = Date.now();
  return {
    userId,
    rawText: title,
    source: 'text' as const,
    title,
    status: 'needs_answers' as const,
    kind: 'errand',
    shape: 'quick' as const,
    workState: 'active' as const,
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

describe('dailyReportContext intent work', () => {
  test('returns the tomorrow-plan Work rows with pending questions', () =>
    withSecret(async () => {
      const t = convexTest(schema, convexModules);
      const userId = 'daily_context_user';

      const marketId = await t.run((ctx) =>
        ctx.db.insert('albatrossIntents', intentRow(userId, 'Visit a farmers market')),
      );
      const lakeId = await t.run((ctx) =>
        ctx.db.insert('albatrossIntents', intentRow(userId, 'Plan lake-item recovery')),
      );
      const foreignId = await t.run((ctx) =>
        ctx.db.insert('albatrossIntents', intentRow('someone_else', 'Not this user')),
      );

      await t.run((ctx) =>
        ctx.db.insert('albatrossWorkQuestions', {
          userId,
          workId: marketId,
          kind: 'clarification' as const,
          prompt: 'Which farmers market do you want to visit?',
          options: [{ id: 'share_market', label: 'Share the market name' }],
          status: 'pending' as const,
          sourceRefs: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
      await t.run((ctx) =>
        ctx.db.insert('albatrossWorkQuestions', {
          userId,
          workId: lakeId,
          kind: 'clarification' as const,
          prompt: 'Answered already.',
          status: 'answered' as const,
          answer: 'Keuka Lake',
          sourceRefs: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );

      await t.run((ctx) =>
        ctx.db.insert(
          'albatrossDailyCheckins',
          checkinRow(userId, {
            tomorrowIntentText: 'Farmers market, then lake day.',
            tomorrowWorkIds: [String(marketId), String(lakeId), String(foreignId), 'not-an-id'],
          }),
        ),
      );

      const context = await t.query(api.albatrossWork.dailyReportContext, {
        internalSecret: SECRET,
        userId,
      });

      expect(context.intentWork.map((work: any) => work.title)).toEqual([
        'Visit a farmers market',
        'Plan lake-item recovery',
      ]);
      const market = context.intentWork[0] as any;
      expect(market).toMatchObject({
        status: 'needs_answers',
        shape: 'quick',
        checkinLocalDate: '2026-08-15',
      });
      expect(market.questions).toEqual([
        {
          questionId: expect.anything(),
          prompt: 'Which farmers market do you want to visit?',
          options: [{ id: 'share_market', label: 'Share the market name', description: undefined }],
        },
      ]);
      const lake = context.intentWork[1] as any;
      expect(lake.questions).toEqual([]);
    }));

  test('a newer unanswered check-in never displaces the answered plan', () =>
    withSecret(async () => {
      const t = convexTest(schema, convexModules);
      const userId = 'daily_context_race';
      const answeredWorkId = await t.run((ctx) =>
        ctx.db.insert('albatrossIntents', intentRow(userId, 'Visit a farmers market')),
      );
      const strayWorkId = await t.run((ctx) =>
        ctx.db.insert('albatrossIntents', intentRow(userId, 'Stray draft work')),
      );
      await t.run((ctx) =>
        ctx.db.insert(
          'albatrossDailyCheckins',
          checkinRow(userId, {
            localDate: '2026-08-15',
            tomorrowIntentText: 'Farmers market in the morning.',
            tomorrowIntentAnsweredAt: Date.now(),
            tomorrowWorkIds: [String(answeredWorkId)],
          }),
        ),
      );
      // Newer row, but its tomorrow prompt was never answered.
      await t.run((ctx) =>
        ctx.db.insert(
          'albatrossDailyCheckins',
          checkinRow(userId, {
            localDate: '2026-08-16',
            status: 'open',
            tomorrowIntentText: 'Draft text that was never submitted.',
            tomorrowWorkIds: [String(strayWorkId)],
          }),
        ),
      );

      const context = await t.query(api.albatrossWork.dailyReportContext, {
        internalSecret: SECRET,
        userId,
      });
      expect(context.intentWork.map((work: any) => work.title)).toEqual(['Visit a farmers market']);
      expect(context.intentWork[0].checkinLocalDate).toBe('2026-08-15');
    }));

  test('a check-in without a tomorrow plan yields no intent work', () =>
    withSecret(async () => {
      const t = convexTest(schema, convexModules);
      const userId = 'daily_context_quiet';
      await t.run((ctx) =>
        ctx.db.insert('albatrossDailyCheckins', checkinRow(userId, { responseText: 'Rested.' })),
      );
      const context = await t.query(api.albatrossWork.dailyReportContext, {
        internalSecret: SECRET,
        userId,
      });
      expect(context.intentWork).toEqual([]);
    }));
});
