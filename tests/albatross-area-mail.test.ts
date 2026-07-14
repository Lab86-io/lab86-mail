import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  areaMailMoveConfirmation,
  areaMailMoveReason,
  areaMailRowKey,
  filterAreaMailRows,
  selectedVisibleAreaMailRows,
} from '../lib/albatross/area-mail';

const rows = [
  {
    providerThreadId: 'thread-1',
    accountId: 'account-a',
    subject: 'StatPearls offer',
    fromAddress: 'Pat O’Hara <pat@statpearls.com>',
    lastDate: 2,
    snippet: 'Let’s discuss onboarding.',
    unread: true,
  },
  {
    providerThreadId: 'thread-2',
    accountId: 'account-a',
    subject: 'DMV reminder',
    fromAddress: 'New York DMV <alerts@dmv.ny.gov>',
    lastDate: 1,
    snippet: 'Bring your documents.',
    unread: false,
  },
];

describe('Area mail inbox', () => {
  test('uses account-scoped stable selection keys and searches the visible mail fields', () => {
    expect(areaMailRowKey(rows[0])).toBe('account-a:thread-1');
    expect(filterAreaMailRows(rows, { query: 'onboarding' })).toEqual([rows[0]]);
    expect(filterAreaMailRows(rows, { query: 'DMV', unreadOnly: true })).toEqual([]);
    expect(filterAreaMailRows(rows, { unreadOnly: true })).toEqual([rows[0]]);
  });

  test('bulk actions target selected rows that remain in the current search result', () => {
    const visible = filterAreaMailRows(rows, { query: 'StatPearls' });
    expect(selectedVisibleAreaMailRows(visible, [areaMailRowKey(rows[0]), areaMailRowKey(rows[1])])).toEqual([
      rows[0],
    ]);
  });

  test('mints an explicit user confirmation for a filing correction', () => {
    const confirmation = areaMailMoveConfirmation({
      sourceAreaId: 'area-work',
      destinationAreaId: 'area-personal',
      accountId: 'account-a',
      threadId: 'thread-2',
      sourceAreaName: 'Work',
      destinationAreaName: 'Personal',
      confirmedAt: 1_234,
      confirmedBy: 'user-1',
    });
    expect(confirmation.kind).toBe('userConfirmation');
    expect(confirmation.confirmedBy).toBe('user-1');
    expect(confirmation.prompt).toBe('Move this mail thread from Work to Personal.');
    expect(confirmation.sourceRefId).toBe('thread-2');
    expect(areaMailMoveReason('Work', 'Personal')).toBe('Moved by the user from Work to Personal.');
  });

  test('reuses the production inbox row and preserves both sides of the correction', () => {
    const areaHome = readFileSync(path.join(process.cwd(), 'components/albatross/AreaHome.tsx'), 'utf8');
    const inbox = readFileSync(path.join(process.cwd(), 'components/inbox/Inbox.tsx'), 'utf8');
    const convex = readFileSync(path.join(process.cwd(), 'convex/albatross.ts'), 'utf8');

    expect(inbox).toContain('export const InboxThreadRow');
    expect(areaHome).toContain('<InboxThreadRow');
    expect(areaHome).toContain('Move to Area');
    expect(areaHome).not.toContain('Recent Area mail');
    expect(areaHome).not.toContain('What this inbox knows');
    expect(convex).toContain('export const moveMailThreadsToArea = mutation');
    expect(convex).toContain('if (args.threads.length > 50)');
    expect(convex).toContain('normalizeSourceRefs([sourceRef, ...(sourceLink.sourceRefs || [])])');
    expect(convex).toContain("status: 'rejected'");
    expect(convex).toContain("status: 'verified' as const");
    expect(convex).toContain("trust: 'confirmed'");
    expect(convex).toContain("trust: 'rejected'");
  });
});
