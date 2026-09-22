import { describe, expect, mock, test } from 'bun:test';
import { briefAttention } from '../lib/jev/brief';
import { projectBriefMail } from '../lib/jev/report';
import { rerankMail, sortSearchCandidates } from '../lib/jev/search';
import { markJevBriefItems, runJevSweep } from '../lib/jev/service';
import { assignBriefLane } from '../lib/mail/brief-score';
import { corpusMessagesToThreads } from '../lib/mail/search/local';
import { compareMailRelevance, matchingMailExcerpt } from '../lib/mail/search/ranking';
import { migrateDailyReport } from '../lib/store/daily-reports';
import { assessment, mailInput, NOW, policy, report, reportItem, responseFor, thread } from './fixtures/jev';

const attention = (extra: Partial<Parameters<typeof briefAttention>[0]> = {}) =>
  briefAttention({
    assessment: assessment(),
    preferences: policy.preferences,
    now: NOW,
    waitingSince: NOW,
    fallbackReply: false,
    tracked: false,
    ...extra,
  });
describe('Brief eligibility', () => {
  test('Syracuse-style campaigns and newsletters are excluded even with a personal request score', () => {
    for (const purpose of ['promotion', 'newsletter'] as const) {
      expect(attention({ assessment: assessment({ purpose }) }).eligible).toBe(false);
      expect(
        attention({
          assessment: assessment({ purpose }),
          preferences: { ...policy.preferences, briefPromotions: true, briefNewsletters: true },
        }).eligible,
      ).toBe(true);
      expect(
        attention({
          assessment: assessment({ purpose }),
          preferences: { ...policy.preferences, briefPromotions: true, briefNewsletters: true },
          previouslySurfaced: true,
        }).eligible,
      ).toBe(false);
    }
  });
  test('required actions and new transaction problems surface; receipts and finished exchanges do not', () => {
    expect(attention().eligible).toBe(true);
    expect(
      attention({
        assessment: assessment({ obligations: [{ ...assessment().obligations[0], kind: 'action' }] }),
      }).action,
    ).toBe(true);
    expect(
      attention({
        assessment: assessment({ purpose: 'transaction', obligations: [], meaningfulChange: true }),
      }).eligible,
    ).toBe(true);
    expect(attention({ assessment: assessment({ purpose: 'transaction', obligations: [] }) }).eligible).toBe(
      false,
    );
    expect(attention({ assessment: assessment({ obligations: [] }) }).eligible).toBe(false);
    expect(attention({ assessment: undefined, fallbackReply: true }).eligible).toBe(true);
    expect(attention({ assessment: undefined, tracked: true }).eligible).toBe(true);
  });
  test('waiting uses the original evidence time and changes are deduplicated across replies', () => {
    const waiting = assessment({ obligations: [{ ...assessment().obligations[0], kind: 'waiting' }] });
    expect(attention({ assessment: waiting }).eligible).toBe(false);
    expect(attention({ assessment: waiting, waitingSince: NOW - 3 * 86400_000 }).followUp).toBe(true);
    expect(
      attention({
        assessment: waiting,
        waitingSince: NOW - 3 * 86400_000,
        preferences: { ...policy.preferences, followUpDays: 7 },
      }).eligible,
    ).toBe(false);
    const change = assessment({ obligations: [], meaningfulChange: true });
    expect(
      attention({ assessment: change, changePreviouslySurfaced: true, previouslySurfaced: false }).eligible,
    ).toBe(false);
    expect(
      attention({ assessment: change, preferences: { ...policy.preferences, briefAccountChanges: false } })
        .eligible,
    ).toBe(false);
  });
  test('exact explicit preferences are applied before scoring', () => {
    expect(
      attention({ correction: { id: 'exclude', scope: 'thread', match: 't', brief: 'exclude' } }),
    ).toMatchObject({ eligible: false, reply: false });
    expect(
      attention({
        assessment: assessment({ purpose: 'promotion' }),
        correction: { id: 'include', scope: 'sender', match: 'p@test', brief: 'include' },
      }).eligible,
    ).toBe(true);
    expect(attention({ smart: { model: 'user_rule', primary: 'noise' } as any }).eligible).toBe(false);
    expect(
      attention({
        assessment: assessment({ obligations: [] }),
        smart: { model: 'user_rule', primary: 'main' } as any,
      }).eligible,
    ).toBe(true);
    expect(assignBriefLane({ replyOwed: false, deadlineWithin48h: false, needsAction: true })).toBe('today');
    expect(assignBriefLane({ replyOwed: false, deadlineWithin48h: false, meaningfulChange: true })).toBe(
      'today',
    );
  });
});

