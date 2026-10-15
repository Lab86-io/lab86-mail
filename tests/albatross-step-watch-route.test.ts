import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createStepWatchPost } from '../app/api/cron/step-watch/route';

function watchRequest(body: unknown) {
  return new NextRequest('http://localhost/api/cron/step-watch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const sheetsStep = {
  key: 'physical-1',
  identity: 'step:physical:order new sheets',
  title: 'Order new sheets',
  doneWhen: 'The order confirmation arrives.',
  evidenceKind: 'mail_confirmation',
  evidenceHint: 'Order confirmation from the linen shop',
  done: false,
};

const detail = {
  work: { _id: 'work-1', title: 'Order new sheets for Tree' },
  plan: { outcome: 'The new sheets are ordered' },
  execution: { guideSteps: [sheetsStep] },
};

// The real listRecentCorpusThreads row shape: `_id` is the provider thread
// id, and `account` is the account id.
const confirmationThread = {
  _id: 'thread-1',
  account: 'personal',
  subject: 'Your order confirmation: linen sheets',
  snippet: 'Order 4417 confirmed. New sheets ship Tuesday.',
  smartCategory: { primary: 'orders' },
};

const marketingThread = {
  _id: 'thread-2',
  account: 'personal',
  subject: 'Fresh linen sheets for summer — order today',
  snippet: 'New sheets, big confirmation of style',
  smartCategory: { primary: 'noise' },
};

describe('step watch conductor route', () => {
  test('a saved reply watch runs without a planned mail-confirmation step', async () => {
    const watch = {
      id: 'watch-1',
      accountId: 'personal',
      threadId: 'llc',
      senderEmails: ['jolie@example.com'],
      requirement: 'LLC advice',
      after: 100,
      startedAt: 200,
    };
    const mutations: any[] = [];
    const completeWorkStep = mock(async () => ({ ok: true }));
    const post = createStepWatchPost({
      isInternalCronRequest: () => true,
      convexQuery: (async (fn: any) => {
        const { getFunctionName } = await import('convex/server');
        const name = getFunctionName(fn);
        if (name.endsWith(':workDetail')) return { work: { workState: 'waiting', replyWatch: watch } };
        if (name.endsWith(':waiting'))
          return { selfEmails: ['me@example.com'], watches: [{ workId: 'work-1', title: 'LLC', watch }] };
        return {
          page: [
            {
              _id: 'message-1',
              accountId: 'personal',
              providerThreadId: 'llc',
              from: 'jolie@example.com',
              subject: 'LLC advice',
              snippet: 'The requested advice',
              receivedAt: 300,
              labels: [],
            },
          ],
          isDone: true,
          continueCursor: '',
        };
      }) as any,
      convexMutation: (async (_fn: any, args: any) => {
        mutations.push(args);
        return { resumed: true };
      }) as any,
      evidenceSatisfies: async () => ({ satisfies: true, reason: 'Advice arrived' }),
      completeWorkStep: completeWorkStep as any,
    });
    const response = await post(watchRequest({ userId: 'user-1', workId: 'work-1' }));
    expect(await response.json()).toMatchObject({ ok: true, resumed: 1, completedSteps: 0 });
    expect(completeWorkStep).not.toHaveBeenCalled();
    expect(mutations.some((args) => args.watchId === 'watch-1' && args.messageId === 'message-1')).toBe(true);
  });
  test('rejects requests that are not internal cron calls', async () => {
    const convexMutation = mock(async () => undefined);
    const post = createStepWatchPost({
      isInternalCronRequest: () => false,
      convexMutation: convexMutation as any,
    });
    const response = await post(watchRequest({ userId: 'user-1', workId: 'work-1' }));
    expect(response.status).toBe(401);
    expect(convexMutation).not.toHaveBeenCalled();
  });

  test('a confirmed receipt checks the step off with step-bound evidence', async () => {
    const mutations: any[] = [];
    const completeWorkStep = mock(async () => ({ ok: true }));
    const post = createStepWatchPost({
      isInternalCronRequest: () => true,
      convexQuery: mock(async (_fn: any, args: any) =>
        args.workId ? detail : [confirmationThread, marketingThread],
      ) as any,
      convexMutation: mock(async (_fn: any, args: any) => {
        mutations.push(args);
        return undefined;
      }) as any,
      completeWorkStep: completeWorkStep as any,
      evidenceSatisfies: mock(async () => ({ satisfies: true, reason: 'The order is confirmed.' })) as any,
      reportError: mock(() => undefined),
    });
    const response = await post(watchRequest({ userId: 'user-1', workId: 'work-1' }));
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, watched: 1, completedSteps: 1, stillWatching: false });
    const proof = mutations.find((args) => args.sourceKind === 'mail_thread');
    expect(proof).toMatchObject({
      stepIdentity: 'step:physical:order new sheets',
      sourceId: 'thread-1',
      accountId: 'personal',
      trust: 'observed',
    });
    expect(completeWorkStep).toHaveBeenCalledWith({
      userId: 'user-1',
      workId: 'work-1',
      stepKey: 'physical-1',
      source: 'evidence',
    });
    const watchDone = mutations.find((args) => typeof args.stillWatching === 'boolean');
    expect(watchDone?.stillWatching).toBe(false);
  });

  test('one satisfied step out of two completes partially and keeps watching', async () => {
    const secondStep = {
      ...sheetsStep,
      key: 'physical-2',
      identity: 'step:physical:book the massage',
      title: 'Book the massage',
      doneWhen: 'The booking confirmation arrives.',
      evidenceHint: 'Booking confirmation from the studio',
    };
    const twoStepDetail = { ...detail, execution: { guideSteps: [sheetsStep, secondStep] } };
    const completeWorkStep = mock(async () => ({ ok: true }));
    const mutations: any[] = [];
    const post = createStepWatchPost({
      isInternalCronRequest: () => true,
      convexQuery: mock(async (_fn: any, args: any) =>
        args.workId ? twoStepDetail : [confirmationThread],
      ) as any,
      convexMutation: mock(async (_fn: any, args: any) => {
        mutations.push(args);
        return undefined;
      }) as any,
      completeWorkStep: completeWorkStep as any,
      // Only the sheets step matches the sheets confirmation.
      evidenceSatisfies: mock(async (input: any) => ({
        satisfies: input.requirement.includes('order confirmation'),
        reason: 'Judged.',
      })) as any,
      reportError: mock(() => undefined),
    });
    const response = await post(watchRequest({ userId: 'user-1', workId: 'work-1' }));
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, watched: 2, completedSteps: 1, stillWatching: true });
    expect(completeWorkStep).toHaveBeenCalledTimes(1);
    expect(completeWorkStep).toHaveBeenCalledWith(expect.objectContaining({ stepKey: 'physical-1' }));
    const watchDone = mutations.find((args) => typeof args.stillWatching === 'boolean');
    expect(watchDone?.stillWatching).toBe(true);
  });

  test('a refuted match completes nothing and keeps watching', async () => {
    const completeWorkStep = mock(async () => ({ ok: true }));
    const mutations: any[] = [];
    const post = createStepWatchPost({
      isInternalCronRequest: () => true,
      convexQuery: mock(async (_fn: any, args: any) => (args.workId ? detail : [confirmationThread])) as any,
      convexMutation: mock(async (_fn: any, args: any) => {
        mutations.push(args);
        return undefined;
      }) as any,
      completeWorkStep: completeWorkStep as any,
      evidenceSatisfies: mock(async () => ({ satisfies: false, reason: 'Not this order.' })) as any,
      reportError: mock(() => undefined),
    });
    const response = await post(watchRequest({ userId: 'user-1', workId: 'work-1' }));
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, completedSteps: 0, stillWatching: true });
    expect(completeWorkStep).not.toHaveBeenCalled();
    expect(mutations.some((args) => args.sourceKind === 'mail_thread')).toBe(false);
  });

  test('an unavailable gate fails closed', async () => {
    const completeWorkStep = mock(async () => ({ ok: true }));
    const post = createStepWatchPost({
      isInternalCronRequest: () => true,
      convexQuery: mock(async (_fn: any, args: any) => (args.workId ? detail : [confirmationThread])) as any,
      convexMutation: mock(async () => undefined) as any,
      completeWorkStep: completeWorkStep as any,
      evidenceSatisfies: mock(async () => ({
        satisfies: false,
        reason: 'The check did not run.',
        unavailable: true,
      })) as any,
      reportError: mock(() => undefined),
    });
    const response = await post(watchRequest({ userId: 'user-1', workId: 'work-1' }));
    const body = await response.json();
    expect(body.completedSteps).toBe(0);
    expect(completeWorkStep).not.toHaveBeenCalled();
  });

  test('marketing mail never reaches the gate', async () => {
    const evidenceGate = mock(async () => ({ satisfies: true, reason: 'x' }));
    const post = createStepWatchPost({
      isInternalCronRequest: () => true,
      convexQuery: mock(async (_fn: any, args: any) => (args.workId ? detail : [marketingThread])) as any,
      convexMutation: mock(async () => undefined) as any,
      completeWorkStep: mock(async () => ({ ok: true })) as any,
      evidenceSatisfies: evidenceGate as any,
      reportError: mock(() => undefined),
    });
    await post(watchRequest({ userId: 'user-1', workId: 'work-1' }));
    expect(evidenceGate).not.toHaveBeenCalled();
  });

  test('a step with a confirmed verification is final and is never watched again', async () => {
    const mutations: any[] = [];
    const gate = mock(async () => ({ satisfies: true, reason: 'x' }));
    const post = createStepWatchPost({
      isInternalCronRequest: () => true,
      convexQuery: mock(async () => ({
        ...detail,
        execution: {
          guideSteps: [
            {
              ...sheetsStep,
              done: false,
              verification: { level: 'confirmed', evidenceTitle: 'Order received', evidenceUrl: null },
            },
          ],
        },
      })) as any,
      convexMutation: mock(async (_fn: any, args: any) => {
        mutations.push(args);
        return undefined;
      }) as any,
      completeWorkStep: mock(async () => ({ ok: true })) as any,
      evidenceSatisfies: gate as any,
      reportError: mock(() => undefined),
    });
    const response = await post(watchRequest({ userId: 'user-1', workId: 'work-1' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, watched: 0, completedSteps: 0 });
    expect(gate).not.toHaveBeenCalled();
    expect(mutations).toEqual([{ userId: 'user-1', workId: 'work-1', stillWatching: false }]);
  });

  test('no outstanding mail steps stands the watch down', async () => {
    const mutations: any[] = [];
    const post = createStepWatchPost({
      isInternalCronRequest: () => true,
      convexQuery: mock(async () => ({
        ...detail,
        execution: { guideSteps: [{ ...sheetsStep, done: true }] },
      })) as any,
      convexMutation: mock(async (_fn: any, args: any) => {
        mutations.push(args);
        return undefined;
      }) as any,
      completeWorkStep: mock(async () => ({ ok: true })) as any,
      evidenceSatisfies: mock(async () => ({ satisfies: true, reason: 'x' })) as any,
      reportError: mock(() => undefined),
    });
    const response = await post(watchRequest({ userId: 'user-1', workId: 'work-1' }));
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, watched: 0 });
    expect(mutations[0]?.stillWatching).toBe(false);
  });
});

