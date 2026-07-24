import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createDailyReportPost, localDateForTimezone } from '../app/api/cron/daily-report/route';

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
    })),
    queueBriefReady: mock(async () => ({ notificationId: 'notification_1', created: true })),
    dispatchNativeNotification: mock(async () => ({ sent: 1 })),
  };
}

describe('daily report cron brief-ready notification', () => {
  test('uses the user timezone local date and dispatches only after a morning report is saved', async () => {
    const deps = dependencies();
    const response = await createDailyReportPost(deps as any)(
      request({
        userId: 'user_1',
        kind: 'morning',
        timezone: 'America/New_York',
      }),
    );

    expect(response.status).toBe(200);
    expect(deps.generateReport.mock.calls[0][0]).toEqual({
      userId: 'user_1',
      kind: 'morning',
      userTimezone: 'America/New_York',
    });
    expect(deps.queueBriefReady.mock.calls[0][0]).toEqual({
      userId: 'user_1',
      reportId: 'report_1',
      localDate: '2026-07-24',
    });
    expect(deps.dispatchNativeNotification.mock.calls[0]).toEqual(['user_1', 'notification_1']);
    expect(await response.json()).toMatchObject({
      ok: true,
      kind: 'morning',
      reportId: 'report_1',
      briefNotification: { sent: 1 },
    });
  });

  test('does not queue a brief-ready push for evening or manual runs', async () => {
    for (const kind of ['evening', 'manual'] as const) {
      const deps = dependencies();
      const response = await createDailyReportPost(deps as any)(request({ userId: 'user_1', kind }));
      expect(response.status).toBe(200);
      expect(deps.queueBriefReady).not.toHaveBeenCalled();
      expect(deps.dispatchNativeNotification).not.toHaveBeenCalled();
    }
  });

  test('honors dedupe skips without dispatching a second native push', async () => {
    const deps = dependencies();
    deps.queueBriefReady.mockImplementation(async () => ({
      notificationId: null,
      created: false,
      skipped: 'duplicate',
    }));

    const response = await createDailyReportPost(deps as any)(
      request({ userId: 'user_1', kind: 'morning', timezone: 'UTC' }),
    );

    expect(response.status).toBe(200);
    expect(deps.dispatchNativeNotification).not.toHaveBeenCalled();
    expect((await response.json()).briefNotification).toEqual({ skipped: 'duplicate' });
  });

  test('keeps a completed report successful when native notification delivery fails', async () => {
    const deps = dependencies();
    deps.dispatchNativeNotification.mockImplementation(async () => {
      throw new Error('APNs timeout');
    });

    const response = await createDailyReportPost(deps as any)(request({ userId: 'user_1', kind: 'morning' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      reportId: 'report_1',
      briefNotification: { failed: true },
    });
  });

  test('rejects unauthorized and missing-user calls, and skips staging', async () => {
    const unauthorizedDeps = dependencies();
    unauthorizedDeps.isInternalCronRequest.mockImplementation(() => false);
    expect((await createDailyReportPost(unauthorizedDeps as any)(request({ userId: 'user_1' }))).status).toBe(
      401,
    );

    const missingDeps = dependencies();
    expect((await createDailyReportPost(missingDeps as any)(request({ kind: 'morning' }))).status).toBe(400);

    const stagingDeps = dependencies();
    stagingDeps.isStagingRuntime.mockImplementation(() => true);
    const staging = await createDailyReportPost(stagingDeps as any)(
      request({ userId: 'user_1', kind: 'morning' }, 'staging.lab86.io'),
    );
    expect(staging.status).toBe(200);
    expect(await staging.json()).toEqual({ ok: true, skipped: true, reason: 'staging' });
    expect(stagingDeps.generateReport).not.toHaveBeenCalled();
  });

  test('local date helper handles a UTC-to-local day rollover', () => {
    expect(localDateForTimezone(Date.parse('2026-07-25T02:30:00.000Z'), 'America/New_York')).toBe(
      '2026-07-24',
    );
  });
});
