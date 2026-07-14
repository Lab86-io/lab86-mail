import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DailyReport } from '../lib/shared/types';
import {
  getDailyReport,
  migrateDailyReport,
  saveDailyReport,
  setDailyReportPersistenceForTest,
} from '../lib/store/daily-reports';
import { kvGet } from '../lib/store/kv';
import { withToolContext } from './tools/harness';
import './tools/harness';

// Settle-on-read: a deploy/restart mid-generation SIGTERMs the process, so no
// catch path runs and the stored edition wedges at artifactStatus
// 'composing'/'enriching' forever (the Jul 7 2026 edition did exactly this).
// The read-side migration settles clearly-stale statuses to 'rendered' —
// content exists, the page must stop treating the run as in-flight.

const STUCK_MS = 20 * 60_000;
const NOW = Date.parse('2026-07-07T16:00:00Z');

function edition(overrides: Partial<DailyReport> = {}): DailyReport {
  return {
    _id: 'rep_settle',
    kind: 'manual',
    generatedAt: NOW - STUCK_MS - 60_000,
    status: 'ready',
    accounts: [],
    title: 'Daily Report',
    narrative: 'x',
    html: '<!doctype html><html><body>brief</body></html>',
    artifactStatus: 'enriching',
    artifactSource: 'ai',
    sections: {},
    stats: {},
    ...overrides,
  } as unknown as DailyReport;
}

describe('migrateDailyReport settle-on-read', () => {
  test('a stale enriching edition settles to rendered', () => {
    const settled = migrateDailyReport(edition(), NOW);
    expect(settled.artifactStatus).toBe('rendered');
    expect(settled.artifactSource).toBe('ai');
    expect(settled.html).toContain('brief');
  });

  test('a stale composing edition settles to rendered', () => {
    const settled = migrateDailyReport(edition({ artifactStatus: 'composing' }), NOW);
    expect(settled.artifactStatus).toBe('rendered');
  });

  test('a fresh enriching edition keeps polling semantics', () => {
    const fresh = migrateDailyReport(edition({ generatedAt: NOW - 5 * 60_000 }), NOW);
    expect(fresh.artifactStatus).toBe('enriching');
  });

  test('exactly at the cutoff still counts as in-flight', () => {
    const atCutoff = migrateDailyReport(edition({ generatedAt: NOW - STUCK_MS }), NOW);
    expect(atCutoff.artifactStatus).toBe('enriching');
  });

  test('rendered editions are untouched', () => {
    const rendered = migrateDailyReport(edition({ artifactStatus: 'rendered' }), NOW);
    expect(rendered.artifactStatus).toBe('rendered');
  });

  test('settling is pure: the raw document is not mutated', () => {
    const raw = edition();
    migrateDailyReport(raw, NOW);
    expect(raw.artifactStatus).toBe('enriching');
  });

  test('getters persist the settled terminal status for stale artifact rows', async () => {
    await withToolContext(async () => {
      const raw = edition({
        _id: 'rep_settle_persisted',
        kind: 'evening',
        generatedAt: Date.now() - STUCK_MS - 60_000,
      });
      await saveDailyReport(raw);

      const fetched = await getDailyReport(raw._id);
      const persisted = await kvGet<DailyReport>('dailyReport', raw._id);

      expect(fetched?.artifactStatus).toBe('rendered');
      expect(persisted?.artifactStatus).toBe('rendered');
      expect(raw.artifactStatus).toBe('enriching');
    });
  });

  test('a failed settle persistence remains a successful read', async () => {
    await withToolContext(async () => {
      const raw = edition({
        _id: 'rep_settle_persist_failure',
        kind: 'evening',
        generatedAt: Date.now() - STUCK_MS - 60_000,
      });
      await saveDailyReport(raw);
      const warnings: unknown[][] = [];
      const previousWarn = console.warn;
      console.warn = (...args: unknown[]) => warnings.push(args);
      const restore = setDailyReportPersistenceForTest((() => {
        throw new Error('store unavailable');
      }) as any);
      try {
        await expect(getDailyReport(raw._id)).resolves.toMatchObject({ artifactStatus: 'rendered' });
        expect(warnings[0]?.join(' ')).toContain('failed to persist settled artifact status');
      } finally {
        restore();
        console.warn = previousWarn;
      }
    });
  });

  test('list mapping does not pass the array index as `now`', () => {
    // `reports.map(migrateDailyReport)` would hand the index (0,1,2…) to the
    // `now` param, making `now - generatedAt` hugely negative so nothing ever
    // settles. Guard the call shape at the source.
    const src = readFileSync(join(process.cwd(), 'lib/store/daily-reports.ts'), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    expect(src).not.toMatch(/\.map\(\s*migrateDailyReport\s*\)/);
  });

  test('a stale partial (no html yet) is not force-rendered by the settle rule', () => {
    const partial = migrateDailyReport(
      edition({ status: 'partial', html: undefined, artifactStatus: 'composing', artifactSource: undefined }),
      NOW,
    );
    // status 'partial' means the week pass never finished writing content;
    // there is no artifact to show, so the settle rule leaves it alone (the
    // page's own staleness cutoff unblocks the Generate button).
    expect(partial.html).toBeUndefined();
    expect(partial.artifactStatus).toBe('composing');
  });
});
