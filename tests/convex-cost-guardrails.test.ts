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

    expect(events).toContain(".searchIndex('by_search_text'");
    expect(search).toContain(".query('calendarEvents')");
    expect(search).not.toContain(".query('calendarEventCorpus')");
    expect(source).not.toContain('upsertCorpusEvent(');
    expect(source).not.toContain('deleteCorpusEvent(');
    expect(source.match(/\.query\('calendarEventCorpus'\)/g)).toHaveLength(1);
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

  test('large index deletion requires an explicit development commit marker', () => {
    const workflow = read('.github/workflows/deploy-development.yml');

    expect(workflow).toContain('[allow convex index cleanup]');
    expect(workflow).toContain('npx convex deploy --allow-deleting-large-indexes');
    expect(workflow).toContain('else\n            npx convex deploy');
    expect(workflow).not.toContain('--detach');
  });
});
