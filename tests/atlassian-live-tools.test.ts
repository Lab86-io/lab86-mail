import { afterAll, describe, expect, test } from 'bun:test';
import { __setAtlassianToolDepsForTest, atlassianSearch, jiraReadIssue } from '../lib/tools/atlassian';

const rows = [
  { connectionId: 'jira_1', server: 'jira', authKind: 'oauth', status: 'connected', includeInSearch: true },
  { connectionId: 'jira_2', server: 'jira', authKind: 'oauth', status: 'connected', includeInSearch: true },
  {
    connectionId: 'jira_off',
    server: 'jira',
    authKind: 'oauth',
    status: 'connected',
    includeInSearch: false,
  },
  { connectionId: 'jira_gone', server: 'jira', authKind: 'oauth', status: 'disconnected' },
  {
    connectionId: 'jira_token',
    server: 'jira',
    authKind: 'token',
    status: 'connected',
    includeInSearch: true,
  },
  { connectionId: 'slack_1', server: 'slack', authKind: 'oauth', status: 'connected', includeInSearch: true },
] as any[];
const ctx = { userId: 'user_1' } as any;

function tokens(expired: string[] = []) {
  return async (_user: string, connectionId: string) =>
    expired.includes(connectionId)
      ? null
      : ({ row: { serverUrl: 'https://api.atlassian.com' }, token: `token-${connectionId}` } as any);
}

function ticket(key: string, updatedAtSource: number, extra: Record<string, unknown> = {}) {
  return {
    externalId: `jira:cloud-1:${key}`,
    kind: 'ticket',
    title: `${key}: Fix`,
    summary: 'Payments · Bug',
    state: 'In Progress',
    organization: 'acme',
    url: `https://acme.atlassian.net/browse/${key}`,
    updatedAtSource,
    raw: { key },
    searchText: key,
    ...extra,
  };
}

const page = {
  externalId: 'confluence:cloud-1:77',
  kind: 'page',
  title: 'Runbook',
  organization: 'acme',
  url: 'https://acme.atlassian.net/wiki/spaces/ENG/pages/77',
  raw: { id: '77' },
  searchText: 'Runbook',
};

afterAll(() => __setAtlassianToolDepsForTest());

