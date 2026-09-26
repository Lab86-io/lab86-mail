import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { convexTest } from 'convex-test';
import './tools/harness';
import { briefEditionNotes } from '../components/report/BriefSourceLine';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';
import * as gateway from '../lib/ai/gateway';
import { generateAgentReport } from '../lib/mail/agent-report';
import { kickFirstEdition, runBriefJob } from '../lib/mail/brief-jobs';
import { __setFirstEditionLoaderForTest, kickFirstEditionAfterFirstPage } from '../lib/mail/corpus-sync';
import { generateDailyReport } from '../lib/mail/daily-report';
import { upsertTrackedThread } from '../lib/store/tracked-threads';
import { seedThreadMessage, withToolContext } from './tools/harness';

const SECRET = 'first-edition-secret';
const previousSecret = process.env.LAB86_CONVEX_INTERNAL_SECRET;
beforeEach(() => {
  process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
});
afterEach(() => {
  if (previousSecret === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
  else process.env.LAB86_CONVEX_INTERNAL_SECRET = previousSecret;
  __setFirstEditionLoaderForTest();
});

function worker(overrides: { noAccess?: boolean; saved?: unknown } = {}) {
  const calls: Array<{ name: string; args: any }> = [];
  const edition = {
    _id: 'first-edition',
    generatedAt: 10,
    status: 'ready',
    document: {},
    editorial: { mode: 'generated' },
  };
  const deps = {
    mutation: (async (fn: any, args: any) => {
      const name = getFunctionName(fn);
      calls.push({ name, args });
      if (name === 'briefJobs:claim')
        return {
          kind: 'daily',
          edition: 'manual',
          first: true,
          reportId: 'first-edition',
          createdAt: 10,
          attempts: 1,
        };
      return true;
    }) as any,
    query: (async () => null) as any,
    daily: mock(async (input: any) => ({
      ...edition,
      ...(input.deterministic ? { editorial: { mode: 'fallback' } } : {}),
    })),
    area: mock(async () => ({})),
    narrative: mock(async () => ({ status: 'ready' })),
    readDaily: mock(async () => (overrides.saved ?? null) as any),
    notify: mock(async () => {}),
    noAccess: mock(async () => overrides.noAccess ?? false),
    now: () => 100,
  };
  return { deps, calls };
}

describe('the first edition job', () => {
  test('publishes a deterministic edition first, then the writer upgrades the same edition', async () => {
    const { deps, calls } = worker();
    await runBriefJob('owner', 'job', deps as any);
    expect(deps.daily.mock.calls.map((call: any[]) => call[0])).toEqual([
      {
        userId: 'owner',
        kind: 'manual',
        reportId: 'first-edition',
        now: 10,
        first: true,
        deterministic: true,
      },
      { userId: 'owner', kind: 'manual', reportId: 'first-edition', now: 10, quiet: true, first: true },
    ]);
    expect(calls.at(-1)).toMatchObject({ name: 'briefJobs:settle' });
    expect(calls.at(-1)?.args.error).toBeUndefined();
  });

  test('without model access the deterministic edition is the final one', async () => {
    const { deps, calls } = worker({ noAccess: true });
    await runBriefJob('owner', 'job', deps as any);
    expect(deps.daily).toHaveBeenCalledTimes(1);
    expect(deps.notify).not.toHaveBeenCalled();
    expect(calls.at(-1)?.args.error).toBeUndefined();
  });

  test('a retry after the deterministic edition goes straight to the writer', async () => {
    const { deps } = worker({ saved: { _id: 'first-edition', status: 'ready', document: {} } });
    await runBriefJob('owner', 'job', deps as any);
    expect(deps.daily).toHaveBeenCalledTimes(1);
    expect(deps.daily.mock.calls[0][0]).toMatchObject({ quiet: true, first: true });
  });
});

describe('queueing the first edition', () => {
  test('is queued once, and never after any edition exists', async () => {
    const t = convexTest(schema, {
      '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
      '../convex/briefJobs.ts': () => import('../convex/briefJobs'),
    });
    const args = {
      internalSecret: SECRET,
      userId: 'u1',
      kind: 'daily',
      edition: 'manual',
      first: true,
      reportId: 'first-1',
    };
    const first: any = await t.mutation((api as any).briefJobs.enqueue, args);
    expect(first.started).toBe(true);
    const job = await t.run((ctx) => ctx.db.query('briefJobs').unique());
    expect(job?.first).toBe(true);
    const again: any = await t.mutation((api as any).briefJobs.enqueue, { ...args, reportId: 'first-2' });
    expect(again).toEqual({ jobId: null, started: false, skipped: 'has_edition' });
    expect(await t.run((ctx) => ctx.db.query('userDocs').collect())).toHaveLength(1);
  });

  test('the backfill kick asks for a first edition and never throws', async () => {
    const enqueue = mock(async (input: any) => ({ jobId: 'j', started: true, input }));
    expect(await kickFirstEdition('u1', { enqueue: enqueue as any })).toMatchObject({ started: true });
    expect(enqueue.mock.calls[0][0]).toEqual({ userId: 'u1', kind: 'daily', edition: 'manual', first: true });
    const failing = mock(async () => {
      throw new Error('down');
    });
    expect(await kickFirstEdition('u1', { enqueue: failing as any })).toBeNull();

    const kicked: string[] = [];
    __setFirstEditionLoaderForTest(
      async () => ({ kickFirstEdition: async (userId: string) => kicked.push(userId) }) as any,
    );
    await kickFirstEditionAfterFirstPage('u2');
    expect(kicked).toEqual(['u2']);
    __setFirstEditionLoaderForTest(async () => {
      throw new Error('chunk missing');
    });
    await expect(kickFirstEditionAfterFirstPage('u3')).resolves.toBeUndefined();
  });
});

describe('the deterministic first edition', () => {
  test('reads the last 48 hours with no model call and records the thread facts', async () => {
    const seeded = await seedThreadMessage({
      account: 'first@example.test',
      threadId: 'first_human',
      messageId: 'msg_first_human',
      subject: 'Can we meet Friday?',
      from: 'Pat <pat@example.test>',
      to: 'Jakob <first@example.test>',
      textBody: 'Can you confirm Friday works?',
      labels: ['INBOX', 'IMPORTANT', 'CATEGORY_PERSONAL'],
      unread: true,
    });
    await withToolContext(() =>
      upsertTrackedThread({
        account: seeded.account,
        threadId: seeded.threadId,
        subject: 'Can we meet Friday?',
        participants: ['Pat'],
        status: 'open',
      }),
    );
    const hasAi = spyOn(gateway, 'hasAiForCurrentUser');
    try {
      const report = await withToolContext(() =>
        generateDailyReport({
          kind: 'manual',
          accounts: [seeded.account],
          includeCalendar: false,
          now: Date.parse('2026-06-10T15:00:00.000Z'),
          scope: 'first',
          noModel: true,
          // Other files read the latest local edition; this one is not stored.
          silent: true,
        }),
      );
      expect(hasAi).not.toHaveBeenCalled();
      const all = [
        ...(report.sections.answer ?? []),
        ...(report.sections.today ?? []),
        ...(report.sections.know ?? []),
      ];
      const item = all.find((entry) => entry.threadId === seeded.threadId);
      expect(item).toBeDefined();
      expect(item?.inInbox).toBe(true);
      expect(item?.senderEmail).toBe('pat@example.test');
    } finally {
      hasAi.mockRestore();
    }
  });

  test('the whole pipeline publishes with no model and no source refresh', async () => {
    const runtime = spyOn(gateway, 'resolveAiRuntime');
    const generate = spyOn(gateway, 'generateTextForCurrentUser');
    try {
      const report = await withToolContext(
        () =>
          generateAgentReport({
            kind: 'manual',
            reportId: 'first-deterministic',
            first: true,
            deterministic: true,
            light: true,
          }),
        { userId: 'first-owner' },
      );
      expect(report.first).toBe(true);
      expect(report.light).toBe(true);
      expect(report.sourceChecks).toBeUndefined();
      expect(report.editorial?.mode).toBe('fallback');
      expect(report.artifactErrors ?? []).toEqual([]);
      expect(runtime).not.toHaveBeenCalled();
      expect(generate).not.toHaveBeenCalled();
    } finally {
      runtime.mockRestore();
      generate.mockRestore();
    }
  });

  test('Today names the first and the light edition', () => {
    expect(briefEditionNotes(null)).toEqual([]);
    expect(briefEditionNotes({ first: true })[0]).toContain('Your first brief');
    expect(briefEditionNotes({ light: true, kind: 'morning' })).toEqual([
      'A light weekend edition: replies owed, today, and your calendar.',
    ]);
    expect(briefEditionNotes({ light: true, kind: 'weekly' })).toEqual([]);
  });
});