describe('latest Brief projection', () => {
  test('clears resolved mail, fills its slot from backlog, rebuilds handoffs, and preserves the saved snapshot', () => {
    const original = report();
    original.sections.overflow = [
      reportItem({ threadId: 'old-important', subject: 'Older request', score: 8 }),
    ];
    const snapshot = JSON.stringify(original);
    const result = projectBriefMail(
      original,
      [thread({ jev: assessment({ sourceRevision: 'resolved', obligations: [] }) })],
      policy,
      NOW,
    );
    expect(result.sections.answer?.map((i) => i.threadId)).toEqual(['old-important']);
    expect(result.sections.overflow).toEqual([]);
    expect(result.stats.overflow).toBe(0);
    expect(result.handoffs?.some((h) => h.primaryRef.id === 'thread-a')).toBe(false);
    expect(JSON.stringify(result.document)).not.toContain('Budget approval');
    expect(JSON.stringify(original)).toBe(snapshot);
  });
  test('does not project historical editions, unknown threads or unchanged evidence', () => {
    const original = report();
    expect(projectBriefMail(original, [], policy, NOW)).toBe(original);
    expect(projectBriefMail(original, [thread({ jev: assessment() })], policy, NOW)).toBe(original);
    expect(
      projectBriefMail(
        original,
        [thread({ jev: assessment({ sourceRevision: 'resolved', obligations: [] }) })],
        policy,
        NOW + 2 * 86400_000,
      ),
    ).toBe(original);
    expect(
      projectBriefMail(
        original,
        [
          thread({
            account: 'other-account',
            jev: assessment({ sourceRevision: 'resolved', obligations: [] }),
          }),
        ],
        policy,
        NOW,
      ),
    ).toBe(original);
  });
  test('applies new corrections immediately and never retains obsolete reply instructions', () => {
    const original = report();
    const excluded = projectBriefMail(
      original,
      [thread({ jev: assessment() })],
      {
        ...policy,
        corrections: [{ id: 'x', scope: 'sender', match: 'maya@university.test', brief: 'exclude' }],
      },
      NOW,
    );
    expect(excluded.sections.answer).toEqual([]);
    expect(excluded.narrative).not.toContain('No outstanding');
    const waiting = assessment({
      sourceRevision: 'waiting',
      obligations: [{ ...assessment().obligations[0], kind: 'waiting' }],
    });
    const moved = projectBriefMail(original, [thread({ jev: waiting })], policy, NOW);
    expect(moved.sections.answer).toEqual([]);
    expect(moved.sections.know?.[0].nextAction).not.toContain('Reply to Maya');
    expect(moved.sections.know?.[0].line).toContain('waiting');
    const uncertain = projectBriefMail(
      original,
      [thread({ jev: assessment({ sourceRevision: 'partial', obligations: [], status: 'uncertain' }) })],
      policy,
      NOW,
    );
    expect(uncertain.stats.selected).toBe(1);
  });
});

