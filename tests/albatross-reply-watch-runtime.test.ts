import { describe, expect, test } from 'bun:test';
import { getFunctionName } from 'convex/server';
import { convexTest } from 'convex-test';
import { api, internal } from '../convex/_generated/api';
import schema from '../convex/schema';
import { buildAlbatrossDailyReportContextFromLive } from '../lib/albatross/daily-report';
import { checkWaitingReplies } from '../lib/albatross/reply-watch-runtime';

const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/albatrossReplies.ts': () => import('../convex/albatrossReplies'),
  '../convex/albatrossWorkV2.ts': () => import('../convex/albatrossWorkV2'),
  '../convex/albatrossWork.ts': () => import('../convex/albatrossWork'),
  '../convex/narrative.ts': () => import('../convex/narrative'),
};
const userId = 'reply-user';
const ownEmail = 'me@example.com';
const sender = 'jolie@example.com';
const sentAt = Date.now() - 100_000;

test('the Brief caps active work after prioritizing resumed conversations', () => {
  const resumedWork = Array.from({ length: 12 }, (_, i) => ({
    id: `resumed-${i}`,
    title: `Work ${i}`,
    reply: { from: sender, subject: 'Update', reason: 'Ready' },
  }));
  const context = buildAlbatrossDailyReportContextFromLive({
    resumedWork,
    applications: [{ intentId: 'other', status: 'queued' }],
  });
  expect(context.activeIntents.map((row) => row.id)).toEqual(resumedWork.slice(0, 6).map((row) => row.id));
});

