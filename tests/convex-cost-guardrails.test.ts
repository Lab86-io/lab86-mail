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

  test('calendar search uses the canonical event table and no legacy corpus remains', () => {
    const schema = read('convex/schema.ts');
    const source = read('convex/calendarData.ts');
    const accounts = read('convex/accounts.ts');
    const events = between(schema, 'calendarEvents: defineTable(', 'dataMigrations: defineTable(');
    const search = between(source, 'export const searchEvents', 'export const setCalendarColor');

    expect(events).toContain(".searchIndex('by_search_text'");
    expect(search).toContain(".query('calendarEvents')");
    expect(search).toContain('count: Math.min(matched.length, CAP)');
    expect(search).toContain('approximate: sourceTruncated || matched.length > CAP');
    // The one-time migration finished on both deployments; the duplicate
    // corpus, its merge, and its cutover check are gone.
    for (const text of [schema, source, accounts]) expect(text).not.toContain('calendarEventCorpus');
    expect(source).not.toContain('calendarSearchCutoverReady');
    expect(source).not.toContain('mergeCalendarSearchRows');
    expect(source).not.toContain('completeCalendarSearchMigration');
    expect(source).not.toContain('upsertCorpusEvent(');
    expect(source).not.toContain('deleteCorpusEvent(');
  });

  test('calendar reconciliation selects exact overlaps from the end-time index', () => {
    const schema = read('convex/schema.ts');
    const source = read('convex/calendarData.ts');
    const reconcile = between(source, 'export const reconcileWindow', 'export const markSyncState');

    expect(schema).toContain(".index('by_user_account_calendar_end'");
    expect(reconcile).toContain(".withIndex('by_user_account_calendar_end'");
    expect(reconcile).toContain(".gt('endAt', args.windowStart)");
    expect(reconcile).toContain('.paginate({ cursor: args.cursor ?? null, numItems: limit })');
    expect(reconcile).toContain('if (row.startAt >= args.windowEnd) continue;');
    expect(reconcile).not.toContain('.collect()');
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
      const railwayInstall = between(
        workflow,
        '- name: Install Railway CLI',
        '- name: Prepare Railway deployment identity',
      );
      const railwayFlow = between(
        workflow,
        '- name: Prepare Railway deployment identity',
        '- name: Smoke test',
      );
      const railwayReady = between(workflow, '- name: Wait for Railway', '- name: Smoke test');

      expect(convexDeploy).toContain(markerCondition);
      expect(convexDeploy).toContain('npx convex deploy --allow-deleting-large-indexes');
      expect(convexDeploy).toContain('npx convex deploy');
      expect(convexDeploy).not.toContain('completeCalendarSearchMigration');
      expect(railwayInstall).toContain('run: npm install -g @railway/cli@5.26.2');
      expect(railwayFlow).toContain('--detach');
      expect(railwayFlow).not.toContain('--ci');
      expect(railwayFlow).toContain('GITHUB_RUN_ID');
      expect(railwayFlow).toContain('GITHUB_RUN_ATTEMPT');
      expect(railwayFlow).toContain('-m "$RAILWAY_DEPLOY_MESSAGE"');
      // 15 minutes, not 5. A cold Railway build of this app runs past five,
      // and the wait then reports a timeout for a deployment that goes on to
      // succeed — which fails the release and skips the Xcode Cloud trigger
      // behind it, for no real fault.
      expect(railwayReady).toContain('for attempt in {1..90}');
      expect(railwayReady).toContain('--arg message "$RAILWAY_DEPLOY_MESSAGE"');
      expect(railwayReady).toContain('.meta.cliMessage == $message');
      expect(railwayReady).toContain('SUCCESS)');
      expect(railwayReady).toContain('FAILED|CRASHED|REMOVED)');
      expect(railwayReady).toContain('sleep 10');
    }
  });
});