describe('the mail watch of a goal Work (docs/albatross-goal-runs.md)', () => {
  const goalDetail = {
    work: { _id: 'work-g', title: 'July invoice', workState: 'active' },
    plan: { outcome: 'July invoice', digitalActions: [], physicalActions: [] },
    execution: { guideSteps: [] },
    goalRuns: true,
    contract: {
      outcome: 'The client has the July invoice',
      proofs: [
        { id: 'send-0', what: 'The message left your account' },
        { id: 'send-1', what: 'The person acknowledged it' },
        { id: 'done', what: 'Settled before', satisfiedAt: 5 },
      ],
      closeWhen: 'outcome_likely',
    },
  };
  const sentThread = {
    _id: 'thread-sent',
    account: 'work',
    subject: 'July invoice',
    snippet: 'Attached is the July invoice and the W-9.',
    fromAddress: 'me@example.com',
    lastDate: Date.UTC(2026, 9, 15),
    labels: ['SENT'],
  };

  function goalPost(options: { detail?: any; threads?: any[]; gate?: (input: any) => any } = {}) {
    const mutations: any[] = [];
    const gate = mock(
      options.gate ??
        (async (input: any) => ({
          satisfies:
            input.requirement === 'The message left your account' && input.evidenceText.includes('SENT'),
          reason: 'The sent folder has it.',
        })),
    );
    const completeWorkStep = mock(async () => ({ ok: true }));
    const post = createStepWatchPost({
      isInternalCronRequest: () => true,
      convexQuery: mock(async (_fn: any, args: any) =>
        args.workId ? (options.detail ?? goalDetail) : (options.threads ?? [sentThread, marketingThread]),
      ) as any,
      convexMutation: mock(async (_fn: any, args: any) => {
        mutations.push(args);
        return undefined;
      }) as any,
      completeWorkStep: completeWorkStep as any,
      evidenceSatisfies: gate as any,
      reportError: mock(() => undefined),
      watchesPaused: async () => false,
    });
    return { post, mutations, gate, completeWorkStep };
  }

  test('a sent message settles its contract proof, and the watch goes on for the reply', async () => {
    const { post, mutations, gate, completeWorkStep } = goalPost();
    const response = await post(watchRequest({ userId: 'user-1', workId: 'work-g' }));
    expect(await response.json()).toEqual({
      ok: true,
      watched: 0,
      completedSteps: 0,
      watchedProofs: 2,
      settledProofs: 1,
      stillWatching: true,
    });
    const input = gate.mock.calls[0][0] as any;
    expect(input.requirement).toBe('The message left your account');
    expect(input.outcome).toBe('The client has the July invoice');
    expect(input.evidenceText).toBe(
      'Subject: July invoice\nFrom: me@example.com\nFolders: SENT\nDate: 2026-10-15\nText: Attached is the July invoice and the W-9.',
    );
    expect(input.source).toBeUndefined();
    expect(mutations.find((args) => args.sourceKind === 'mail_thread')).toEqual({
      userId: 'user-1',
      workId: 'work-g',
      claim: 'The message left your account: The sent folder has it.',
      title: 'July invoice',
      summary: 'Attached is the July invoice and the W-9.',
      sourceKind: 'mail_thread',
      sourceId: 'thread-sent',
      accountId: 'work',
      trust: 'inferred',
      proofId: 'send-0',
      settleContract: true,
    });
    expect(completeWorkStep).not.toHaveBeenCalled();
    expect(mutations.at(-1)).toMatchObject({ workId: 'work-g', stillWatching: true });
  });

  test('every proof settled ends the watch; nothing shown keeps it', async () => {
    const all = goalPost({ gate: async () => ({ satisfies: true, reason: 'Shown.' }) });
    expect(await (await all.post(watchRequest({ userId: 'user-1', workId: 'work-g' }))).json()).toMatchObject(
      {
        settledProofs: 2,
        stillWatching: false,
      },
    );
    const none = goalPost({ gate: async () => ({ satisfies: false, reason: 'No.' }) });
    expect(
      await (await none.post(watchRequest({ userId: 'user-1', workId: 'work-g' }))).json(),
    ).toMatchObject({
      settledProofs: 0,
      stillWatching: true,
    });
    expect(none.mutations.some((args) => args.sourceKind === 'mail_thread')).toBe(false);
    // An unavailable gate settles nothing.
    const down = goalPost({ gate: async () => ({ satisfies: true, reason: '', unavailable: true }) });
    await down.post(watchRequest({ userId: 'user-1', workId: 'work-g' }));
    expect(down.mutations.some((args) => args.sourceKind === 'mail_thread')).toBe(false);
  });

  test('a Work that is not a goal Work, or has no open proof, is not watched against its contract', async () => {
    for (const detail of [
      { ...goalDetail, goalRuns: false },
      {
        ...goalDetail,
        contract: { ...goalDetail.contract, proofs: [{ id: 'x', what: 'Done', satisfiedAt: 1 }] },
      },
      { ...goalDetail, contract: null },
    ]) {
      const { post, gate, mutations } = goalPost({ detail });
      expect(await (await post(watchRequest({ userId: 'user-1', workId: 'work-g' }))).json()).toEqual({
        ok: true,
        watched: 0,
        completedSteps: 0,
      });
      expect(gate).not.toHaveBeenCalled();
      expect(mutations.at(-1)).toMatchObject({ stillWatching: false });
    }
  });

  test('each pass judges only threads newer than the last pass, and moves the mark forward', async () => {
    const older = { ...sentThread, _id: 'old', lastDate: Date.UTC(2026, 9, 10) };
    const newer = { ...sentThread, _id: 'new', lastDate: Date.UTC(2026, 9, 16) };
    const marked = { ...goalDetail, work: { ...goalDetail.work, goalWatchAfter: Date.UTC(2026, 9, 12) } };
    const { post, gate, mutations } = goalPost({
      detail: marked,
      threads: [older, newer],
      gate: async () => ({ satisfies: false, reason: 'No.' }),
    });
    await post(watchRequest({ userId: 'user-1', workId: 'work-g' }));
    expect(gate.mock.calls.length).toBeGreaterThan(0);
    for (const call of gate.mock.calls) expect((call[0] as any).evidenceText).toContain('Date: 2026-10-16');
    expect(mutations.at(-1)).toMatchObject({ stillWatching: true, goalWatchAfter: Date.UTC(2026, 9, 16) });

    // Nothing new: no gate call at all, and the mark stays.
    const quiet = goalPost({
      detail: { ...goalDetail, work: { ...goalDetail.work, goalWatchAfter: Date.UTC(2026, 9, 16) } },
      threads: [older, newer],
    });
    const response = await quiet.post(watchRequest({ userId: 'user-1', workId: 'work-g' }));
    expect(await response.json()).toMatchObject({ settledProofs: 0, stillWatching: true });
    expect(quiet.gate).not.toHaveBeenCalled();
    expect(quiet.mutations.at(-1)).not.toHaveProperty('goalWatchAfter');
  });

  test('a thread with only a subject still reads as evidence', async () => {
    const { post, gate } = goalPost({
      threads: [{ _id: 't', account: 'work', subject: 'July invoice', snippet: '' }],
      gate: async () => ({ satisfies: false, reason: 'No.' }),
    });
    await post(watchRequest({ userId: 'user-1', workId: 'work-g' }));
    expect((gate.mock.calls[0][0] as any).evidenceText).toBe('Subject: July invoice');
  });
});
