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

const confirmationThread = {
  providerThreadId: 'thread-1',
  accountId: 'personal',
  subject: 'Your order confirmation: linen sheets',
  snippet: 'Order 4417 confirmed. New sheets ship Tuesday.',
  llmCategory: { primary: 'orders' },
};

const marketingThread = {
  providerThreadId: 'thread-2',
  accountId: 'personal',
  subject: 'Fresh linen sheets for summer — order today',
  snippet: 'New sheets, big confirmation of style',
  llmCategory: { primary: 'noise' },
};

describe('step watch conductor route', () => {
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
