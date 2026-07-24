import { describe, expect, test } from 'bun:test';
import './tools/harness';
import { getDailyArt } from '../lib/mail/daily-art';
import type { DailyReport } from '../lib/shared/types';
import { saveDailyReport } from '../lib/store/daily-reports';
import {
  getDailyReportTool,
  getLatestDailyReportTool,
  listDailyReportsTool,
} from '../lib/tools/daily-report';
import { runTool, toolContext, withToolContext } from './tools/harness';

// Stage 1 iOS 0.8 parity: get_latest_daily_report / get_daily_report /
// list_daily_reports all attach the same deterministic edition art
// (lib/mail/daily-art.ts) desktop already renders, so native mastheads match
// without their own art-pool logic. `art` is derived at read time and never
// persisted — stored history must never be mutated by reading it.

function report(overrides: Partial<DailyReport> = {}): DailyReport {
  return {
    _id: overrides._id ?? 'report_1',
    kind: 'morning',
    generatedAt: Date.parse('2026-06-30T05:49:00.000Z'),
    status: 'ready',
    accounts: [],
    title: 'Daily Report',
    narrative: 'All quiet.',
    services: ['gmail'],
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
    stats: {
      scannedThreads: 0,
      trackedThreads: 0,
      needsReply: 0,
      replyOwed: 0,
      dueSoon: 0,
      bulkTailCount: 0,
      unread: 0,
      openTasks: 0,
      completedTasks: 0,
      calendarEvents: 0,
    },
    ...overrides,
  };
}

describe('daily report tools attach deterministic edition art', () => {
  test('get_latest_daily_report attaches art matching getDailyArt(generatedAt)', async () => {
    const seeded = report();
    await withToolContext(() => saveDailyReport(seeded));

    const result = await runTool(getLatestDailyReportTool.handler, { kind: 'morning' });
    expect(result.report).not.toBeNull();
    expect((result.report as any).art).toEqual(getDailyArt(seeded.generatedAt));
    // services already existed on DailyReport — must pass through untouched.
    expect((result.report as any).services).toEqual(['gmail']);
  });

  test('get_latest_daily_report returns null without crashing when nothing matches', async () => {
    // The per-user kv store is shared across every suite in this process and
    // other files seed evening reports for the default test user, so the
    // null path must run as a user nobody else writes for (file execution
    // order differs between local runs and CI).
    const emptyUser = { userId: 'tool_art_empty_user' };
    const result = await withToolContext(
      () => getLatestDailyReportTool.handler({ kind: 'evening' }, toolContext(emptyUser)),
      emptyUser,
    );
    expect(result.report).toBeNull();
  });

  test('get_daily_report attaches art for a report fetched by id', async () => {
    const seeded = report({ _id: 'report_2', generatedAt: Date.parse('2026-07-01T05:00:00.000Z') });
    await withToolContext(() => saveDailyReport(seeded));

    const result = await runTool(getDailyReportTool.handler, { id: 'report_2' });
    expect(result.report).not.toBeNull();
    expect((result.report as any).art).toEqual(getDailyArt(seeded.generatedAt));
  });

  test('get_daily_report returns null without crashing for an unknown id', async () => {
    const result = await runTool(getDailyReportTool.handler, { id: 'does-not-exist' });
    expect(result.report).toBeNull();
  });

  test('list_daily_reports (history) carries art on every entry, never mutating the store', async () => {
    const a = report({ _id: 'report_a', generatedAt: Date.parse('2026-06-01T05:00:00.000Z') });
    const b = report({ _id: 'report_b', generatedAt: Date.parse('2026-06-02T05:00:00.000Z') });
    await withToolContext(async () => {
      await saveDailyReport(a);
      await saveDailyReport(b);
    });

    // The in-memory kv store is shared across tests in this file, so assert
    // on the two reports this test seeded rather than the total history size.
    const result = await runTool(listDailyReportsTool.handler, { limit: 100 });
    const seeded = (result.reports as any[]).filter(
      (entry) => entry._id === 'report_a' || entry._id === 'report_b',
    );
    expect(seeded).toHaveLength(2);
    for (const entry of seeded) {
      expect(entry.art).toEqual(getDailyArt(entry.generatedAt));
    }

    // Re-reading again must produce the same art (nothing was mutated into
    // the stored doc that would change its own re-derivation).
    const again = await runTool(listDailyReportsTool.handler, { limit: 100 });
    const seededAgain = (again.reports as any[]).filter(
      (entry) => entry._id === 'report_a' || entry._id === 'report_b',
    );
    expect(seededAgain).toEqual(seeded);
  });
});
