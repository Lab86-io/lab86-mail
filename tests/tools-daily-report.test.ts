import { describe, expect, test } from 'bun:test';
import './tools/harness';
import { generateDailyReport } from '../lib/mail/daily-report';
import { getDailyReport, getLatestDailyReport, saveDailyReport } from '../lib/store/daily-reports';
import { upsertTrackedThread } from '../lib/store/tracked-threads';
import {
  dismissDailyReportTaskTool,
  dismissDailyReportThreadTool,
  generateDailyReportTool,
  getDailyReportTool,
  getLatestDailyReportTool,
  listDailyReportsTool,
  listDailyReportTaskDismissalsTool,
  listDailyReportThreadDismissalsTool,
  restoreDailyReportTaskTool,
  restoreDailyReportThreadTool,
} from '../lib/tools/daily-report';
import { runTool, seedThreadMessage, withToolContext } from './tools/harness';

describe('daily report tools', () => {
  test('stores, lists, and fetches reports locally', async () => {
    await withToolContext(async () => {
      await saveDailyReport({
        _id: 'report_test_1',
        kind: 'manual',
        generatedAt: Date.parse('2026-06-10T08:00:00.000Z'),
        status: 'ready',
        accounts: ['jakob@example.test'],
        title: 'Morning brief',
        narrative: 'Two threads need replies.',
        sections: {
          replyOwed: [],
          followUpOwed: [],
          newPeople: [],
          timeSensitive: [],
          tracked: [],
          fyi: [],
          bulkTail: [],
          tasks: [],
          calendar: [],
        },
        stats: {},
      } as any);

      const latest = await runTool(getLatestDailyReportTool.handler, { kind: 'manual' });
      expect(latest.report?._id).toBe('report_test_1');

      const listed = await runTool(listDailyReportsTool.handler, { limit: 5 });
      expect(listed.reports.some((report: any) => report._id === 'report_test_1')).toBe(true);

      const fetched = await runTool(getDailyReportTool.handler, { id: 'report_test_1' });
      expect(fetched.report?.title).toBe('Morning brief');
    });
  });

  test('records task and thread dismissals', async () => {
    const task = await runTool(dismissDailyReportTaskTool.handler, {
      cardId: 'task_card_1',
      title: 'Follow up with Alex',
    });
    expect(task.ok).toBe(true);

    const taskDismissals = await runTool(listDailyReportTaskDismissalsTool.handler, {});
    expect(taskDismissals.cardIds).toContain('task_card_1');

    const thread = await runTool(dismissDailyReportThreadTool.handler, {
      account: 'jakob@example.test',
      threadId: 'thread_dismiss',
      action: 'dismissed',
    });
    expect(thread.ok).toBe(true);

    const threadDismissals = await runTool(listDailyReportThreadDismissalsTool.handler, {});
    expect(threadDismissals.threadKeys.some((key: string) => key.includes('thread_dismiss'))).toBe(true);

    await runTool(restoreDailyReportTaskTool.handler, { cardId: 'task_card_1' });
    await runTool(restoreDailyReportThreadTool.handler, {
      account: 'jakob@example.test',
      threadId: 'thread_dismiss',
    });

    expect((await runTool(listDailyReportTaskDismissalsTool.handler, {})).cardIds).not.toContain(
      'task_card_1',
    );
    expect(
      (await runTool(listDailyReportThreadDismissalsTool.handler, {})).threadKeys.some((key: string) =>
        key.includes('thread_dismiss'),
      ),
    ).toBe(false);
  });

  test('generate_daily_report starts in the background by default', async () => {
    const started = await runTool(generateDailyReportTool.handler, { kind: 'manual', wait: false });
    expect(started.started).toBe(true);
    expect(started.report).toBeNull();
    const latest = await withToolContext(() => getLatestDailyReport('manual'));
    expect(latest?.status).toBe('partial');
    expect(latest?.progress?.stage).toBe('queued');
  });

  test('generate_daily_report reuses an active generation instead of starting another', async () => {
    await withToolContext(() =>
      saveDailyReport({
        _id: 'report_active_generation',
        kind: 'evening',
        generatedAt: Date.now(),
        status: 'partial',
        artifactStatus: 'composing',
        progress: { stage: 'queued', done: 0, total: 1 },
        accounts: [],
        title: 'Daily Report',
        narrative: 'Generating daily report.',
        sections: {
          replyOwed: [],
          followUpOwed: [],
          newPeople: [],
          timeSensitive: [],
          tracked: [],
          fyi: [],
          bulkTail: [],
          tasks: [],
          calendar: [],
        },
        stats: {},
      } as any),
    );

    const active = await runTool(generateDailyReportTool.handler, { kind: 'evening', wait: false });
    expect(active.started).toBe(false);
    expect(active.report?._id).toBe('report_active_generation');
  });

  test('scoped reports do not widen unresolved tracked threads to other accounts', async () => {
    const seeded = await seedThreadMessage({
      account: 'outside@example.test',
      threadId: 'tracked_outside_scope',
      messageId: 'msg_tracked_outside_scope',
      subject: 'Outside scope',
      from: 'Alex <alex@example.test>',
      textBody: 'Please review this outside-scope thread.',
    });
    await withToolContext(() =>
      upsertTrackedThread({
        account: seeded.account,
        threadId: seeded.threadId,
        subject: 'Outside scope',
        status: 'open',
      }),
    );

    const report = await withToolContext(() =>
      generateDailyReport({
        kind: 'manual',
        accounts: ['missing@example.test'],
        includeCalendar: false,
        maxRecentPerAccount: 1,
        now: Date.parse('2026-06-10T08:00:00.000Z'),
      }),
    );

    expect(report.sections.tracked).toEqual([]);
    expect(JSON.stringify(report.sections)).not.toContain('Outside scope');
  });

  test('get_latest_daily_report returns the display artifact with the area brief injected, without mutating stored history', async () => {
    await withToolContext(async () => {
      const storedHtml =
        '<!doctype html><html><body><main><section>Body</section><footer class="brief-footer">Made</footer></main></body></html>';
      await saveDailyReport({
        _id: 'report_area_brief_display',
        kind: 'manual',
        // Far-future so this edition is unambiguously the latest manual report
        // regardless of the order the other tests in this file run.
        generatedAt: Date.parse('2030-01-01T00:00:00.000Z'),
        status: 'ready',
        accounts: ['jakob@example.test'],
        title: 'Daily Report',
        narrative: 'Area work is moving.',
        html: storedHtml,
        sections: {
          replyOwed: [],
          followUpOwed: [],
          newPeople: [],
          timeSensitive: [],
          tracked: [],
          fyi: [],
          bulkTail: [],
          tasks: [],
          calendar: [],
          albatross: {
            includedAreas: [{ areaId: 'area_launch', name: 'Launch', reason: 'Live work' }],
            askBeforeCentering: [],
            activeIntents: [],
            activeProjects: [
              { id: 'project_1', title: 'Ship area briefs', areaId: 'area_launch', status: 'active' },
            ],
            contextReview: [],
            completions: [],
          },
        },
        stats: {},
      } as any);

      const first = await runTool(getLatestDailyReportTool.handler, { kind: 'manual' });
      expect(first.report?.html).toContain('data-lab86-area-brief-host');
      expect(first.report?.html).toContain('Area briefs');
      expect(first.report?.html).toContain('Ship area briefs');
      // The brief is injected before the artifact footer, exactly like desktop.
      expect(first.report.html.indexOf('data-lab86-area-brief-host')).toBeLessThan(
        first.report.html.indexOf('brief-footer'),
      );

      // Idempotent: a second read does not double-inject.
      const second = await runTool(getLatestDailyReportTool.handler, { kind: 'manual' });
      expect(second.report.html.match(/data-lab86-area-brief-host/g)?.length).toBe(1);

      // Stored history is never mutated — the persisted edition keeps its raw html.
      const stored = await getLatestDailyReport('manual');
      expect(stored?._id).toBe('report_area_brief_display');
      expect(stored?.html).toBe(storedHtml);
      expect(stored?.html).not.toContain('data-lab86-area-brief-host');
    });
  });

  test('get_latest_daily_report leaves html untouched when there is no area context', async () => {
    await withToolContext(async () => {
      const storedHtml = '<!doctype html><html><body><main><section>Body</section></main></body></html>';
      await saveDailyReport({
        _id: 'report_no_area_context',
        kind: 'evening',
        generatedAt: Date.parse('2030-02-01T00:00:00.000Z'),
        status: 'ready',
        accounts: ['jakob@example.test'],
        title: 'Daily Report',
        narrative: 'No areas.',
        html: storedHtml,
        sections: {
          replyOwed: [],
          followUpOwed: [],
          newPeople: [],
          timeSensitive: [],
          tracked: [],
          fyi: [],
          bulkTail: [],
          tasks: [],
          calendar: [],
        },
        stats: {},
      } as any);

      const result = await runTool(getLatestDailyReportTool.handler, { kind: 'evening' });
      expect(result.report?.html).toBe(storedHtml);
      expect(result.report?.html).not.toContain('data-lab86-area-brief-host');
    });
  });

  test('generate_daily_report wait=true persists a terminal edition', async () => {
    const generated = await runTool(generateDailyReportTool.handler, { kind: 'manual', wait: true });
    expect(generated.started).toBeUndefined();
    expect(generated.report?.status).toBe('ready');
    expect(generated.report?.html).toContain('<');

    const persisted = await withToolContext(() => getDailyReport(generated.report._id));
    expect(persisted).toMatchObject({
      _id: generated.report._id,
      kind: 'manual',
      status: 'ready',
      artifactStatus: 'rendered',
      artifactSource: 'deterministic',
    });
  });
});