async function setup() {
  const t = convexTest(schema, modules);
  const user = t.withIdentity({ subject: userId });
  const workId = await t.run(async (ctx) => {
    await ctx.db.insert('connectedAccounts', {
      userId,
      accountId: 'personal',
      email: ownEmail,
      provider: 'google',
      status: 'connected',
      grantId: 'grant',
      scopes: [],
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert('mailCorpusThreads', {
      userId,
      accountId: 'personal',
      provider: 'google',
      grantId: 'grant',
      providerThreadId: 'llc',
      subject: 'LLC advice',
      fromAddress: ownEmail,
      snippet: 'Sent question',
      lastDate: sentAt,
      labels: ['SENT'],
      unread: false,
      yearMonth: '2026-09',
      createdAt: 1,
      updatedAt: 1,
    });
    return ctx.db.insert('albatrossIntents', {
      userId,
      title: 'Form LLC',
      rawText: 'Form LLC',
      source: 'chat',
      status: 'ready',
      workState: 'active',
      // Previously a partial report could falsely satisfy this contract and auto-close it.
      contract: { outcome: 'LLC formed', closeWhen: 'outcome_confirmed', proofs: [], updatedAt: 1 },
      createdAt: 1,
      updatedAt: 1,
    });
  });
  async function message(overrides: Record<string, any> = {}) {
    return t.run((ctx) =>
      ctx.db.insert('mailCorpusMessages', {
        userId,
        accountId: 'personal',
        provider: 'google',
        grantId: 'grant',
        providerThreadId: 'llc',
        providerMessageId: `message-${Math.random()}`,
        from: sender,
        to: ownEmail,
        subject: 'Re: LLC advice',
        snippet: 'Here is the LLC advice you requested.',
        textBody: 'Here is the LLC advice you requested.',
        searchText: 'LLC advice',
        receivedAt: sentAt + 10,
        labels: ['INBOX'],
        yearMonth: '2026-09',
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
      }),
    );
  }
  await message({ from: ownEmail, to: sender, receivedAt: sentAt, labels: ['SENT'] });
  const record = (overrides: Record<string, any> = {}) =>
    user.mutation(api.albatrossReplies.recordProgress, {
      workId,
      claim: 'I sent Jolie an email. Waiting for her advice.',
      sourceId: 'progress-1',
      waitingForReply: {
        accountId: 'personal',
        threadId: 'llc',
        requirement: 'Jolie replies with advice about setting up the LLC.',
      },
      ...overrides,
    });
  function deps(
    verdict: (input: any) => Promise<any> = async () => ({
      satisfies: true,
      reason: 'Jolie replied with the requested LLC advice.',
    }),
  ) {
    return {
      convexQuery: ((fn: any, args: any) => {
        const { userId: _user, ...rest } = args;
        return user.query(fn, rest);
      }) as any,
      convexMutation: ((fn: any, args: any) => {
        const { userId: _user, ...rest } = args;
        return user.mutation(fn, rest);
      }) as any,
      evidenceSatisfies: verdict,
    };
  }
  return { t, user, workId, message, record, deps };
}

describe('waiting for an email reply', () => {
  test('bounded reply scans resume at their durable cursor and reject stale checkpoints', async () => {
    const s = await setup();
    await s.record();
    const initial = await s.user.query(api.albatrossReplies.waiting, {});
    const base = s.deps();
    const visited: number[] = [];
    const dependencies = {
      ...base,
      convexQuery: (async (fn: any, args: any) => {
        if (getFunctionName(fn) !== 'albatrossReplies:messages') return base.convexQuery(fn, args);
        const page = Number(args.paginationOpts.cursor || 0);
        visited.push(page);
        return { page: [], isDone: page === 12, continueCursor: String(page + 1) };
      }) as any,
    };
    expect(await checkWaitingReplies({ userId }, dependencies)).toMatchObject({
      unavailable: true,
      resumed: 0,
    });
    expect(visited).toEqual(Array.from({ length: 10 }, (_, i) => i));
    expect((await s.user.query(api.albatrossReplies.waiting, {})).scanCursor).toBe('10');
    expect(
      await s.user.mutation(api.albatrossReplies.checkpoint, {
        watchKey: initial.watchKey,
        previousCursor: null,
        cursor: 'stale',
      }),
    ).toBe(false);
    expect(await checkWaitingReplies({ userId }, dependencies)).toMatchObject({
      unavailable: false,
      resumed: 0,
    });
    expect(visited.slice(10)).toEqual([10, 11, 12]);
    expect((await s.user.query(api.albatrossReplies.waiting, {})).scanCursor).toBeNull();
    await s.user.mutation(api.albatrossWorkV2.releaseWork, { workId: s.workId });
    expect(
      await s.user.mutation(api.albatrossReplies.checkpoint, {
        watchKey: initial.watchKey,
        previousCursor: null,
        cursor: 'old-watch',
      }),
    ).toBe(false);
  });
  test('saves progress and a watch atomically; retries neither duplicate the report nor move the cutoff', async () => {
    const s = await setup();
    const first = await s.record();
    expect(first.state).toBe('waiting');
    expect(first.waitingForReply).toMatchObject({ senderEmails: [sender], after: sentAt });
    expect(await s.record()).toEqual(first);
    const evidence = await s.t.run((ctx) => ctx.db.query('albatrossEvidence').collect());
    expect(evidence).toHaveLength(1);
    expect(evidence[0].claim).toContain('Waiting for her advice');
    expect(await s.t.run((ctx) => ctx.db.get(s.workId))).toMatchObject({ workState: 'waiting' });
    expect(await s.t.query(internal.albatrossWorkV2.mailWatchCandidates, {})).toEqual([
      { userId, workId: s.workId },
    ]);
    expect(
      await s.t.mutation(internal.albatrossWorkV2.beginEvidenceReconcile, { workId: s.workId }),
    ).toBeNull();
    expect(await s.t.query(internal.albatrossWorkV2.evidenceReconcileCandidates, {})).toEqual([]);
  });

  test('partial progress cannot complete an outcome, even with an empty proof contract', async () => {
    const s = await setup();
    await s.record({ waitingForReply: undefined });
    expect(await s.t.run((ctx) => ctx.db.get(s.workId))).toMatchObject({
      workState: 'active',
      status: 'ready',
    });
    await s.user.mutation(api.albatrossWorkV2.attachProof, {
      workId: s.workId,
      claim: 'Sent an email',
      title: 'Progress source',
      sourceKind: 'manual',
      sourceId: 'optional-source',
      trust: 'observed',
      settleContract: false,
    });
    expect(await s.t.run((ctx) => ctx.db.get(s.workId))).toMatchObject({ workState: 'active' });
  });

  test('scans beyond the first page, accepts a relevant new thread, and feeds the same brief', async () => {
    const s = await setup();
    await s.record();
    for (let i = 0; i < 105; i++) await s.message({ from: 'news@example.com', receivedAt: sentAt + i + 1 });
    await s.message({ providerThreadId: 'new-thread', receivedAt: sentAt + 200, labels: ['ARCHIVE'] });
    let checks = 0;
    const result = await checkWaitingReplies(
      { userId },
      s.deps(async (input) => {
        checks++;
        expect(input.evidenceText).toContain('Here is the LLC advice');
        return { satisfies: true, reason: 'The LLC advice arrived.' };
      }),
    );
    expect(result).toMatchObject({ watched: 1, resumed: 1 });
    expect(checks).toBe(1);
    const work = await s.t.run((ctx) => ctx.db.get(s.workId));
    expect(work).toMatchObject({
      workState: 'active',
      horizon: { kind: 'now' },
      replyArrived: { threadId: 'new-thread' },
    });
    expect(work?.replyWatch).toBeUndefined();
    const live = await s.user.query(api.albatrossWork.dailyReportContext, {});
    const context = buildAlbatrossDailyReportContextFromLive(live);
    expect(context.activeIntents[0]).toMatchObject({ id: s.workId, status: 'active' });
    expect(context.activeIntents[0].text).toContain('active again');
    expect(context.activeIntents[0].text).toContain('LLC advice arrived');
    expect(await checkWaitingReplies({ userId }, s.deps())).toMatchObject({ watched: 0, resumed: 0 });
    expect(await s.t.run((ctx) => ctx.db.query('albatrossEvidence').collect())).toHaveLength(2);
  });

  test('sent mail, old replies, other accounts, automatic replies, and other users never reach the gate', async () => {
    const s = await setup();
    await s.record();
    await s.message({ receivedAt: sentAt - 1 });
    await s.message({ from: ownEmail, labels: ['SENT'] });
    await s.message({ accountId: 'other-account' });
    await s.message({ userId: 'other-user' });
    await s.message({ subject: 'Out of office: LLC advice' });
    await s.message({ headers: [{ name: 'Auto-Submitted', value: 'auto-replied' }] });
    await s.message({ headers: { 'List-Id': 'newsletter.example.com' } });
    let checks = 0;
    expect(
      await checkWaitingReplies(
        { userId },
        s.deps(async () => {
          checks++;
          return { satisfies: true, reason: 'bad' };
        }),
      ),
    ).toMatchObject({ resumed: 0 });
    expect(checks).toBe(0);
    expect((await s.t.run((ctx) => ctx.db.get(s.workId)))?.workState).toBe('waiting');
  });

  test('unrelated mail and an unavailable model leave the watch armed for the next brief', async () => {
    const s = await setup();
    await s.record();
    await s.message();
    expect(
      await checkWaitingReplies(
        { userId },
        s.deps(async () => ({ satisfies: false, reason: 'Unrelated' })),
      ),
    ).toMatchObject({ resumed: 0 });
    expect(
      await checkWaitingReplies(
        { userId },
        s.deps(async () => ({ satisfies: false, reason: 'Unavailable', unavailable: true })),
      ),
    ).toMatchObject({ resumed: 0, unavailable: true });
    expect((await s.t.run((ctx) => ctx.db.get(s.workId)))?.replyWatch).toBeDefined();
    expect(await checkWaitingReplies({ userId }, s.deps())).toMatchObject({ resumed: 1 });
  });

  test('a pause racing the semantic check wins; resuming manually cancels the saved watch', async () => {
    const s = await setup();
    await s.record();
    await s.message();
    const result = await checkWaitingReplies(
      { userId },
      s.deps(async () => {
        await s.user.mutation(api.albatrossWorkV2.updateWorkState, { workId: s.workId, state: 'paused' });
        return { satisfies: true, reason: 'Reply' };
      }),
    );
    expect(result.resumed).toBe(0);
    expect(await s.t.run((ctx) => ctx.db.get(s.workId))).toMatchObject({ workState: 'paused' });
    expect((await s.t.run((ctx) => ctx.db.get(s.workId)))?.replyWatch).toBeUndefined();
  });

  test('a replacement watch cannot be resumed by an older scan', async () => {
    const s = await setup();
    const original = await s.record();
    const messageId = await s.message();
    const replacement = await s.record({
      waitingForReply: {
        accountId: 'personal',
        threadId: 'llc',
        requirement: 'Wait for the final filing documents instead of advice',
      },
    });
    expect(replacement.waitingForReply?.id).not.toBe(original.waitingForReply?.id);
    expect(
      await s.user.mutation(api.albatrossReplies.resume, {
        workId: s.workId,
        watchId: original.waitingForReply!.id,
        messageId,
        reason: 'Old advice',
      }),
    ).toEqual({ resumed: false });
    // A stale plan-watch completion must not disarm the replacement reply watch.
    await s.user.mutation(api.albatrossWorkV2.completeMailWatch, { workId: s.workId, stillWatching: false });
    const work = await s.t.run((ctx) => ctx.db.get(s.workId));
    expect(work?.replyWatch?.id).toBe(replacement.waitingForReply?.id);
    expect(work?.mailWatchAt).toBeDefined();
  });

  test('completion and release cancel watches and reject late wake attempts', async () => {
    for (const end of ['done', 'released']) {
      const s = await setup();
      const original = await s.record();
      const messageId = await s.message();
      if (end === 'done')
        await s.user.mutation(api.albatrossWorkV2.completeWork, {
          workId: s.workId,
          claim: 'Handled it another way.',
        });
      else await s.user.mutation(api.albatrossWorkV2.releaseWork, { workId: s.workId });
      expect(
        await s.user.mutation(api.albatrossReplies.resume, {
          workId: s.workId,
          watchId: original.waitingForReply!.id,
          messageId,
          reason: 'Late reply',
        }),
      ).toEqual({ resumed: false });
      await s.user.mutation(api.albatrossWorkV2.completeMailWatch, { workId: s.workId, stillWatching: true });
      const work = await s.t.run((ctx) => ctx.db.get(s.workId));
      expect(work?.workState).toBe(end);
      expect(work?.replyWatch).toBeUndefined();
      expect(work?.mailWatchAt).toBeUndefined();
    }
  });

  test('the brief leaves waiting applications out of active intents while preserving shared projects', () => {
    const context = buildAlbatrossDailyReportContextFromLive({
      workStates: [{ id: 'waiting-work', workState: 'waiting' }],
      applications: [{ intentId: 'waiting-work', status: 'partially_applied', intentText: 'LLC' }],
      projects: [{ _id: 'shared', sourceIntentId: 'waiting-work', title: 'Business', status: 'active' }],
    });
    expect(context.activeIntents).toEqual([]);
    expect(context.activeProjects).toHaveLength(1);
  });

  test('ownership, invalid ids and invalid watch sources fail without partially saved state', async () => {
    const s = await setup();
    await expect(
      s.t.withIdentity({ subject: 'intruder' }).mutation(api.albatrossReplies.recordProgress, {
        workId: s.workId,
        claim: 'Hi',
        sourceId: 'intruder',
      }),
    ).rejects.toThrow(/Albatross not found/);
    await expect(s.record({ workId: 'work-title-instead-of-id' })).rejects.toThrow(/Albatross not found/);
    await expect(
      s.record({ waitingForReply: { accountId: 'personal', threadId: 'wrong', requirement: 'Reply' } }),
    ).rejects.toThrow(/Find the sent email first/);
    expect(await s.t.run((ctx) => ctx.db.query('albatrossEvidence').collect())).toHaveLength(0);
    expect((await s.t.run((ctx) => ctx.db.get(s.workId)))?.workState).toBe('active');
  });

  test('a progress question cannot mutate a different Work, and an answer does not replan waiting Work', async () => {
    const s = await setup();
    const questionId = await s.user.mutation(api.albatrossWorkV2.upsertQuestion, {
      workId: s.workId,
      kind: 'clarification',
      prompt: 'Who are you waiting for?',
    });
    await s.record();
    const projected = await s.user.query(api.albatrossWorkV2.allWork, {});
    expect(projected.find((row) => row._id === s.workId)?.replyWatch).toBeDefined();
    expect(await s.user.query(api.albatrossWorkV2.livePendingQuestions, {})).toEqual([]);
    expect(
      await s.user.query(api.albatrossWorkV2.inactiveBriefRefs, { refs: [{ kind: 'work', id: s.workId }] }),
    ).toEqual([s.workId]);
    await expect(
      s.user.mutation(api.albatrossWorkV2.answerQuestion, {
        questionId,
        expectedWorkId: 'different-work',
        answer: 'Jolie',
      }),
    ).rejects.toThrow(/not attached/);
    const answer = await s.user.mutation(api.albatrossWorkV2.answerQuestion, {
      questionId,
      expectedWorkId: s.workId,
      answer: 'Jolie',
    });
    expect(answer.shouldAdvance).toBe(false);
    expect(await s.t.run((ctx) => ctx.db.get(s.workId))).toMatchObject({
      workState: 'waiting',
      agentState: 'idle',
    });
  });
});
