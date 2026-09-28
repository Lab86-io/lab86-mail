import { describe, expect, test } from 'bun:test';
import { createMobileMailThreadsGet } from '../app/api/mobile/v1/mail/threads/route';
import { contactNamesFor, withContactNames } from '../lib/contacts/names';
import { mailThreadSummaryFromCorpus } from '../lib/mobile/v1/mail-reads';

function fakeQuery(names: Array<{ email: string; name: string }>, calls: any[] = []) {
  return (async (_fn: any, args: any) => {
    calls.push(args);
    return { names: names.filter((entry) => args.emails.includes(entry.email)) };
  }) as any;
}

describe('sender names from contacts', () => {
  const items = [
    { _id: 't1', fromAddress: 'ann@acme.com' },
    { _id: 't2', fromAddress: 'Bobby <bob@acme.com>' },
    { _id: 't3', fromAddress: '"cy" <cy@acme.com>' },
    { _id: 't4', fromAddress: 'dee@acme.com' },
  ];

  test('only weak header names get the saved name, with one lookup for the list', async () => {
    const calls: any[] = [];
    const out = await withContactNames(
      'user_1',
      items,
      (item) => item.fromAddress,
      'senderName',
      fakeQuery(
        [
          { email: 'ann@acme.com', name: 'Ann Lee' },
          { email: 'bob@acme.com', name: 'Robert Stone' },
          { email: 'cy@acme.com', name: 'Cy Young' },
        ],
        calls,
      ),
    );
    expect(out.map((item: any) => item.senderName)).toEqual(['Ann Lee', undefined, 'Cy Young', undefined]);
    expect(calls).toEqual([{ userId: 'user_1', emails: ['ann@acme.com', 'cy@acme.com', 'dee@acme.com'] }]);
  });

  test('no user, no weak names, no hits, and a failed lookup leave the list as it is', async () => {
    const strong = [{ fromAddress: 'Ann Lee <ann@acme.com>' }];
    let called = false;
    const spy = (async () => {
      called = true;
      return { names: [] };
    }) as any;
    expect(await withContactNames(null, items, (item) => item.fromAddress, 'senderName', spy)).toBe(items);
    expect(await withContactNames('u', strong, (item) => item.fromAddress, 'senderName', spy)).toBe(strong);
    expect(called).toBe(false);
    expect(await withContactNames('u', items, (item) => item.fromAddress, 'senderName', spy)).toBe(items);
    const failing = (async () => {
      throw new Error('down');
    }) as any;
    expect(await withContactNames('u', items, (item) => item.fromAddress, 'senderName', failing)).toBe(items);
    expect(await contactNamesFor('u', [], spy)).toEqual(new Map());
    expect(await contactNamesFor('u', ['A@b.io'], (async () => null) as any)).toEqual(new Map());
  });

  test('mobile thread summaries carry the saved name in the From header', async () => {
    const summary = mailThreadSummaryFromCorpus({
      _id: 't1',
      account: 'a',
      fromAddress: 'ann@acme.com',
      senderName: 'Ann Lee',
    });
    // Shipped Swift clients reject response keys they do not know, so the name
    // rides in the existing fromHeader field and no new key appears.
    expect(summary.fromHeader).toBe('Ann Lee <ann@acme.com>');
    expect(Object.keys(summary)).not.toContain('senderName');
    expect(
      mailThreadSummaryFromCorpus({
        _id: 't2',
        account: 'a',
        fromAddress: 'bo@x.io',
        senderName: 'Lee, "Bo" <x>',
      }).fromHeader,
    ).toBe('Lee Bo x <bo@x.io>');
    expect(mailThreadSummaryFromCorpus({ _id: 't3', account: 'a', fromAddress: 'cy@x.io' }).fromHeader).toBe(
      'cy@x.io',
    );
    const handler = createMobileMailThreadsGet({
      requireCurrentUser: async () => ({
        userId: 'u',
        email: 'me@x.io',
        name: 'Me',
        source: 'clerk' as const,
      }),
      pageRecent: async () => ({ items: [{ _id: 't1', account: 'a', fromAddress: 'ann@acme.com' }] }),
      pageCategory: async () => ({ items: [] }),
      senderNames: async (_userId, rows) => rows.map((row) => ({ ...row, senderName: 'Ann Lee' })),
    });
    const response = await handler(new Request('https://mail.lab86.io/api/mobile/v1/mail/threads'));
    const body: any = await response.json();
    expect(body.items[0]).toMatchObject({ fromHeader: 'Ann Lee <ann@acme.com>' });
    expect(body.items[0].senderName).toBeUndefined();
  });
});
