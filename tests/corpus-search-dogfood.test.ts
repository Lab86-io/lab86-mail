import { afterEach, describe, expect, mock, test } from 'bun:test';
import { toolActivityLine } from '../lib/albatross/teach-ui';
import {
  __setCorpusCountDepsForTest,
  __setCorpusSearchDepsForTest,
  corpusCount,
  corpusSearch,
} from '../lib/tools/corpus';
import { runTool } from './tools/harness';

const meeting = {
  _id: 'indexed-1',
  externalId: 'meeting-1',
  connectionId: 'granola-1',
  server: 'granola',
  kind: 'meeting',
  title: 'PubMed meeting',
  summary: 'Discussed publication blockers.',
  updatedAt: 2000,
};
const mail = { _id: 'thread-1', subject: 'PubMed feedback', from: 'editor@example.test', lastDate: 3000 };
const search = (args = {}) =>
  runTool(corpusSearch.handler, corpusSearch.input.parse({ query: 'subject:pubmed', ...args }));

afterEach(() => {
  __setCorpusSearchDepsForTest();
  __setCorpusCountDepsForTest();
});

describe('mail counts preserve unknown results', () => {
  test('a failed account count cannot become a zero total', async () => {
    __setCorpusCountDepsForTest({
      isConvexConfigured: () => true,
      listNylasAccounts: (async () => [{ accountId: 'broken' }, { accountId: 'working' }]) as any,
      convexQuery: (async (_query: any, args: any) => {
        if (args.accountId === 'broken') throw new Error('private provider detail');
        return { count: 12, approximate: false };
      }) as any,
    });
    await expect(runTool(corpusCount.handler, {})).rejects.toThrow('total is unknown');
  });

  test('unknown accounts are rejected and valid zero counts stay zero', async () => {
    const query = mock(async () => ({ count: 0, approximate: false }));
    __setCorpusCountDepsForTest({
      isConvexConfigured: () => true,
      listNylasAccounts: (async () => [{ accountId: 'owned' }]) as any,
      convexQuery: query as any,
    });
    await expect(runTool(corpusCount.handler, { account: 'foreign' })).rejects.toThrow(
      'No matching connected',
    );
    expect(query).not.toHaveBeenCalled();
    expect(await runTool(corpusCount.handler, { account: 'owned', query: 'publisher' })).toEqual({
      total: 0,
      approximate: false,
      accounts: [{ accountId: 'owned', count: 0, approximate: false }],
    });
    expect(query.mock.calls[0][1]).toMatchObject({ accountId: 'owned', query: 'publisher' });
  });
});

describe('meeting and email research coverage', () => {
  test('Granola-only matches explicitly report zero mail and preserve source identity', async () => {
    __setCorpusSearchDepsForTest({
      listNylasAccounts: (async () => [{ accountId: 'mail-1' }]) as any,
      searchNylasThreads: (async () => ({ items: [] })) as any,
      convexQuery: (async () => [meeting]) as any,
    });
    const result = await search();
    expect(result.sourceCounts).toEqual({ mail: 0, connected: 1 });
    expect(result.errors).toEqual([]);
    expect(result.items[0]).toMatchObject({
      source: 'mcp',
      id: 'indexed-1',
      externalId: 'meeting-1',
      connectionId: 'granola-1',
      summary: meeting.summary,
    });
    expect(
      toolActivityLine('corpus_search', { query: 'subject:pubmed' }, 'output-available', result).text,
    ).toBe('Searched for “subject:pubmed” — 0 mail results, 1 connected result');
  });

  test('mail-only research does not query or substitute connected sources', async () => {
    const connected = mock(async () => [meeting]);
    const mailSearch = mock(async () => ({ items: [mail] }));
    __setCorpusSearchDepsForTest({
      listNylasAccounts: (async () => [{ accountId: 'mail-1' }, { accountId: 'mail-2' }]) as any,
      searchNylasThreads: mailSearch as any,
      convexQuery: connected as any,
    });
    const result = await search({ includeConnectedTools: false, accounts: ['mail-2', 'foreign'] });
    expect(connected).not.toHaveBeenCalled();
    expect(mailSearch).toHaveBeenCalledTimes(1);
    expect(mailSearch.mock.calls[0][0]).toMatchObject({ account: 'mail-2', query: 'subject:pubmed' });
    expect(result.accountsSearched).toEqual(['mail-2']);
    expect(result.sourceCounts).toEqual({ mail: 1, connected: 0 });
  });

  test('failed mailbox searches are not silently converted to an empty successful search', async () => {
    __setCorpusSearchDepsForTest({
      listNylasAccounts: (async () => [{ accountId: 'broken' }, { accountId: 'working' }]) as any,
      searchNylasThreads: (async ({ account }: any) => {
        if (account === 'broken') throw new Error('private provider details');
        return { items: [mail] };
      }) as any,
      convexQuery: (async () => [meeting]) as any,
    });
    const result = await search();
    expect(result.sourceCounts).toEqual({ mail: 1, connected: 1 });
    expect(result.errors).toEqual([
      { source: 'mail', account: 'broken', error: expect.stringContaining('Mail search failed') },
    ]);
    expect(JSON.stringify(result)).not.toContain('private provider details');
    expect(toolActivityLine('corpus_search', {}, 'output-available', result).text).toContain(
      'some searches failed',
    );
  });

  test('an unavailable mailbox is reported as a failure even when Granola returns matches', async () => {
    __setCorpusSearchDepsForTest({
      listNylasAccounts: (async () => [{ accountId: 'removed' }]) as any,
      searchNylasThreads: async () => null,
      convexQuery: (async () => [meeting]) as any,
    });
    const result = await search();
    expect(result.errors[0]).toMatchObject({ source: 'mail', account: 'removed' });
    expect(result.sourceCounts.mail).toBe(0);
  });

  test('connected search failures remain visible alongside successful mail', async () => {
    __setCorpusSearchDepsForTest({
      listNylasAccounts: (async () => [{ accountId: 'mail-1' }]) as any,
      searchNylasThreads: (async () => ({ items: [mail] })) as any,
      convexQuery: async () => {
        throw new Error('unavailable');
      },
    });
    const result = await search();
    expect(result.sourceCounts).toEqual({ mail: 1, connected: 0 });
    expect(result.errors).toEqual([{ source: 'connected', error: 'Connected-source search failed.' }]);
  });

  test('counts reflect the actual bounded results and activity names the requested source', async () => {
    __setCorpusSearchDepsForTest({
      listNylasAccounts: (async () => [{ accountId: 'mail-1' }]) as any,
      searchNylasThreads: (async () => ({ items: [mail] })) as any,
      convexQuery: (async () => [meeting]) as any,
    });
    const result = await search({ max: 1 });
    expect(result.items).toHaveLength(1);
    expect(result.sourceCounts).toEqual({ mail: 1, connected: 0 });
    expect(
      toolActivityLine('mcp_search', { server: 'granola', query: 'pubmed' }, 'output-available', {
        items: [meeting],
      }).text,
    ).toContain('Searched granola');
    expect(
      toolActivityLine('mcp_list_items', { server: 'granola' }, 'output-available', { items: [meeting] })
        .text,
    ).toContain('Loaded recent items from granola');
  });
});
