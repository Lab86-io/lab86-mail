import { afterAll, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { convexTest, type TestConvex } from 'convex-test';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';
import { classifierById } from '../lib/classifier/catalog';
import {
  assessmentFromResponse,
  classifierState,
  factsAnswerSettles,
  factsConfidence,
  factsInput,
  JEV_FACTS_CONFIDENCE,
} from '../lib/jev/mail';
import { JEV_BODY_FEATURE, JEV_FACTS_FEATURE, runJevSweep } from '../lib/jev/service';
import { mailInput, NOW, policy, responseFor } from './fixtures/jev';

describe('two-stage Jev', () => {
  const JEV = classifierById('jev-1.13')!;
  const bulk = { purpose: 'newsletter', subject_kind: 'general', reply: 0.02, reply_evidence: 'none' };

  function facts(messageCount = 1) {
    const input = mailInput('Snippet only');
    return factsInput(input, {
      messages: input.messages,
      contextComplete: messageCount <= 1,
      threadFacts: { labels: ['INBOX'], messageCount, ruleCategory: 'noise', ruleSignals: [] },
    });
  }

  test('confidence is the lowest decision probability, without the evidence questions', () => {
    const input = facts();
    expect(factsConfidence(responseFor(input, bulk))).toBeCloseTo(0.98);
    expect(factsConfidence(responseFor(input, { ...bulk, change: 0.3 }))).toBeCloseTo(0.7);
    const response = responseFor(input, bulk);
    (response.answers.reply_evidence as any).confidence = 0.1;
    expect(factsConfidence(response)).toBeCloseTo(0.98);
    expect(
      factsConfidence({ ...response, answers: { ...response.answers, purpose: undefined as any } }),
    ).toBe(0);
    expect(factsConfidence({ ...response, answers: { ...response.answers, reply: undefined as any } })).toBe(
      0,
    );
  });

  test('a clear bulk answer settles; doubt, obligations and hidden history go to the bodies', () => {
    const input = facts();
    expect(JEV_FACTS_CONFIDENCE).toBe(0.8);
    expect(factsAnswerSettles(input, responseFor(input, bulk), JEV)).toBe(true);
    // Below the threshold.
    expect(factsAnswerSettles(input, responseFor(input, { ...bulk, waiting: 0.4 }), JEV)).toBe(false);
    // A likely obligation needs its evidence from the text.
    expect(factsAnswerSettles(input, responseFor(input, { ...bulk, reply: 0.95 }), JEV)).toBe(false);
    // Unknown purpose.
    expect(factsAnswerSettles(input, responseFor(input, { ...bulk, purpose: 'unknown' }), JEV)).toBe(false);
    // A conversation with earlier messages that the first stage did not see.
    const conversation = { ...bulk, purpose: 'conversation' };
    expect(factsAnswerSettles(input, responseFor(input, conversation), JEV)).toBe(true);
    expect(factsAnswerSettles(facts(3), responseFor(facts(3), conversation), JEV)).toBe(false);
    const low = responseFor(input, bulk);
    (low.answers.purpose as any).confidence = 0.79;
    expect(factsAnswerSettles(input, low, JEV)).toBe(false);
  });

  test('the classifier state carries the thread facts on the first stage only', () => {
    const first = facts(2);
    expect(classifierState(first)).toMatchObject({
      threadFacts: { messageCount: 2, labels: ['INBOX'] },
      contextComplete: false,
    });
    expect(classifierState(mailInput())).not.toHaveProperty('threadFacts');
  });
});

describe('the sweep runs the stages', () => {
  const JEV = classifierById('jev-1.13')!;
  const bulk = { purpose: 'newsletter', subject_kind: 'general', reply: 0.02, reply_evidence: 'none' };

  function claimItem(withFacts = true) {
    const input = { ...mailInput('The full newsletter body.'), leaseId: 'lease' };
    const facts = {
      messages: [{ ...input.messages[0], body: 'Snippet' }],
      contextComplete: true,
      threadFacts: { labels: ['INBOX'], messageCount: 1, ruleCategory: 'noise', ruleSignals: ['bulk_noise'] },
    };
    return withFacts ? { ...input, facts } : input;
  }

  function sweepDeps(item: any, answer: (state: any) => any) {
    const calls: any[] = [];
    const usage: Array<[string, boolean]> = [];
    const stored: any[] = [];
    let claimed = false;
    const deps = {
      loadJevPolicy: async () => policy,
      resolveClassifierRuntime: async () => ({
        userId: 'u',
        source: 'lab86',
        apiKey: 'test-only',
        model: JEV,
      }),
      evaluateClassifier: async (request: any) => {
        calls.push(request);
        return answer(request.state);
      },
      recordClassifierUsage: async (_runtime: unknown, feature: string, result?: unknown) => {
        usage.push([feature, Boolean(result)]);
      },
      afterClassified: () => undefined,
      convexMutation: async (_ref: unknown, args: any) => {
        if (args.items) {
          stored.push(...args.items);
          return { stored: args.items.length };
        }
        if (claimed) return { items: [], moreRemaining: false };
        claimed = true;
        return { items: [item], moreRemaining: false };
      },
    } as any;
    return { deps, calls, usage, stored };
  }

  test('a clear first-stage answer makes one small call and stores its verdict', async () => {
    const item = claimItem();
    const run = sweepDeps(item, (state) =>
      responseFor({ ...item, messages: state.messagesOldestToNewest }, bulk),
    );
    expect(await runJevSweep('u', run.deps)).toEqual({ classified: 1, moreRemaining: false });
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0].state.threadFacts.messageCount).toBe(1);
    expect(run.calls[0].state.messagesOldestToNewest[0].body).toBe('Snippet');
    expect(run.usage).toEqual([[JEV_FACTS_FEATURE, true]]);
    expect(run.stored[0].assessment).toMatchObject({ purpose: 'newsletter', obligations: [] });
    expect(run.stored[0].sourceRevision).toBe(item.sourceRevision);
  });

  test('an unclear first-stage answer reads the bodies in a second call', async () => {
    const item = claimItem();
    const run = sweepDeps(item, (state) =>
      state.threadFacts
        ? responseFor({ ...item, messages: state.messagesOldestToNewest }, { ...bulk, change: 0.5 })
        : responseFor(item),
    );
    expect(await runJevSweep('u', run.deps)).toEqual({ classified: 1, moreRemaining: false });
    expect(run.calls).toHaveLength(2);
    expect(run.calls[1].state).not.toHaveProperty('threadFacts');
    expect(run.calls[1].state.messagesOldestToNewest[0].body).toBe('The full newsletter body.');
    expect(run.usage).toEqual([
      [JEV_FACTS_FEATURE, true],
      [JEV_BODY_FEATURE, true],
    ]);
    // The body-stage verdict has the reply obligation with its text evidence.
    expect(run.stored[0].assessment.obligations[0].evidence.text).toBe('The full newsletter body.');
  });

  test('a claim with no first-stage view goes to the bodies at once', async () => {
    const item = claimItem(false);
    const run = sweepDeps(item, () => responseFor(item));
    await runJevSweep('u', run.deps);
    expect(run.calls).toHaveLength(1);
    expect(run.usage).toEqual([[JEV_BODY_FEATURE, true]]);
  });

  test('a failed first-stage call retries later and buys no second call', async () => {
    const item = claimItem();
    const run = sweepDeps(item, () => {
      throw new Error('offline');
    });
    await runJevSweep('u', run.deps);
    expect(run.calls).toHaveLength(1);
    expect(run.usage).toEqual([[JEV_FACTS_FEATURE, false]]);
    expect(run.stored[0]).toMatchObject({ error: 'unavailable', leaseId: 'lease' });
  });

  test('a failed body-stage call is stored as unavailable', async () => {
    const item = claimItem();
    const run = sweepDeps(item, (state) => {
      if (state.threadFacts)
        return responseFor({ ...item, messages: state.messagesOldestToNewest }, { ...bulk, reply: 0.95 });
      throw new Error('offline');
    });
    await runJevSweep('u', run.deps);
    expect(run.usage).toEqual([
      [JEV_FACTS_FEATURE, true],
      [JEV_BODY_FEATURE, false],
    ]);
    expect(run.stored[0].error).toBe('unavailable');
  });
  test('an answer that cannot become a verdict is stored as unavailable', async () => {
    const item = claimItem();
    const run = sweepDeps(item, () => ({
      model: 'typesafe/jev-1.13',
      answers: {},
      usage: { input_tokens: 1, output_tokens: 0 },
    }));
    await runJevSweep('u', run.deps);
    expect(run.calls).toHaveLength(2);
    expect(run.stored[0]).toMatchObject({ error: 'unavailable', leaseId: 'lease' });
  });
});

