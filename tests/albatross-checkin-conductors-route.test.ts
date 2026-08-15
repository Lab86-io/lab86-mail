import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createCheckinReflectionPost } from '../app/api/cron/checkin-reflection/route';
import { createCheckinTomorrowPost } from '../app/api/cron/checkin-tomorrow/route';
import { createEvidenceReconcilePost } from '../app/api/cron/evidence-reconcile/route';

function cronRequest(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('check-in background conductors', () => {
  test('reflection rejects requests that are not internal cron calls', async () => {
    const convexMutation = mock(async () => undefined);
    const post = createCheckinReflectionPost({
      isInternalCronRequest: () => false,
      generateTextForCurrentUser: mock(async () => ({ text: '{"completed":[]}' })) as any,
      convexMutation: convexMutation as any,
      reportError: mock(() => undefined),
    });
    const response = await post(
      cronRequest('/api/cron/checkin-reflection', {
        userId: 'user-1',
        checkinId: 'checkin-1',
        responseText: 'Finished it.',
        candidateItems: [],
      }),
    );

    expect(response.status).toBe(401);
    expect(convexMutation).not.toHaveBeenCalled();
  });

  test('reflection applies only parsed candidate identities', async () => {
    const convexMutation = mock(async () => ({ applied: 1, stale: false }));
    const post = createCheckinReflectionPost({
      isInternalCronRequest: () => true,
      generateTextForCurrentUser: mock(async () => ({
        text: '{"completed":[{"kind":"work","id":"work-1"}]}',
      })) as any,
      convexMutation: convexMutation as any,
      reportError: mock(() => undefined),
    });
    const response = await post(
      cronRequest('/api/cron/checkin-reflection', {
        userId: 'user-1',
        checkinId: 'checkin-1',
        responseText: 'I finished it.',
        candidateItems: [{ kind: 'work', id: 'work-1', title: 'Finish it' }],
      }),
    );

    expect(response.status).toBe(200);
    expect(convexMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ completed: [{ kind: 'work', id: 'work-1' }] }),
    );
  });

  test('tomorrow creation is idempotently keyed to the check-in before planning', async () => {
    const convexMutation = mock(async (_fn: any, args: any) =>
      args.externalId ? { workId: 'work-1', changed: true } : { stale: false },
    );
    const advanceWork = mock(async () => ({ status: 'ready', workId: 'work-1', planId: 'plan-1' })) as any;
    const post = createCheckinTomorrowPost({
      isInternalCronRequest: () => true,
      convexMutation: convexMutation as any,
      convexQuery: mock(async () => null) as any,
      advanceWork,
      reportError: mock(() => undefined),
    });
    const response = await post(
      cronRequest('/api/cron/checkin-tomorrow', {
        userId: 'user-1',
        checkinId: 'checkin-1',
        tomorrowIntentText: 'Call the DMV.',
        timezone: 'America/New_York',
      }),
    );

    expect(response.status).toBe(200);
    expect(convexMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        externalId: 'checkin:checkin-1:tomorrow',
        replaceRawText: true,
        returnMetadata: true,
      }),
    );
    expect(advanceWork).toHaveBeenCalledWith({
      userId: 'user-1',
      workId: 'work-1',
      timezone: 'America/New_York',
    });
  });

  test('tomorrow planning rejects requests that are not internal cron calls', async () => {
    const convexMutation = mock(async () => undefined);
    const post = createCheckinTomorrowPost({
      isInternalCronRequest: () => false,
      convexMutation: convexMutation as any,
      convexQuery: mock(async () => null) as any,
      advanceWork: mock(async () => ({ status: 'ready' })) as any,
      reportError: mock(() => undefined),
    });
    const response = await post(
      cronRequest('/api/cron/checkin-tomorrow', {
        userId: 'user-1',
        checkinId: 'checkin-1',
        tomorrowIntentText: 'Call the DMV.',
      }),
    );

    expect(response.status).toBe(401);
    expect(convexMutation).not.toHaveBeenCalled();
  });
});

describe('evidence reconciliation conductor', () => {
  test('rejects requests that are not internal cron calls', async () => {
    const convexMutation = mock(async () => undefined);
    const post = createEvidenceReconcilePost({
      isInternalCronRequest: () => false,
      advanceWork: mock(async () => ({ status: 'ready' })) as any,
      convexMutation: convexMutation as any,
      reportError: mock(() => undefined),
    });
    const response = await post(
      cronRequest('/api/cron/evidence-reconcile', {
        userId: 'user-1',
        workId: 'work-1',
        evidenceAt: 1,
      }),
    );

    expect(response.status).toBe(401);
    expect(convexMutation).not.toHaveBeenCalled();
  });

  test('rejects coercible non-number evidence watermarks', async () => {
    for (const evidenceAt of [null, false, '', '1786700000000']) {
      const convexMutation = mock(async () => undefined);
      const post = createEvidenceReconcilePost({
        isInternalCronRequest: () => true,
        advanceWork: mock(async () => ({ status: 'ready' })) as any,
        convexMutation: convexMutation as any,
        reportError: mock(() => undefined),
      });
      const response = await post(
        cronRequest('/api/cron/evidence-reconcile', {
          userId: 'user-1',
          workId: 'work-1',
          evidenceAt,
        }),
      );

      expect(response.status).toBe(400);
      expect(convexMutation).not.toHaveBeenCalled();
    }
  });

  test('advances once and acknowledges the exact evidence watermark', async () => {
    const convexMutation = mock(async () => undefined);
    const advanceWork = mock(async () => ({ status: 'ready', workId: 'work-1', planId: 'plan-2' })) as any;
    const post = createEvidenceReconcilePost({
      isInternalCronRequest: () => true,
      advanceWork,
      convexMutation: convexMutation as any,
      reportError: mock(() => undefined),
    });
    const response = await post(
      cronRequest('/api/cron/evidence-reconcile', {
        userId: 'user-1',
        workId: 'work-1',
        evidenceAt: 1_786_700_000_000,
      }),
    );

    expect(response.status).toBe(200);
    expect(advanceWork).toHaveBeenCalledWith({ userId: 'user-1', workId: 'work-1' });
    expect(convexMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workId: 'work-1', evidenceAt: 1_786_700_000_000 }),
    );
  });
});
