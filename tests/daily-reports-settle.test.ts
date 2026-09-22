import { expect, test } from 'bun:test';
import { getDailyReport, migrateDailyReport, saveDailyReport } from '../lib/store/daily-reports';
import { kvGet } from '../lib/store/kv';
import { editorialFixture } from './fixtures/editorial';
import { withToolContext } from './tools/harness';

test('reading a long-running edition never ends its generation based on elapsed time', async () => {
  for (const artifactStatus of ['composing', 'enriching'] as const) {
    const { edition } = editorialFixture();
    const report = {
      ...edition,
      _id: `long-${artifactStatus}`,
      artifactStatus,
      generatedAt: Date.now() - 24 * 3600_000,
      html: '<html>Interim source layout</html>',
    };
    expect(migrateDailyReport(report).artifactStatus).toBe(artifactStatus);
    await withToolContext(
      async () => {
        await saveDailyReport(report);
        expect((await getDailyReport(report._id))?.artifactStatus).toBe(artifactStatus);
        expect((await kvGet<any>('dailyReport', report._id))?.artifactStatus).toBe(artifactStatus);
      },
      { userId: 'long-generation-test-owner' },
    );
  }
});

test('unknown persisted nodes are repaired into a readable summary', () => {
  const { edition } = editorialFixture();
  const migrated = migrateDailyReport({
    ...edition,
    document: { version: 2, regions: [{ tree: { kind: 'unknown' } }] },
  } as any);
  expect(migrated.document?.summary).toContain('available as a summary');
  expect(JSON.stringify(migrated.document)).not.toContain('unknown');
  expect(migrated._id).toBe(edition._id);
});
