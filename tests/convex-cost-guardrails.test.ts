import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (relativePath: string) => readFileSync(path.join(process.cwd(), relativePath), 'utf8');

function between(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('Convex cost guardrails', () => {
  test('mail messages keep only indexes used by runtime reads and deletion', () => {
    const schema = read('convex/schema.ts');
    const messages = between(schema, 'mailCorpusMessages: defineTable(', 'userDocs: defineTable(');

    for (const required of [
      'by_user_account',
      'by_account_thread',
      'by_user_account_thread_received',
      'by_account_message',
      'by_user_account_received',
      'by_search_text',
    ]) {
      expect(messages).toContain(`'${required}'`);
    }
    for (const unused of ['by_user', 'by_grant', 'by_account']) {
      expect(messages).not.toContain(`.index('${unused}'`);
    }
  });

  test('calendar search uses the canonical event table instead of a dual-written copy', () => {
    const schema = read('convex/schema.ts');
    const source = read('convex/calendarData.ts');
    const events = between(schema, 'calendarEvents: defineTable(', 'calendarEventCorpus: defineTable(');
    const search = between(source, 'export const searchEvents', 'export const setCalendarColor');
    const purge = between(
      source,
      'export const purgeLegacyEventCorpusBatch',
      'async function queryEventsInWindow',
    );
    const legacyDelete = between(
      source,
      'async function deleteLegacyCorpusEvent',
      'function filterCalendarRows',
    );

    expect(events).toContain(".searchIndex('by_search_text'");
    expect(search).toContain(".query('calendarEvents')");
    expect(search).not.toContain(".query('calendarEventCorpus')");
    expect(source).not.toContain('upsertCorpusEvent(');
    expect(source).not.toContain('deleteCorpusEvent(');
    expect(source).toContain('async function deleteLegacyCorpusEvent(');
    expect(legacyDelete.match(/\.query\('calendarEventCorpus'\)/g)).toHaveLength(2);
    expect(source).toContain('searchText: canonical.searchText || row.searchText');
    expect(source).toContain('yearMonth: canonical.yearMonth || row.yearMonth');
    expect(purge).toContain(".query('calendarEventCorpus').take(limit)");
    expect(purge).toContain('for (const row of rows)');
    expect(purge).toContain('await ctx.db.delete(row._id)');
    expect(purge).toContain(
      'ctx.scheduler.runAfter(0, internal.calendarData.purgeLegacyEventCorpusBatch, { limit })',
    );
  });

  test('calendar reconciliation selects exact overlaps from the end-time index', () => {
    const schema = read('convex/schema.ts');
    const source = read('convex/calendarData.ts');
    const reconcile = between(source, 'export const reconcileWindow', 'export const markSyncState');

    expect(schema).toContain(".index('by_user_account_calendar_end'");
    expect(reconcile).toContain(".withIndex('by_user_account_calendar_end'");
    expect(reconcile).toContain(".gt('endAt', args.windowStart)");
    expect(reconcile).toContain('if (row.startAt >= args.windowEnd) continue;');
    expect(reconcile).not.toContain(".withIndex('by_user_account_calendar_start'");
  });

  test('large index deletion requires an explicit deployment commit marker', () => {
    for (const [workflowPath, markerCondition] of [
      [
        '.github/workflows/deploy-development.yml',
        'if [[ "$DEPLOY_COMMIT_MESSAGE" == *"[allow convex index cleanup]"* ]]; then',
      ],
      [
        '.github/workflows/deploy-production.yml',
        "if grep -Fq '[allow convex index cleanup]' .release-commits.txt; then",
      ],
    ] as const) {
      const workflow = read(workflowPath);
      const convexDeploy = between(workflow, '- name: Deploy Convex', '- name: Install Railway CLI');
      const railwayFlow = between(
        workflow,
        '- name: Prepare Railway deployment identity',
        '- name: Smoke test',
      );
      const railwayReady = between(workflow, '- name: Wait for Railway', '- name: Smoke test');

      expect(convexDeploy).toContain(
        `${markerCondition}\n            npx convex deploy --allow-deleting-large-indexes\n            npx convex run calendarData:purgeLegacyEventCorpusBatch '{}'\n          else\n            npx convex deploy\n          fi`,
      );
      expect(workflow).not.toContain('--detach');
      expect(railwayFlow).toContain('GITHUB_RUN_ID');
      expect(railwayFlow).toContain('GITHUB_RUN_ATTEMPT');
      expect(railwayFlow).toContain('-m "$RAILWAY_DEPLOY_MESSAGE"');
      expect(railwayReady).toContain('for attempt in {1..30}');
      expect(railwayReady).toContain('--arg message "$RAILWAY_DEPLOY_MESSAGE"');
      expect(railwayReady).toContain('.meta.cliMessage == $message');
      expect(railwayReady).toContain('SUCCESS)');
      expect(railwayReady).toContain('FAILED|CRASHED|REMOVED)');
      expect(railwayReady).toContain('sleep 10');
    }
  });
});
