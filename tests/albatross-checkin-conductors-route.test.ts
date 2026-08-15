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
});

describe('evidence reconciliation conductor', () => {
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
