import { describe, expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { api } from '../convex/_generated/api';
import schema from '../convex/schema';
import { folderRoleOf, labelsHaveRole, withFolderRoleLabels } from '../lib/mail/search/folders';
import { type CorpusMessageDocument, filterCorpusMessagesByAst } from '../lib/mail/search/local';
import { pageEndsInTie, pageThroughTies } from '../lib/mail/search/page-ties';
import { parseMailSearchQuery } from '../lib/mail/search/parser';

const ICLOUD = 'v0:efa0e2fd-38c1-45c1-a7c7-1cf4bf6fd0e2';

describe('provider-neutral folder roles (SEARCH-1)', () => {
  test('roles come from Gmail ids, iCloud id suffixes, and Microsoft folder names', () => {
    expect(folderRoleOf('INBOX')).toBe('INBOX');
    expect(folderRoleOf(`${ICLOUD}:INBOX`)).toBe('INBOX');
    expect(folderRoleOf(`${ICLOUD}:Deleted Messages`)).toBe('TRASH');
    expect(folderRoleOf(`${ICLOUD}:Junk`)).toBe('SPAM');
    expect(folderRoleOf(`${ICLOUD}:Sent Messages`)).toBe('SENT');
    expect(folderRoleOf('AAMkAD-opaque')).toBeNull();
    expect(folderRoleOf('AAMkAD-opaque', 'Deleted Items')).toBe('TRASH');
    expect(folderRoleOf('Label_12')).toBeNull();
    expect(labelsHaveRole([`${ICLOUD}:Junk`], 'SPAM')).toBe(true);
    expect(labelsHaveRole(undefined, 'SPAM')).toBe(false);
  });

  test('role labels are added once, next to the provider ids', () => {
    const names = new Map([['AAMk-1', 'Inbox']]);
    expect(withFolderRoleLabels(['AAMk-1', 'AAMk-2'], names)).toEqual(['AAMk-1', 'AAMk-2', 'INBOX']);
    expect(withFolderRoleLabels([`${ICLOUD}:INBOX`, 'INBOX'])).toEqual([`${ICLOUD}:INBOX`, 'INBOX']);
    expect(withFolderRoleLabels(['INBOX', 'CATEGORY_UPDATES'])).toEqual(['INBOX', 'CATEGORY_UPDATES']);
  });

  test('local search matches in:inbox, in:trash, and in:all for iCloud rows', () => {
    const base: CorpusMessageDocument = {
      accountId: 'icloud',
      provider: 'icloud',
      providerMessageId: 'm1',
      providerThreadId: 't1',
      subject: 'Invoice',
      from: 'billing@example.test',
      to: 'me@icloud.com',
      receivedAt: Date.parse('2026-09-01T00:00:00Z'),
      snippet: '',
      searchText: 'invoice',
      labels: [`${ICLOUD}:INBOX`],
    };
    const trashed = { ...base, providerMessageId: 'm2', labels: [`${ICLOUD}:Deleted Messages`] };
    const rows = [base, trashed];
    expect(filterCorpusMessagesByAst(rows, parseMailSearchQuery('in:inbox invoice'))).toEqual([base]);
    expect(filterCorpusMessagesByAst(rows, parseMailSearchQuery('in:trash'))).toEqual([trashed]);
    // All Mail leaves out Trash and Spam, as on Gmail.
    expect(filterCorpusMessagesByAst(rows, parseMailSearchQuery('in:all'))).toEqual([base]);
    expect(filterCorpusMessagesByAst(rows, parseMailSearchQuery('-in:trash'))).toEqual([base]);
  });
});

describe('tie-safe paging (PAGE-1)', () => {
  const date = (row: { d: number }) => row.d;
  test('a page grows through a same-second group and the watermark skips nothing', () => {
    const rows = [{ d: 5 }, { d: 4 }, { d: 4 }, { d: 4 }, { d: 3 }];
    expect(pageEndsInTie(rows, 2, date)).toBe(true);
    expect(pageThroughTies(rows, 2, date)).toEqual({ page: rows.slice(0, 4), nextBefore: 4 });
    expect(pageThroughTies(rows, 1, date)).toEqual({ page: rows.slice(0, 1), nextBefore: 5 });
    expect(pageThroughTies(rows.slice(0, 4), 2, date)).toEqual({
      page: rows.slice(0, 4),
      nextBefore: undefined,
    });
    expect(pageThroughTies(rows, 10, date)).toEqual({ page: rows, nextBefore: undefined });
    expect(pageThroughTies([{ d: 0 }, { d: 0 }, { d: -1 }], 1, date).nextBefore).toBeUndefined();
  });

  test('pageRecentCorpusThreads returns every thread across same-second boundaries', async () => {
    const SECRET = 'page-ties-secret';
    const previous = process.env.LAB86_CONVEX_INTERNAL_SECRET;
    process.env.LAB86_CONVEX_INTERNAL_SECRET = SECRET;
    try {
      const t = convexTest(schema, {
        '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
        '../convex/mailCorpus.ts': () => import('../convex/mailCorpus'),
        '../convex/albatross.ts': () => import('../convex/albatross'),
      });
      const same = Date.UTC(2026, 8, 1, 12, 0, 0);
      const times = [same + 5000, same, same, same, same, same - 5000];
      await t.mutation(api.mailCorpus.upsertCorpusBatch, {
        internalSecret: SECRET,
        userId: 'u1',
        accountId: 'a1',
        grantId: 'g1',
        provider: 'google',
        threads: [],
        messages: times.map((receivedAt, i) => ({
          providerMessageId: `m${i}`,
          providerThreadId: `t${i}`,
          subject: `S${i}`,
          from: 'x@example.com',
          to: 'me@example.com',
          receivedAt,
          snippet: '',
          searchText: '',
          labels: ['INBOX'],
        })) as never,
      });
      for (const accountId of [undefined, 'a1']) {
        const seen: string[] = [];
        let before: number | undefined;
        for (let guard = 0; guard < 10; guard += 1) {
          const page = await t.query(api.mailCorpus.pageRecentCorpusThreads, {
            internalSecret: SECRET,
            userId: 'u1',
            accountId,
            limit: 2,
            before,
          });
          seen.push(...page.items.map((item: any) => item._id));
          if (page.nextBefore === undefined) break;
          before = page.nextBefore;
        }
        expect([...seen].sort()).toEqual(['t0', 't1', 't2', 't3', 't4', 't5']);
      }
    } finally {
      if (previous === undefined) delete process.env.LAB86_CONVEX_INTERNAL_SECRET;
      else process.env.LAB86_CONVEX_INTERNAL_SECRET = previous;
    }
  });
});