function searchDeps(overrides: Record<string, unknown> = {}) {
  return {
    loadJevPolicy: mock(async () => policy),
    resolveJevRuntime: mock(async () => ({ userId: 'u', source: 'lab86', apiKey: 'test-only' })),
    recordJevUsage: mock(async () => undefined),
    evaluateJev: mock(async ({ state, questions }: any) => ({
      model: 'typesafe/jev-1.13',
      answers: Object.fromEntries(
        Object.keys(questions).map((key, i) => [
          key,
          { type: 'noul', noul: state.candidates[i].subject.includes('Budget') ? 0.99 : 0.05 },
        ]),
      ),
      usage: { input_tokens: 20, output_tokens: 0 },
    })),
    ...overrides,
  } as any;
}
describe('query-specific relevance', () => {
  test('older conversation beats new campaign; query judgments, not global importance, control order', async () => {
    const deps = searchDeps();
    const campaign = thread({
      _id: 'campaign',
      subject: 'Athletics game',
      lastDate: NOW + 100,
      searchRank: 0,
    });
    const important = thread({ _id: 'budget', searchRank: 1 });
    const result = await rerankMail('u', 'Budget approval fixture', [campaign, important], undefined, deps);
    expect(result.map((t) => t._id)).toEqual(['budget', 'campaign']);
    expect(deps.evaluateJev.mock.calls[0][0].questions.candidate_0.instructions).toContain('candidates[0]');
    expect(deps.evaluateJev.mock.calls[0][0].questions.candidate_0.instructions).toContain(
      'Honor explicit requests for promotions',
    );
    await rerankMail('u', 'Budget approval fixture', [campaign, important], undefined, deps);
    expect(deps.evaluateJev).toHaveBeenCalledTimes(1);
    await rerankMail('other', 'Budget approval fixture', [campaign, important], undefined, deps);
    expect(deps.evaluateJev).toHaveBeenCalledTimes(2);
  });
  test('recent-order preference survives all downstream relevance comparators', async () => {
    const deps = searchDeps({
      loadJevPolicy: async () => ({
        ...policy,
        preferences: { ...policy.preferences, searchRelevance: false },
      }),
    });
    const result = await rerankMail(
      'u',
      'latest',
      [
        thread({ _id: 'old', searchRank: 0, searchRelevance: 1 }),
        thread({ _id: 'new', lastDate: NOW + 100, searchRank: 1 }),
      ],
      undefined,
      deps,
    );
    expect(sortSearchCandidates(result).map((t) => t._id)).toEqual(['new', 'old']);
    expect(
      sortSearchCandidates([
        ...result,
        thread({
          _id: 'middle-other-account',
          account: 'b',
          lastDate: NOW + 50,
          searchRank: 0,
          searchOrder: 'recent',
        }),
      ]).map((t) => t._id),
    ).toEqual(['new', 'middle-other-account', 'old']);
    expect(deps.evaluateJev).not.toHaveBeenCalled();
  });
  test('provider failure preserves retrieval order, and cancellation cannot publish stale results', async () => {
    const candidates = [thread({ _id: 'a' }), thread({ _id: 'b' })];
    const deps = searchDeps({
      evaluateJev: async () => {
        throw new Error('unavailable');
      },
    });
    expect(await rerankMail('u', 'failure fixture', candidates, undefined, deps)).toBe(candidates);
    expect(await rerankMail('u', '', candidates, undefined, deps)).toBe(candidates);
    expect(await rerankMail('u', 'one', candidates.slice(0, 1), undefined, deps)).toHaveLength(1);
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(rerankMail('u', 'cancel fixture', candidates, controller.signal, deps)).rejects.toThrow(
      'cancelled',
    );
  });
  test('groups by strongest matching message, preserves excerpt and exact account identity', () => {
    const make = (id: string, receivedAt: number, snippet: string) => ({
      accountId: 'a',
      provider: 'google' as const,
      providerMessageId: id,
      providerThreadId: id === 'broadcast' ? 'broadcast' : 'conversation',
      subject: 'Budget',
      from: 'sender@test',
      to: 'owner@test',
      receivedAt,
      snippet,
      searchText: snippet,
      labels: ['INBOX'],
    });
    const result = corpusMessagesToThreads(
      [
        make('best', 1, 'The approved budget'),
        make('broadcast', 5, 'Buy tickets'),
        make('newer', 4, 'Thanks'),
      ],
      'a',
      'relevant',
    );
    expect(result.map((t) => t._id)).toEqual(['conversation', 'broadcast']);
    expect(result[0].snippet).toBe('The approved budget');
    expect(result[0].searchRank).toBe(0);
    expect(
      matchingMailExcerpt(`${'x'.repeat(3000)} approved budget ${'x'.repeat(3000)}`, 'approved budget'),
    ).toContain('approved budget');
    expect(matchingMailExcerpt('small', 'unknown')).toBe('small');
    expect(
      compareMailRelevance({ searchRelevance: 0.9, lastDate: 1 }, { searchRelevance: 0.1, lastDate: 9 }),
    ).toBeLessThan(0);
    expect(compareMailRelevance({ searchRank: 0, lastDate: 1 }, { searchRank: 1, lastDate: 9 })).toBeLessThan(
      0,
    );
  });
});

