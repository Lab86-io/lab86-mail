import { describe, expect, test } from 'bun:test';
import './tools/harness';
import { getLatestDailyReport, saveDailyReport } from '../lib/store/daily-reports';
import {
  dismissDailyReportTaskTool,
  dismissDailyReportThreadTool,
  generateDailyReportTool,
  getDailyReportTool,
  getLatestDailyReportTool,
  listDailyReportsTool,
  listDailyReportTaskDismissalsTool,
  listDailyReportThreadDismissalsTool,
} from '../lib/tools/daily-report';
import { runTool, withToolContext } from './tools/harness';

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
  });

  test('generate_daily_report starts in the background by default', async () => {
    const started = await runTool(generateDailyReportTool.handler, { kind: 'manual', wait: false });
    expect(started.started).toBe(true);
    expect(started.report).toBeNull();
    const latest = await withToolContext(() => getLatestDailyReport('manual'));
    expect(latest?.status).toBe('partial');
    expect(latest?.progress?.stage).toBe('queued');
  });
});