describe('atlassian_search', () => {
  test('searches each connected account live and puts the newest first', async () => {
    const searched: any[] = [];
    __setAtlassianToolDepsForTest({
      listUserConnections: async () => rows,
      getConnectionToken: tokens(),
      searchAtlassianLive: async (input: any) => {
        searched.push(input);
        return input.token === 'token-jira_1'
          ? {
              items: [ticket('PAY-1', 5, { assignedToUser: true }), page] as any,
              sources: [
                { site: 'acme', product: 'jira', ok: true },
                { site: 'acme', product: 'confluence', ok: true },
              ],
            }
          : { items: [ticket('OPS-2', 9)] as any, sources: [{ site: 'beta', product: 'jira', ok: true }] };
      },
    });
    const result = await atlassianSearch.handler({ query: 'refund', limit: 20 } as any, ctx);
    expect(searched.map((input) => input.token)).toEqual(['token-jira_1', 'token-jira_2']);
    expect(searched[0]).toMatchObject({
      baseUrl: 'https://api.atlassian.com',
      query: 'refund',
      jql: undefined,
      cql: undefined,
      product: undefined,
      limit: 20,
    });
    expect(result.items.map((item: any) => item.title)).toEqual(['OPS-2: Fix', 'PAY-1: Fix', 'Runbook']);
    expect(result.items[1]).toEqual({
      server: 'jira',
      product: 'Jira',
      kind: 'ticket',
      connectionId: 'jira_1',
      site: 'acme',
      key: 'PAY-1',
      title: 'PAY-1: Fix',
      summary: 'Payments · Bug',
      state: 'In Progress',
      assignedToUser: true,
      url: 'https://acme.atlassian.net/browse/PAY-1',
      updatedAt: 5,
      updatedAtIso: '1970-01-01T00:00:00.005Z',
    });
    expect(result.items[2]).toMatchObject({
      product: 'Confluence',
      kind: 'page',
      key: null,
      summary: null,
      state: null,
      updatedAtIso: null,
    });
    expect(result.sites).toEqual([
      { connectionId: 'jira_1', site: 'acme', product: 'jira', ok: true },
      { connectionId: 'jira_1', site: 'acme', product: 'confluence', ok: true },
      { connectionId: 'jira_2', site: 'beta', product: 'jira', ok: true },
    ]);
    expect(result.note).toBeUndefined();
  });

  test('passes a JQL, keeps the limit, and reports an account that failed', async () => {
    __setAtlassianToolDepsForTest({
      listUserConnections: async () => rows,
      getConnectionToken: tokens(['jira_2']),
      searchAtlassianLive: async (input: any) => {
        expect(input).toMatchObject({ jql: 'project = PAY', product: 'jira' });
        return {
          items: [ticket('PAY-1', 1), ticket('PAY-2', 2), ticket('PAY-3', 3)] as any,
          sources: [{ site: 'acme', product: 'jira', ok: false, error: 'HTTP 400' }],
        };
      },
    });
    const result = await atlassianSearch.handler(
      { jql: 'project = PAY', product: 'jira', limit: 2 } as any,
      ctx,
    );
    expect(result.items.map((item: any) => item.key)).toEqual(['PAY-3', 'PAY-2']);
    expect(result.sites).toEqual([
      { connectionId: 'jira_1', site: 'acme', product: 'jira', ok: false, error: 'HTTP 400' },
      { connectionId: 'jira_2', ok: false, error: 'Reconnect Atlassian in Settings.' },
    ]);
  });

  test('explains an empty request, no account, and a failed search', async () => {
    __setAtlassianToolDepsForTest({
      listUserConnections: async () => rows,
      getConnectionToken: tokens(),
      searchAtlassianLive: async () => {
        throw new Error('Atlassian is down');
      },
    });
    expect(await atlassianSearch.handler({ query: '  ', limit: 5 } as any, ctx)).toEqual({
      items: [],
      sites: [],
      note: 'Pass query, jql, or cql.',
    });
    const failed = await atlassianSearch.handler({ cql: 'space = ENG', limit: 5 } as any, ctx);
    expect(failed.items).toEqual([]);
    expect(failed.sites[0]).toEqual({ connectionId: 'jira_1', ok: false, error: 'Atlassian is down' });

    __setAtlassianToolDepsForTest({ listUserConnections: async () => rows.slice(2) });
    expect(await atlassianSearch.handler({ query: 'x', limit: 5 } as any, ctx)).toEqual({
      items: [],
      sites: [],
      note: 'No Atlassian account is connected for search. The user can add one in Settings > Connections.',
    });
    await expect(atlassianSearch.handler({ query: 'x' } as any, { userId: null } as any)).rejects.toThrow(
      'Not authenticated.',
    );
  });
});