describe('Jev sweep orchestration', () => {
  test('claims, validates, accounts usage, and stores an evidence-backed result', async () => {
    const input = { ...mailInput(), leaseId: 'lease' };
    const mutations: any[] = [];
    const usage = mock(async () => undefined);
    const afterClassified = mock(() => undefined);
    const deps = {
      loadJevPolicy: async () => policy,
      resolveJevRuntime: async () => ({ userId: 'u', source: 'lab86', apiKey: 'test-only' }),
      evaluateJev: async () => responseFor(input),
      recordJevUsage: usage,
      afterClassified,
      convexMutation: async (_ref: unknown, args: any) => {
        mutations.push(args);
        return args.items ? { stored: 1 } : { items: [input], moreRemaining: false };
      },
    } as any;
    expect(await runJevSweep('u', deps)).toEqual({ classified: 1, moreRemaining: false });
    expect(mutations[1].items[0].assessment.obligations[0].evidence.messageId).toBe('m1');
    expect(mutations[1].userId).toBe('u');
    expect(usage).toHaveBeenCalledTimes(1);
    expect(afterClassified).toHaveBeenCalledWith('u');
  });
  test('disabled users make no model calls; failures are retriable and empty queues stop', async () => {
    const input = { ...mailInput(), leaseId: 'lease' };
    const writes: any[] = [];
    const runtime = mock(async () => ({ userId: 'u', source: 'lab86', apiKey: 'test-only' }));
    const deps = {
      loadJevPolicy: async () => ({ ...policy, preferences: { ...policy.preferences, enabled: false } }),
      resolveJevRuntime: runtime,
      evaluateJev: async () => {
        throw new Error('offline');
      },
      recordJevUsage: async () => undefined,
      convexMutation: async (_r: unknown, args: any) => {
        if (args.items) {
          writes.push(args.items);
          return { stored: 0 };
        }
        return writes.length ? { items: [], moreRemaining: false } : { items: [input], moreRemaining: true };
      },
    } as any;
    expect(await runJevSweep('u', deps)).toEqual({ classified: 0 });
    expect(runtime).not.toHaveBeenCalled();
    deps.loadJevPolicy = async () => policy;
    expect(await runJevSweep('u', deps)).toEqual({ classified: 0, moreRemaining: false });
    expect(writes[0][0]).toMatchObject({
      error: 'unavailable',
      sourceRevision: input.sourceRevision,
      leaseId: 'lease',
    });
  });
});

test('stored Brief migration preserves visible backlog, classification evidence and separate counts', () => {
  const original = report();
  original.sections.overflow = [reportItem({ threadId: 'older' })];
  original.stats.overflow = 1;
  original.stats.noise = 10;
  const migrated = migrateDailyReport(original, NOW);
  expect(migrated.sections.overflow?.[0].jev?.sourceRevision).toBe(
    original.sections.overflow[0].jev?.sourceRevision,
  );
  expect(migrated.stats.overflow).toBe(1);
  expect(migrated.stats.noise).toBe(10);
});

test('display markers include selected revisions only, never unresolved overflow', async () => {
  const value = report();
  value.sections.overflow = [reportItem({ threadId: 'overflow' })];
  const calls: any[] = [];
  await markJevBriefItems(value, 'owner', (async (_ref: unknown, args: any) => {
    calls.push(args);
  }) as any);
  expect(calls).toEqual([
    {
      userId: 'owner',
      items: [
        {
          accountId: 'account-a',
          threadId: 'thread-a',
          sourceRevision: value.sections.answer![0].jev!.sourceRevision,
        },
      ],
    },
  ]);
  await markJevBriefItems(report([]), 'owner', (async () => {
    throw new Error('No empty mutations');
  }) as any);
});
