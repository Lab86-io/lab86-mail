import { afterEach, describe, expect, test } from 'bun:test';
import './tools/harness';
import type { RecipientSuggestion } from '../lib/contacts/recipients';
import { contactLookup, expandAlias, setContactToolDependenciesForTest } from '../lib/tools/contacts';
import { runTool } from './tools/harness';

const item = (email: string, fields: Partial<RecipientSuggestion> = {}): RecipientSuggestion => ({
  email,
  alternateEmails: [],
  savedContact: false,
  directory: false,
  sources: ['mail'],
  sentCount: 0,
  receivedCount: 0,
  highlights: [],
  score: 1,
  ...fields,
});

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

function wire(items: RecipientSuggestion[]) {
  const calls: any[] = [];
  restore = setContactToolDependenciesForTest({
    suggest: async (userId, input) => {
      calls.push({ userId, ...input });
      return { query: input.query, items };
    },
    resolveAccount: (async (_userId: string, ref: string) =>
      ref === 'work@lab86.io' ? ({ accountId: 'acct_work' } as any) : null) as any,
  });
  return calls;
}

describe('contact_lookup', () => {
  test('returns small ranked rows with the source and ranks the named mailbox first', async () => {
    const calls = wire([
      item('ann@acme.com', {
        name: 'Ann Lee',
        savedContact: true,
        sources: ['addressBook', 'mail'],
        alternateEmails: ['ann@home.example', 'a@b.io', 'c@d.io', 'e@f.io'],
        company: 'Acme',
        jobTitle: 'Lead',
        lastContactedAt: Date.parse('2026-09-20T00:00:00Z'),
      }),
      item('dir@acme.com', { name: 'Dir', directory: true, sources: ['domain'] }),
      item('inbox@x.io', { sources: ['inbox'] }),
      item('recent@x.io'),
      item('typed@x.io', { sources: ['typed'] }),
    ]);
    const result = await runTool(contactLookup.handler, { account: 'work@lab86.io', query: 'ann', limit: 5 });
    expect(calls[0]).toMatchObject({ query: 'ann', fromAccountId: 'acct_work', limit: 5 });
    expect(result.contacts).toEqual([
      {
        name: 'Ann Lee',
        email: 'ann@acme.com',
        otherEmails: ['ann@home.example', 'a@b.io', 'c@d.io'],
        source: 'address_book',
        company: 'Acme',
        jobTitle: 'Lead',
        lastContactedAt: '2026-09-20T00:00:00.000Z',
      },
      { name: 'Dir', email: 'dir@acme.com', source: 'domain' },
      { email: 'inbox@x.io', source: 'inbox' },
      { email: 'recent@x.io', source: 'recent' },
    ]);
  });

  test('all mailboxes, an unknown mailbox, and no user', async () => {
    const calls = wire([]);
    await runTool(contactLookup.handler, { query: 'x' });
    await runTool(contactLookup.handler, { account: 'nobody@x.io', query: 'x' });
    expect(calls.map((call) => call.fromAccountId)).toEqual([undefined, undefined]);
    expect(await runTool(contactLookup.handler, { query: 'x' }, { userId: null })).toEqual({ contacts: [] });
    expect(calls).toHaveLength(2);
  });
});

describe('expand_alias', () => {
  test('one person gives the address', async () => {
    wire([
      item('ann@acme.com', { name: 'Ann Lee', savedContact: true }),
      item('annika@x.io', { name: 'Annika' }),
    ]);
    expect(await runTool(expandAlias.handler, { alias: 'Ann' })).toEqual({
      email: 'ann@acme.com',
      displayName: 'Ann Lee',
    });
  });

  test('two people give candidates and no address', async () => {
    wire([
      item('ann@acme.com', { name: 'Ann Lee', savedContact: true }),
      item('ann.park@acme.com', { name: 'Ann Park', directory: true }),
    ]);
    const result = await runTool(expandAlias.handler, { account: '__all__', alias: 'ann' });
    expect(result.email).toBeNull();
    expect(result.candidates?.map((entry) => entry.email).sort()).toEqual([
      'ann.park@acme.com',
      'ann@acme.com',
    ]);
  });

  test('no match and no user', async () => {
    wire([]);
    expect(await runTool(expandAlias.handler, { alias: 'zed' })).toEqual({ email: null });
    expect(await runTool(expandAlias.handler, { alias: 'zed' }, { userId: null })).toEqual({ email: null });
  });
});