describe('the claim and the store', () => {
  const modules = {
    '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
    '../convex/mailCorpus.ts': () => import('../convex/mailCorpus'),
    '../convex/jev.ts': () => import('../convex/jev'),
  };
  const secret = 'jev-two-stage-secret';
  const scope = { internalSecret: secret, userId: 'owner' };
  let previous: string | undefined;
  beforeAll(() => {
    previous = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = secret;
    setSystemTime(new Date(NOW + 3_600_000));
  });
  afterAll(() => {
    setSystemTime();
    if (previous === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
    else process.env.LAB86_CONVEX_INTERNAL_SECRET = previous;
  });

  async function seed(t: TestConvex<typeof schema>, count = 1, body = 'Please read our weekly news.') {
    await t.run((ctx) =>
      ctx.db.insert('connectedAccounts', {
        userId: 'owner',
        accountId: 'a',
        email: 'owner@example.test',
        provider: 'google',
        grantId: 'grant-a',
        status: 'connected',
        scopes: [],
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    await t.mutation(api.mailCorpus.upsertCorpusBatch, {
      ...scope,
      accountId: 'a',
      grantId: 'grant-a',
      provider: 'google',
      threads: [],
      messages: Array.from({ length: count }, (_, index) => ({
        providerMessageId: `m${index}`,
        providerThreadId: 't',
        subject: 'Weekly news',
        from: 'news@example.test',
        to: 'owner@example.test',
        receivedAt: NOW - (count - index) * 60_000,
        snippet: `Snippet ${index}`,
        textBody: `${body} Part ${index}.`,
        htmlBody: `<p>${body}</p>`,
        searchText: 'weekly news',
        headers: { 'List-Unsubscribe': '<mailto:stop@example.test>' },
        labels: ['INBOX', 'CATEGORY_UPDATES'],
      })),
    });
  }
  const threadRow = (t: TestConvex<typeof schema>) =>
    t.run((ctx) => ctx.db.query('mailCorpusThreads').first());

  test('the claim gives both views from small documents, with the newest three bodies', async () => {
    const t = convexTest(schema, modules);
    await seed(t, 5);
    const page = await t.mutation(api.jev.claimPending, { ...scope, limit: 12 });
    const item = page.items[0];
    expect(item.messages.map((message: any) => message.id)).toEqual(['m2', 'm3', 'm4']);
    expect(item.messages[2].body).toBe('Please read our weekly news. Part 4.');
    expect(item.messages[2].headers).toEqual({ 'list-unsubscribe': '<mailto:stop@example.test>' });
    expect(item.contextComplete).toBe(false);
    expect(item.facts?.messages).toHaveLength(1);
    expect(item.facts?.messages[0]).toMatchObject({ id: 'm4', body: 'Snippet 4' });
    expect(item.facts?.threadFacts).toMatchObject({ messageCount: 5, labels: ['INBOX', 'CATEGORY_UPDATES'] });
    expect(item.facts?.contextComplete).toBe(false);
  });

  test('a first-stage verdict stores against the same revision', async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const item = (await t.mutation(api.jev.claimPending, { ...scope, limit: 12 })).items[0];
    const first = factsInput(item, item.facts!);
    const bulk = { purpose: 'newsletter', subject_kind: 'general', reply: 0.02, reply_evidence: 'none' };
    const assessment = assessmentFromResponse(first, responseFor(first, bulk), NOW);
    const result = await t.mutation(api.jev.storeAssessments, {
      ...scope,
      items: [
        {
          accountId: item.accountId,
          threadId: item.threadId,
          messageId: item.messageId,
          sourceRevision: item.sourceRevision,
          leaseId: item.leaseId,
          assessment,
        },
      ],
    });
    expect(result.stored).toBe(1);
    const row = await threadRow(t);
    expect(row?.jev?.purpose).toBe('newsletter');
    expect(row?.smartPrimary).toBe('noise');
    expect(row?.llmPending).toBeUndefined();
  });

  test('evidence from the snippet or the body stage is accepted; other text is not', async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const item = (await t.mutation(api.jev.claimPending, { ...scope, limit: 12 })).items[0];
    const assessment = assessmentFromResponse(item, responseFor(item), NOW);
    const store = (evidenceText: string) =>
      t.mutation(api.jev.storeAssessments, {
        ...scope,
        items: [
          {
            accountId: item.accountId,
            threadId: item.threadId,
            messageId: item.messageId,
            sourceRevision: item.sourceRevision,
            leaseId: item.leaseId,
            assessment: {
              ...assessment,
              obligations: [
                { ...assessment.obligations[0], evidence: { messageId: 'm0', text: evidenceText } },
              ],
            },
          },
        ],
      });
    expect((await store('Invented text')).stored).toBe(0);
    await t.run(async (ctx) => {
      const row = await ctx.db.query('mailCorpusThreads').first();
      await ctx.db.patch(row!._id, { jevLeaseId: item.leaseId, jevRetryAt: undefined });
    });
    expect((await store('Snippet 0')).stored).toBe(1);
  });

  test('a thread with open evidence skips the first stage; a current verdict costs no read', async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const item = (await t.mutation(api.jev.claimPending, { ...scope, limit: 12 })).items[0];
    await t.mutation(api.jev.storeAssessments, {
      ...scope,
      items: [
        {
          accountId: item.accountId,
          threadId: item.threadId,
          messageId: item.messageId,
          sourceRevision: item.sourceRevision,
          leaseId: item.leaseId,
          assessment: assessmentFromResponse(item, responseFor(item), NOW),
        },
      ],
    });
    expect((await threadRow(t))?.jevEvidenceMessageIds).toEqual(['m0']);
    // A queue flag on a current verdict settles without a claim item.
    await t.run(async (ctx) => {
      const row = await ctx.db.query('mailCorpusThreads').first();
      await ctx.db.patch(row!._id, { llmPending: true });
    });
    expect((await t.mutation(api.jev.claimPending, { ...scope, limit: 12 })).items).toEqual([]);
    expect((await threadRow(t))?.llmPending).toBeUndefined();
    // A forced pass (version 0) on a thread with evidence goes to the bodies at once.
    await t.run(async (ctx) => {
      const row = await ctx.db.query('mailCorpusThreads').first();
      await ctx.db.patch(row!._id, { llmPending: true, jevVersion: 0 });
    });
    const forced = (await t.mutation(api.jev.claimPending, { ...scope, limit: 12 })).items[0];
    expect(forced.facts).toBeUndefined();
    expect(forced.messages.map((message: any) => message.id)).toEqual(['m0']);
  });

  test('a new message on a judged thread keeps the whole open state in the window', async () => {
    const t = convexTest(schema, modules);
    await seed(t, 5);
    const item = (await t.mutation(api.jev.claimPending, { ...scope, limit: 12 })).items[0];
    expect(item.contextComplete).toBe(false);
    const bulk = { purpose: 'newsletter', subject_kind: 'general', reply: 0.02, reply_evidence: 'none' };
    await t.mutation(api.jev.storeAssessments, {
      ...scope,
      items: [
        {
          accountId: item.accountId,
          threadId: item.threadId,
          messageId: item.messageId,
          sourceRevision: item.sourceRevision,
          leaseId: item.leaseId,
          assessment: assessmentFromResponse(item, responseFor(item, bulk), NOW),
        },
      ],
    });
    expect((await threadRow(t))?.jevAssessedMessageId).toBe('m4');
    await t.mutation(api.mailCorpus.upsertCorpusBatch, {
      ...scope,
      accountId: 'a',
      grantId: 'grant-a',
      provider: 'google',
      threads: [],
      messages: [
        {
          providerMessageId: 'm5',
          providerThreadId: 't',
          subject: 'Weekly news',
          from: 'news@example.test',
          to: 'owner@example.test',
          receivedAt: NOW,
          snippet: 'Snippet 5',
          textBody: 'Part 5.',
          searchText: 'weekly news',
          labels: ['INBOX'],
        },
      ],
    });
    const next = (await t.mutation(api.jev.claimPending, { ...scope, limit: 12 })).items[0];
    expect(next.messageId).toBe('m5');
    expect(next.contextComplete).toBe(true);
  });
});
