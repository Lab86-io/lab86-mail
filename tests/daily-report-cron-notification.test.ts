import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createDailyReportPost, localDateForTimezone } from '../app/api/cron/daily-report/route';
import { notifyBriefReady } from '../lib/mail/brief-ready';
import { generateDailyReportTool } from '../lib/tools/daily-report';

function request(body: unknown, host = 'mail.lab86.io') {
  return new NextRequest('https://mail.lab86.io/api/cron/daily-report', {
    method: 'POST',
    headers: { host, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function dependencies() {
  return {
    isInternalCronRequest: mock(() => true),
    isStagingRuntime: mock(() => false),
    generateReport: mock(async () => ({
      _id: 'report_1',
      generatedAt: Date.parse('2026-07-25T02:30:00.000Z'),
      artifactStatus: 'ready',
      prose: { lede: 'Maya waits on the venue. Friday is open.', weekAhead: '', model: 'local' },
    })),
    queueBriefReady: mock(async () => ({ notificationId: 'notification_1', created: true })),
    dispatchNativeNotification: mock(async () => ({ sent: 1 })),
  };
}

describe('daily brief cron and completion notifications', () => {
  test('cron persists a background job and returns without waiting for generation', async () => {
    const deps = {
      ...dependencies(),
      enqueue: mock(async () => ({ jobId: 'job', reportId: 'report', started: true })),
    };
    const response = await createDailyReportPost(deps as any)(
      request({ userId: 'owner', kind: 'morning', timezone: 'America/New_York' }),
    );
    expect(response.status).toBe(202);
    expect(deps.enqueue.mock.calls[0][0]).toEqual({
      userId: 'owner',
      kind: 'daily',
      edition: 'morning',
      timezone: 'America/New_York',
    });
    expect(deps.generateReport).not.toHaveBeenCalled();
    expect(deps.queueBriefReady).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ jobId: 'job', reportId: 'report' });
  });
  test('completion notifications use local date, deduplicate, and contain delivery failures', async () => {
    const deps = dependencies();
    const report = await deps.generateReport();
    expect(await notifyBriefReady('owner', 'morning', report, 'America/New_York', deps as any)).toEqual({
      sent: 1,
    });
    expect(deps.queueBriefReady.mock.calls[0][0]).toEqual({
      userId: 'owner',
      reportId: 'report_1',
      localDate: '2026-07-24',
      body: 'Maya waits on the venue. Friday is open.',
    });
    deps.queueBriefReady.mockResolvedValue({ skipped: 'duplicate' } as any);
    expect(await notifyBriefReady('owner', 'morning', report, 'UTC', deps as any)).toEqual({
      skipped: 'duplicate',
    });
    deps.queueBriefReady.mockRejectedValue(new Error('Unavailable'));
    expect(await notifyBriefReady('owner', 'morning', report, 'UTC', deps as any)).toEqual({ failed: true });
    for (const kind of ['manual', 'evening'])
      expect(await notifyBriefReady('owner', kind, report, 'UTC', deps as any)).toBeUndefined();
  });
  test('cron rejects unauthorized/missing user, skips staging, and surfaces persistence failure', async () => {
    const deps = {
      ...dependencies(),
      enqueue: mock(async () => {
        throw new Error('DB unavailable');
      }),
    };
    expect((await createDailyReportPost(deps as any)(request({ userId: 'owner' }))).status).toBe(500);
    expect((await createDailyReportPost(deps as any)(request({}))).status).toBe(400);
    deps.isStagingRuntime.mockReturnValue(true);
    expect(
      await (await createDailyReportPost(deps as any)(request({ userId: 'owner' }))).json(),
    ).toMatchObject({ skipped: true });
    deps.isInternalCronRequest.mockReturnValue(false);
    expect((await createDailyReportPost(deps as any)(request({ userId: 'owner' }))).status).toBe(401);
  });
  test('cron writes morning or manual editions only; a dropped evening request becomes manual', async () => {
    const deps = {
      ...dependencies(),
      enqueue: mock(async () => ({ jobId: 'job', reportId: 'report', started: true })),
    };
    const response = await createDailyReportPost(deps as any)(request({ userId: 'owner', kind: 'evening' }));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ kind: 'manual' });
    expect(deps.enqueue.mock.calls[0][0]).toMatchObject({ edition: 'manual' });
    expect(generateDailyReportTool.input.safeParse({ kind: 'evening' }).success).toBe(false);
    expect(generateDailyReportTool.input.safeParse({ kind: 'morning' }).success).toBe(true);
  });
  test('local date helper handles a UTC-to-local day rollover', () => {
    expect(localDateForTimezone(Date.parse('2026-07-25T02:30:00.000Z'), 'America/New_York')).toBe(
      '2026-07-24',
    );
  });
});