describe('jira_read_issue', () => {
  const issue = {
    site: 'acme',
    key: 'PAY-3',
    title: 'Refund fails',
    url: 'https://acme.atlassian.net/browse/PAY-3',
    hasAssignee: true,
    assignedToUser: false,
    labels: [],
    subtasks: [],
    description: 'Card refund fails',
    createdAt: 1_000,
    comments: [
      { createdAt: 2_000, fromUser: true, text: 'I can take it' },
      { fromUser: false, text: 'No date' },
    ],
    commentTotal: 2,
  };

  test('reads an issue by key from the first account that has it', async () => {
    const read: any[] = [];
    __setAtlassianToolDepsForTest({
      listUserConnections: async () => rows,
      getConnectionToken: tokens(),
      readJiraIssue: async (input: any) => {
        read.push(input);
        return input.token === 'token-jira_2' ? (issue as any) : null;
      },
    });
    const result = await jiraReadIssue.handler({ key: ' pay-3 ' } as any, ctx);
    expect(read.map((input) => [input.token, input.key, input.siteUrl])).toEqual([
      ['token-jira_1', 'PAY-3', undefined],
      ['token-jira_2', 'PAY-3', undefined],
    ]);
    expect(result).toEqual({
      ok: true,
      issue: {
        ...issue,
        connectionId: 'jira_2',
        createdAtIso: '1970-01-01T00:00:01.000Z',
        updatedAtIso: null,
        comments: [
          {
            createdAt: 2_000,
            fromUser: true,
            text: 'I can take it',
            createdAtIso: '1970-01-01T00:00:02.000Z',
          },
          { fromUser: false, text: 'No date', createdAtIso: null },
        ],
      },
    });
  });

  test('reads an issue link and keeps to one account on request', async () => {
    const read: any[] = [];
    __setAtlassianToolDepsForTest({
      listUserConnections: async () => rows,
      getConnectionToken: tokens(),
      readJiraIssue: async (input: any) => {
        read.push(input);
        return issue as any;
      },
    });
    await jiraReadIssue.handler(
      { url: 'https://acme.atlassian.net/browse/PAY-3?focusedCommentId=1', connectionId: 'jira_2' } as any,
      ctx,
    );
    await jiraReadIssue.handler(
      { url: 'https://acme.atlassian.net/jira/software/projects/PAY/boards/1?selectedIssue=PAY-4' } as any,
      ctx,
    );
    expect(read.map((input) => [input.token, input.key, input.siteUrl])).toEqual([
      ['token-jira_2', 'PAY-3', 'https://acme.atlassian.net'],
      ['token-jira_1', 'PAY-4', 'https://acme.atlassian.net'],
    ]);
  });

  test('explains a bad key, no account, no issue, and a failure', async () => {
    __setAtlassianToolDepsForTest({
      listUserConnections: async () => rows,
      getConnectionToken: tokens(['jira_1']),
      readJiraIssue: async () => null,
    });
    const badKey = { ok: false, error: 'Pass an issue key such as STAT-12, or a Jira issue link.' };
    expect(await jiraReadIssue.handler({} as any, ctx)).toEqual(badKey);
    expect(await jiraReadIssue.handler({ key: 'PAY-3 and more' } as any, ctx)).toEqual(badKey);
    expect(await jiraReadIssue.handler({ url: 'not a link' } as any, ctx)).toEqual(badKey);
    expect(await jiraReadIssue.handler({ url: 'https://acme.atlassian.net/wiki/x' } as any, ctx)).toEqual(
      badKey,
    );
    expect(await jiraReadIssue.handler({ key: 'PAY-3', connectionId: 'jira_9' } as any, ctx)).toEqual({
      ok: false,
      error: 'No connected Atlassian account has that id.',
    });
    // One account needs a new sign-in and the other has no such issue.
    expect(await jiraReadIssue.handler({ key: 'PAY-3' } as any, ctx)).toEqual({
      ok: false,
      error: 'Reconnect Atlassian in Settings.',
    });
    expect(await jiraReadIssue.handler({ key: 'PAY-3', connectionId: 'jira_2' } as any, ctx)).toEqual({
      ok: false,
      error: 'No connected Jira site has the issue PAY-3.',
    });

    __setAtlassianToolDepsForTest({ listUserConnections: async () => [] });
    expect(await jiraReadIssue.handler({ key: 'PAY-3' } as any, ctx)).toEqual({
      ok: false,
      error: 'No Atlassian account is connected for search. The user can add one in Settings > Connections.',
    });
    await expect(jiraReadIssue.handler({ key: 'PAY-3' } as any, { userId: null } as any)).rejects.toThrow(
      'Not authenticated.',
    );
  });
});
